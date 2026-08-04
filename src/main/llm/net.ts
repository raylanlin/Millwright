// src/main/llm/net.ts
//
// P106: unified network fetch for the LLM layer.
//
// WHY this exists:
//   The app used the global `fetch` (undici) everywhere. undici does NOT honor
//   the OS system proxy — so on a machine where Clash/VPN is set as the SYSTEM
//   proxy (the normal mode on Windows), the app bypassed the proxy, resolved
//   DNS directly, and died with EAI_AGAIN / ENOTFOUND while the browser worked
//   fine. Chromium's network stack (Electron `net.fetch`) honors system proxy
//   settings, PAC files and Windows registry proxy config out of the box.
//
// Strategy:
//   1. Prefer Electron `net.fetch` (system-proxy aware). Fall back to the
//      global fetch when running outside Electron (tests / pure Node).
//   2. Retry transient DNS/connect failures (EAI_AGAIN, ENOTFOUND,
//      ECONNREFUSED, ECONNRESET, ETIMEDOUT) with backoff — DNS servers hiccup
//      and one retry is usually enough.
//   3. IPv4-first DNS ordering for the fallback path (Node 18+ defaults to
//      "verbatim" order; a broken IPv6 route surfaces as EAI_AGAIN).

import dns from 'node:dns';
import { net } from 'electron';

/** Call once at startup: prefer IPv4 answers for the undici fallback path. */
export function initNetStack(): void {
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    // older Node without the API — non-fatal
  }
}

const TRANSIENT = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/** P108: Chromium network-stack failures carry no Node error `code` — the whole
 *  diagnosis lives in the message (`net::ERR_NAME_NOT_RESOLVED`). Match those
 *  here so net.fetch failures are retried and classified just like undici's. */
const CHROMIUM_TRANSIENT = /net::err_(name_not_resolved|connection_refused|connection_reset|connection_aborted|internet_disconnected|timed_out|address_unreachable|network_changed|network_io_suspended|dns_)/i;

function isTransient(err: unknown): boolean {
  const e = err as any;
  const code: string | undefined = e?.cause?.code ?? e?.code;
  if (code && TRANSIENT.has(code)) return true;
  const msg = String(e?.message ?? '');
  return CHROMIUM_TRANSIENT.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch that respects the OS system proxy (via Electron's Chromium stack) and
 * retries transient network errors. Same signature as global fetch.
 */
export async function llmFetch(
  url: string,
  init: RequestInit = {},
  retries = 2,
): Promise<Response> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Try BOTH stacks every attempt: Chromium (system-proxy aware) first, then
    // undici. P108: the two behave differently — one may resolve where the other
    // fails (proxy config broken vs DNS broken). Never `break` out of the loop
    // on a non-transient Chromium error; fall through so undici still gets a shot.
    let electronFailed = false;
    if (typeof net !== 'undefined' && typeof net.fetch === 'function') {
      try {
        return await net.fetch(url, init as any);
      } catch (err) {
        lastErr = err;
        electronFailed = true;
        if (isTransient(err)) {
          if (attempt < retries) await sleep(400 * (attempt + 1));
          continue; // retry on the same stack
        }
        // Non-transient (cert / abort / etc.) — still try undici below this attempt.
      }
    }

    // Fallback path — global fetch (also the only path outside Electron).
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (isTransient(err)) {
        if (attempt < retries) await sleep(400 * (attempt + 1));
        continue;
      }
      // Both stacks failed non-transiently. If Electron's failure was transient
      // but undici's wasn't, prefer the transient one for a final retry round.
      if (electronFailed && attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}
