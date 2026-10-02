// tests/sidecar-client.test.mjs
//
// P131: the Node sidecar client against the REAL sidecar server (sidecar/sw_agent/server.py),
// with a few fake tools registered by a throwaway bootstrap — no SolidWorks needed.
//   - requests go out one at a time; a queued call's budget starts when it is sent
//   - a failed call is never re-run by the same-op_id TIMEOUT follow-up
//   - heartbeats cannot stretch a call past its absolute cap; onStillRunning fires on them
//   - an aborted signal returns CANCELLED at once
//   - after an idle gap, back-to-back requests are all answered (P129 stdin-watchdog stall)
// Skipped when no python3 is on PATH.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return 'electron-stub';
  return origResolve.call(this, req, ...rest);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-sidecar-'));
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: { app: { requestSingleInstanceLock: () => true, on() {}, getPath: () => tmp } } };
const { SWSidecar } = require('../dist/main/main/com/sw-sidecar.js');

const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const SIDECAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sidecar');

fs.writeFileSync(path.join(tmp, '_bootstrap.py'), `
import os, sys, time
os.environ["SW_AGENT_SESSION_LOG"] = "0"
sys.path.insert(0, ${JSON.stringify(SIDECAR)})
from sw_agent import server
from sw_agent.registry import tool
from sw_agent.bridge import SWError

server.HEARTBEAT_S = 0.1
RUNS = {}

def _bump(k):
    RUNS[k] = RUNS.get(k, 0) + 1
    return RUNS[k]

@tool("t_sleep", "sleeps", params={"secs": {"type": "number"}}, category="query", internal=True)
def t_sleep(ctx, secs=0.1):
    time.sleep(secs)
    return {"slept": secs}

@tool("t_fail", "fails after working", params={"secs": {"type": "number"}}, category="query", internal=True)
def t_fail(ctx, secs=0.1):
    n = _bump("fail")
    time.sleep(secs)
    raise SWError(f"half-built, then failed (run {n})")

server.serve()
`);

let sc;
before(async () => {
  if (!PY) return;
  sc = new SWSidecar({ pythonPath: PY, cwd: tmp });
  await sc.start();
});
after(async () => {
  const proc = sc?.proc;   // private in TS, reachable from JS
  sc?.stop();
  // Windows refuses to remove the working directory of a live process (EBUSY), and kill()
  // returns before the process is gone: wait for the exit before cleaning up.
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    await new Promise((r) => { proc.once('exit', r); setTimeout(r, 5000).unref(); });
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`# left ${tmp} behind: ${e.message}`);   // a stray temp dir is not a test failure
  }
});

const opts = { skip: !PY && 'python3 not available' };

test('sidecar: a queued call is not timed out while it waits its turn', opts, async () => {
  const slow = sc.call('t_sleep', { secs: 0.8 }, { timeoutMs: 5000 });
  const queued = sc.call('t_sleep', { secs: 0.05 }, { timeoutMs: 400 });   // < slow's run time
  const [a, b] = await Promise.all([slow, queued]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, `queued call failed: ${b.code} ${b.error}`);
});

test('sidecar: the TIMEOUT follow-up never re-runs a failed call', opts, async () => {
  const r = await sc.call('t_fail', { secs: 0.6 }, { timeoutMs: 300, opId: 'fail-once' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /run 1\)/, 'the follow-up must return the cached failure of run 1');
  const again = await sc.call('t_fail', { secs: 0 }, { timeoutMs: 2000, opId: 'fail-once' });
  assert.match(String(again.error), /run 1\)/);
});

test('sidecar: heartbeats cannot stretch a call past its cap; progress is reported', opts, async () => {
  let beats = 0;
  const t0 = Date.now();
  const r = await sc.call('t_sleep', { secs: 3 }, { timeoutMs: 300, onStillRunning: () => beats++ });
  const took = Date.now() - t0;
  assert.equal(r.code, 'TIMEOUT');
  assert.ok(took < 2500, `took ${took} ms — the 900 ms cap (+300 ms follow-up) was not enforced`);
  assert.ok(beats >= 3, `onStillRunning fired ${beats}×`);
  assert.ok(r.durationMs >= took - 50, 'durationMs covers the follow-up too');
  await sc.call('t_sleep', { secs: 0 }, { timeoutMs: 5000 });   // drain: wait for the 3 s job
});

test('sidecar: an aborted signal returns CANCELLED at once', opts, async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const t0 = Date.now();
  const r = await sc.call('t_sleep', { secs: 1 }, { timeoutMs: 5000, signal: ac.signal });
  assert.equal(r.code, 'CANCELLED');
  assert.ok(Date.now() - t0 < 600);
  const p = await sc.ping();   // queued behind the abandoned job, then answered
  assert.equal(p.ok, true);
});

test('sidecar: back-to-back requests after an idle gap are all answered', opts, async () => {
  await new Promise((r) => setTimeout(r, 2500));   // P129's stdin watchdog peeked every 2 s
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const p = await sc.ping();
    assert.equal(p.ok, true, `ping ${i}: ${p.code}`);
    assert.ok(Date.now() - t0 < 1000, `ping ${i} took ${Date.now() - t0} ms`);
  }
});
