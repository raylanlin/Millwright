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
  // P109: our own connect-stage abort (see llmFetch) — a fast local timeout.
  if (msg.includes('connect timeout')) return true;
  return CHROMIUM_TRANSIENT.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * P109: connect-stage short timeout for each fetch attempt.
 *
 * The outer streaming path protects the whole request with an IDLE timeout
 * (120s of silence), which is right for a long-thinking model — but it means a
 * dead DNS / refused connection hangs for 120s before failing. With two stacks
 * and outer retries that compounded into minutes of "waiting for the retry
 * hint". The fetch() promise resolving = response HEADERS arrived; everything
 * after (the SSE body) is the outer idle timeout's job. So a short timeout on
 * just this stage is safe and makes failures fail fast.
 */
async function fetchWithConnectTimeout(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  connectMs = 20_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('connect timeout')), connectMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    // P110: do NOT remove the onAbort listener here — the idle-timeout signal
    // (from withIdleTimeout) must stay connected so it can abort the SSE body
    // stream after headers arrive. The { once: true } option auto-clears it
    // when (if) it fires; the signal's lifecycle is managed by the outer caller.
  }
}

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
    // fails (proxy config broken vs DNS broken). Never `break`/`continue` past
    // undici: even a transient Chromium failure gets the undici shot this attempt.
    // P109: each stack gets a 20s connect-stage cap so failures fail fast.
    let electronFailed = false;
    if (typeof net !== 'undefined' && typeof net.fetch === 'function') {
      try {
        return await fetchWithConnectTimeout(
          (u, i) => net.fetch(u, i as any), url, init, init.signal ?? undefined,
        );
      } catch (err) {
        lastErr = err;
        electronFailed = true;
        // No continue here — fall through so undici still gets a try this attempt.
      }
    }

    // Fallback path — global fetch (also the only path outside Electron).
    try {
      return await fetchWithConnectTimeout(fetch, url, init, init.signal ?? undefined);
    } catch (err) {
      lastErr = err;
      if (isTransient(err) || electronFailed) {
        // Either stack reported a transient failure (or Electron died and undici
        // inherited a transient) → back off and retry the round.
        if (attempt < retries) await sleep(400 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}
