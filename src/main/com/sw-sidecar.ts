// src/main/com/sw-sidecar.ts
//
// Long-lived Python sidecar client (stdio JSON-RPC). P14 bootstrap, P10 reject-on-death,
// P125 protocol v2 (op_id / code / health), P129 session dir + no bytecode.
//
// P130 — a timeout is NOT a failure:
//   Every COM call runs on the sidecar's single executor thread (P122). A slow job at the
//   head of the queue (a 20-tooth gear, SolidWorks busy loading an add-in, a rebuild) delays
//   everything behind it; meanwhile Node's flat 60 s timer fired and reported COM_ERROR while
//   the sidecar quietly finished the work (the 16:15 gear session: both calls "timed out",
//   the gear was on screen). Now:
//     - per-tool budgets (generators / build_part / exports get minutes, not 60 s)
//     - `progress` frames from the sidecar reset the timer (idle semantics, like the LLM
//       stream in P102): as long as SolidWorks is still working, nothing times out
//     - a real timeout returns code TIMEOUT and is retried ONCE with the SAME op_id — the
//       sidecar's idempotency cache hands back the true result when the job finishes
//     - `inFlight` + `lastStatus` let the UI probe skip the queue while a tool is running
//     - every rpc logs its duration so the next report carries numbers, not guesses
//
// P131 — what P130 left broken:
//     - heartbeats prove PYTHON is alive, not that SolidWorks progresses: a COM call blocked
//       on a modal dialog heartbeated forever and nothing timed out. Each call now also has
//       an absolute cap (3× its budget; sw_status none — the probe must fail fast).
//     - the sidecar reads stdin one request at a time, so a request queued behind a slow
//       call burned its budget before it was even read, timed out, and its retry re-ran the
//       tool. Requests are now sent one at a time; a budget starts when its request is sent.
//     - `onStillRunning` fired only after a timeout that heartbeats prevented — it now fires
//       on every heartbeat. A `signal` lets Stop abandon the wait (code CANCELLED).

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { sessionDir } from '../housekeeping';
import { resolvePythonPath, resolveSidecarCwd } from '../python-path';

export type SidecarErrorCode =
  | 'NO_CONNECTION' | 'NO_DOCUMENT' | 'WRONG_DOC_TYPE' | 'UNKNOWN_TOOL'
  | 'BAD_ARGS' | 'STALE_STATE' | 'COM_ERROR' | 'TOOL_FAILED' | 'TIMEOUT' | 'CANCELLED';

export interface SidecarResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: SidecarErrorCode | string;
  /** P130: wall time of the successful/failed call as seen from Node */
  durationMs?: number;
}

export interface SidecarHealth {
  connected: boolean;
  state_version: number;
  tool_count: number;
  year?: number;
  revision?: string;
  active_document?: string | null;
  dead_connection?: boolean;
  error?: string;
}

export interface CallOptions {
  opId?: string;
  expectState?: number;
  /** Idle budget for this call (ms). Defaults: SLOW_TOOLS table, then callTimeoutMs. */
  timeoutMs?: number;
  /** Fired on every sidecar heartbeat while the call is still running. */
  onStillRunning?: (elapsedMs: number) => void;
  /** P131: abort → resolve CANCELLED at once. The sidecar finishes the job regardless and
   *  caches the outcome under the op_id. */
  signal?: AbortSignal;
}

interface RpcOptions {
  /** Idle budget (ms) — heartbeats reset it. */
  budget?: number;
  /** P131: absolute deadline (ms) that heartbeats do NOT extend. Defaults to `budget`. */
  hardCapMs?: number;
  onProgress?: (elapsedMs: number) => void;
  signal?: AbortSignal;
}

interface Pending {
  resolve: (v: SidecarResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  hardTimer?: ReturnType<typeof setTimeout>;
  budget: number;
  startedAt: number;
  label: string;
  onTimeout: () => void;
  onProgress?: (elapsedMs: number) => void;
}

interface ReadyWaiter { resolve: () => void; reject: (e: Error) => void }

export interface SidecarOptions {
  pythonPath?: string;
  cwd?: string;
  callTimeoutMs?: number;
  onLog?: (line: string) => void;
}

/** P130: idle budget per tool. "Idle" — the sidecar's progress frames reset it. */
const SLOW_TOOLS: Record<string, number> = {
  create_spur_gear: 300_000,
  create_stepped_shaft: 180_000,
  build_part: 600_000,
  cut_face_outline: 120_000,
  check_interference: 180_000,
  diagnose_document: 120_000,
  export_file: 180_000,
  export_stl: 180_000,
  create_drawing_of: 180_000,
  insert_model_dimensions: 120_000,
  open_document: 120_000,
  new_part: 90_000,       // first document after SW start can take a while
  sw_status: 20_000,      // the probe must fail FAST; the UI has lastStatus
};

export class SWSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready = false;
  private readyWaiters: ReadyWaiter[] = [];
  private lastStderr: string[] = [];
  private protocol: { op_id?: boolean; state_version?: boolean; codes?: boolean; progress?: boolean } = {};
  private opts: Required<Omit<SidecarOptions, 'onLog'>> & { onLog?: (l: string) => void };
  /** P130: last successful sw_status payload, served to the UI while a tool runs */
  lastStatus: any = null;
  /** P130: name of the tool currently executing (first in-flight `call`), for the UI */
  runningTool: string | null = null;
  /** P131: requests go out one at a time — the sidecar reads stdin serially anyway */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: SidecarOptions = {}) {
    this.opts = {
      pythonPath: opts.pythonPath || resolvePythonPath(),
      cwd: opts.cwd || resolveSidecarCwd(),
      callTimeoutMs: opts.callTimeoutMs ?? 60_000,
      onLog: opts.onLog,
    };
  }

  get inFlight(): number { return this.pending.size; }

  async start(): Promise<void> {
    if (this.proc && this.ready) return;
    if (!this.proc) this.spawnProc();
    await new Promise<void>((resolve, reject) => {
      if (this.ready) return resolve();
      if (!this.proc) return reject(new Error('Python 组件未能启动'));
      const t = setTimeout(() => { remove(); reject(new Error('Python 组件启动超时' + this.stderrTail())); }, 10_000);
      const waiter: ReadyWaiter = {
        resolve: () => { clearTimeout(t); resolve(); },
        reject: (e: Error) => { clearTimeout(t); reject(e); },
      };
      const remove = () => { const i = this.readyWaiters.indexOf(waiter); if (i >= 0) this.readyWaiters.splice(i, 1); };
      this.readyWaiters.push(waiter);
    });
  }

  private spawnProc(): void {
    this.lastStderr = [];
    const bootstrap = path.join(this.opts.cwd, '_bootstrap.py');
    const args = fs.existsSync(bootstrap) ? [bootstrap] : ['-m', 'sw_agent'];
    const proc = spawn(this.opts.pythonPath, args, {
      cwd: this.opts.cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', SW_AGENT_SESSION_DIR: sessionDir() },
    });
    this.proc = proc;
    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (b) => {
      const s = String(b);
      this.opts.onLog?.(`[sidecar:err] ${s}`);
      this.lastStderr.push(s);
      if (this.lastStderr.length > 30) this.lastStderr.shift();
    });
    proc.on('exit', (code) => {
      this.opts.onLog?.(`[sidecar] 退出 code=${code}`);
      if (this.proc === proc) this.proc = null;
      this.cleanup(new Error(`Python 组件已退出 (code=${code})${this.stderrTail()}`));
    });
    proc.on('error', (e) => {
      if (this.proc === proc) this.proc = null;
      this.cleanup(new Error(`Python 组件启动失败（未找到 python？）：${e.message}`));
    });
  }

  private stderrTail(): string {
    const tail = this.lastStderr.join('').trim().replace(/\s+/g, ' ').slice(-400);
    return tail ? ` — ${tail}` : '';
  }

  private onLine(line: string): void {
    const s = line.trim();
    if (!s) return;
    let msg: any;
    try { msg = JSON.parse(s); } catch { this.opts.onLog?.(`[sidecar:log] ${s}`); return; }
    if (msg.id == null && msg.data && msg.data.ready) {
      this.ready = true;
      this.protocol = msg.data.protocol ?? {};
      this.readyWaiters.splice(0).forEach((w) => w.resolve());
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    // P130: progress frame — SolidWorks is still working on this call; push the deadline out
    if (msg.progress) {
      clearTimeout(p.timer);
      p.timer = setTimeout(p.onTimeout, p.budget);
      const elapsed = Date.now() - p.startedAt;
      this.opts.onLog?.(`[sidecar] ${p.label} still running (${Math.round(elapsed / 1000)}s)`);
      try { p.onProgress?.(elapsed); } catch { /* a UI callback must never break the RPC */ }
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    clearTimeout(p.hardTimer);
    this.updateRunning();
    const durationMs = Date.now() - p.startedAt;
    this.opts.onLog?.(`[sidecar] ${p.label} ${durationMs}ms ok=${!!msg.ok}${msg.code ? ' code=' + msg.code : ''}`);
    p.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error, code: msg.code, durationMs });
  }

  private updateRunning(): void {
    // sw_status is the UI's own probe — never report it as "a tool is running"
    const first = [...this.pending.values()].find((p) => p.label.startsWith('call:') && p.label !== 'call:sw_status');
    this.runningTool = first ? first.label.slice(5) : null;
  }

  /** P131: queue behind whatever is outstanding; resolve CANCELLED as soon as `signal`
   *  aborts (a request not yet sent is then never sent). */
  private rpc(method: string, params?: any, o: RpcOptions = {}): Promise<SidecarResult> {
    return new Promise<SidecarResult>((resolve) => {
      let settled = false;
      const settle = (r: SidecarResult) => {
        if (settled) return;
        settled = true;
        o.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => settle({ ok: false, code: 'CANCELLED', error: '已取消' });
      if (o.signal?.aborted) return onAbort();
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const turn = this.tail.then(() => (settled ? undefined : this.send(method, params, o).then(settle)));
      this.tail = turn.catch(() => undefined);
    });
  }

  private send(method: string, params: any, o: RpcOptions): Promise<SidecarResult> {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.resolve({ ok: false, code: 'NO_CONNECTION', error: 'Python 组件未运行——请安装 Python + pywin32，或忽略此错误（将自动使用内置 VBS 引擎）' });
    }
    const id = this.nextId++;
    const label = method === 'call' ? `call:${params?.name ?? '?'}` : method;
    const b = o.budget ?? this.opts.callTimeoutMs;
    const cap = Math.max(o.hardCapMs ?? b, b);
    return new Promise<SidecarResult>((resolve, reject) => {
      const startedAt = Date.now();
      const onTimeout = () => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        clearTimeout(p.hardTimer);
        this.pending.delete(id);
        this.updateRunning();
        this.opts.onLog?.(`[sidecar] ${label} TIMEOUT after ${Date.now() - startedAt}ms (budget ${b}ms, cap ${cap}ms, pending=${this.pending.size}, running=${this.runningTool ?? '-'})`);
        resolve({ ok: false, code: 'TIMEOUT', error: `Python 组件调用超时：${label}`, durationMs: Date.now() - startedAt });
      };
      const timer = setTimeout(onTimeout, b);
      const hardTimer = cap > b ? setTimeout(onTimeout, cap) : undefined;
      this.pending.set(id, { resolve, reject, timer, hardTimer, budget: b, startedAt, label, onTimeout, onProgress: o.onProgress });
      this.updateRunning();
      this.proc!.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n');
    });
  }

  async listTools(includeInternal = false): Promise<any[]> {
    const r = await this.rpc('list_tools');
    if (!r.ok) throw new Error(r.error || 'list_tools failed');
    const tools: any[] = r.data || [];
    return includeInternal ? tools : tools.filter((t) => !t.x_meta?.internal);
  }

  /** Invoke a tool. A timeout is retried once with the SAME op_id (P125 idempotency cache):
   *  if the sidecar finished the job meanwhile, we get the real result, not a re-run
   *  (P131: failures are cached too, so a half-built generator is never re-run). */
  async call(name: string, args?: Record<string, any>, opts?: CallOptions): Promise<SidecarResult> {
    const opId = opts?.opId ?? randomUUID();
    const params: any = { name, args: args ?? {} };
    if (this.protocol.op_id !== false) params.op_id = opId;
    if (opts?.expectState != null) params.expect_state = opts.expectState;
    const budget = opts?.timeoutMs ?? SLOW_TOOLS[name] ?? this.opts.callTimeoutMs;
    const t0 = Date.now();
    const o: RpcOptions = {
      budget,
      // P131: heartbeats may stretch a call to 3× its budget, never further; the probe not at all
      hardCapMs: name === 'sw_status' ? budget : budget * 3,
      onProgress: opts?.onStillRunning ? () => opts.onStillRunning!(Date.now() - t0) : undefined,
      signal: opts?.signal,
    };
    let r = await this.rpc('call', params, o);
    if (!r.ok && r.code === 'TIMEOUT' && name !== 'sw_status') {
      opts?.onStillRunning?.(Date.now() - t0);
      // same op_id → cached result when the job lands; one more budget, no extension
      r = await this.rpc('call', params, { ...o, hardCapMs: budget });
      if (!r.ok && r.code === 'TIMEOUT') {
        r.error = `工具 ${name} 执行超过 ${Math.round((Date.now() - t0) / 1000)} s 仍未返回。SolidWorks 可能在重建、加载插件或弹出了对话框；`
          + `操作可能已经完成——请先用 list_features 核对，不要重复执行。`;
      }
    }
    if (name === 'sw_status' && r.ok) this.lastStatus = r.data;
    r.durationMs = Date.now() - t0;   // P131: the whole wait, including a follow-up
    return r;
  }

  ping(): Promise<SidecarResult> { return this.rpc('ping', undefined, { budget: 10_000 }); }
  reconnect(): Promise<SidecarResult> { return this.rpc('reconnect', undefined, { budget: 30_000 }); }

  async health(): Promise<SidecarResult<SidecarHealth>> {
    const r = await this.rpc('health', undefined, { budget: 10_000 });
    if (!r.ok && /unknown method/.test(r.error ?? '')) {
      const p = await this.ping();
      return { ok: p.ok, data: { connected: p.ok, state_version: 0, tool_count: 0 } as SidecarHealth, error: p.error };
    }
    return r as SidecarResult<SidecarHealth>;
  }

  async stateVersion(): Promise<number> {
    const r = await this.rpc('state', undefined, { budget: 10_000 });
    return r.ok ? Number(r.data?.state_version ?? 0) : 0;
  }

  isRunning(): boolean { return !!this.proc && this.ready; }

  stop(): void {
    this.cleanup(new Error('主动停止'));
    this.proc?.kill();
    this.proc = null;
  }

  private cleanup(err: Error): void {
    this.ready = false;
    this.rl?.close();
    this.rl = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      clearTimeout(p.hardTimer);
      p.resolve({ ok: false, code: 'NO_CONNECTION', error: err.message });
    }
    this.pending.clear();
    this.runningTool = null;
    this.readyWaiters.splice(0).forEach((w) => w.reject(err));
  }
}

let singleton: SWSidecar | null = null;
export function getSidecar(opts?: SidecarOptions): SWSidecar {
  if (!singleton) singleton = new SWSidecar(opts);
  return singleton;
}
