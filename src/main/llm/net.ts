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
    // 1) Electron path — Chromium network stack honors system proxy.
    if (typeof net !== 'undefined' && typeof net.fetch === 'function') {
      try {
        return await net.fetch(url, init as any);
      } catch (err) {
        lastErr = err;
        const code = (err as any)?.cause?.code ?? (err as any)?.code;
        if (TRANSIENT.has(code)) {
          if (attempt < retries) await sleep(400 * (attempt + 1));
          continue; // retry on the same stack
        }
        // Non-transient (e.g. cert errors, aborts): still give the undici path
        // one shot — some gateways behave differently under the two stacks.
        break;
      }
    }

    // 2) Fallback path — global fetch (tests / non-Electron).
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      const code = (err as any)?.cause?.code ?? (err as any)?.code;
      if (TRANSIENT.has(code)) {
        if (attempt < retries) await sleep(400 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}
