// src/main/com/sw-sidecar.ts
//
// Long-lived Python sidecar client. Spawns the sidecar via `_bootstrap.py`
// (falling back to `-m sw_agent`) and exchanges line-delimited JSON-RPC over stdio.
//
// P14: launch `_bootstrap.py` by path (embeddable Python's ._pth drops cwd from sys.path).
// P10: cleanup() REJECTS pending start() waiters so a dead sidecar never looks "ready".
// P125 (protocol v2, backward compatible):
//   - every call carries an `op_id` (uuid) → the sidecar dedupes retries (`_duplicate:true`)
//   - errors carry a `code` enum (NO_CONNECTION / NO_DOCUMENT / WRONG_DOC_TYPE / UNKNOWN_TOOL /
//     BAD_ARGS / STALE_STATE / COM_ERROR / TOOL_FAILED) alongside the human `error` string
//   - `health()` is a read-only probe (never triggers a connect); `stateVersion()` reads the
//     sidecar's mutation counter
//   - the ready handshake exposes `protocol` so callers can feature-detect

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { resolvePythonPath, resolveSidecarCwd } from '../python-path';

export type SidecarErrorCode =
  | 'NO_CONNECTION' | 'NO_DOCUMENT' | 'WRONG_DOC_TYPE' | 'UNKNOWN_TOOL'
  | 'BAD_ARGS' | 'STALE_STATE' | 'COM_ERROR' | 'TOOL_FAILED';

export interface SidecarResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
  /** P125: machine-readable error class (undefined on older sidecars) */
  code?: SidecarErrorCode | string;
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

interface Pending {
  resolve: (v: SidecarResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (e: Error) => void;
}

export interface SidecarOptions {
  pythonPath?: string;
  cwd?: string;
  callTimeoutMs?: number;
  onLog?: (line: string) => void;
}

export class SWSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready = false;
  private readyWaiters: ReadyWaiter[] = [];
  private lastStderr: string[] = [];
  /** P125: capabilities announced in the ready handshake */
  private protocol: { op_id?: boolean; state_version?: boolean; codes?: boolean } = {};
  private opts: Required<Omit<SidecarOptions, 'onLog'>> & { onLog?: (l: string) => void };

  constructor(opts: SidecarOptions = {}) {
    this.opts = {
      pythonPath: opts.pythonPath || resolvePythonPath(),
      cwd: opts.cwd || resolveSidecarCwd(),
      callTimeoutMs: opts.callTimeoutMs ?? 60_000,
      onLog: opts.onLog,
    };
  }

  async start(): Promise<void> {
    if (this.proc && this.ready) return;
    if (!this.proc) this.spawnProc();
    await new Promise<void>((resolve, reject) => {
      if (this.ready) return resolve();
      if (!this.proc) return reject(new Error('Python 组件未能启动'));
      const t = setTimeout(() => {
        remove();
        reject(new Error('Python 组件启动超时' + this.stderrTail()));
      }, 10_000);
      const waiter: ReadyWaiter = {
        resolve: () => { clearTimeout(t); resolve(); },
        reject: (e: Error) => { clearTimeout(t); reject(e); },
      };
      const remove = () => {
        const i = this.readyWaiters.indexOf(waiter);
        if (i >= 0) this.readyWaiters.splice(i, 1);
      };
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
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
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
    try {
      msg = JSON.parse(s);
    } catch {
      this.opts.onLog?.(`[sidecar:log] ${s}`);
      return;
    }
    if (msg.id == null && msg.data && msg.data.ready) {
      this.ready = true;
      this.protocol = msg.data.protocol ?? {};
      this.readyWaiters.splice(0).forEach((w) => w.resolve());
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error, code: msg.code });
  }

  private rpc(method: string, params?: any): Promise<SidecarResult> {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.resolve({ ok: false, code: 'NO_CONNECTION', error: 'Python 组件未运行——请安装 Python + pywin32，或忽略此错误（将自动使用内置 VBS 引擎）' });
    }
    const id = this.nextId++;
    return new Promise<SidecarResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: 'COM_ERROR', error: `Python 组件调用超时：${method}` });
      }, this.opts.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n');
    });
  }

  async listTools(includeInternal = false): Promise<any[]> {
    const r = await this.rpc('list_tools');
    if (!r.ok) throw new Error(r.error || 'list_tools failed');
    const tools: any[] = r.data || [];
    return includeInternal ? tools : tools.filter((t) => !t.x_meta?.internal);
  }

  /** Invoke a tool. `opId` defaults to a fresh uuid; pass the SAME id when retrying a
   *  call whose response was lost so the sidecar returns the cached result instead of
   *  re-running the mutation. `expectState` (optional) asks the sidecar to refuse with
   *  STALE_STATE if the document moved on since that state_version. */
  call(name: string, args?: Record<string, any>, opts?: { opId?: string; expectState?: number }): Promise<SidecarResult> {
    const params: any = { name, args: args ?? {} };
    if (this.protocol.op_id !== false) params.op_id = opts?.opId ?? randomUUID();
    if (opts?.expectState != null) params.expect_state = opts.expectState;
    return this.rpc('call', params);
  }

  ping(): Promise<SidecarResult> {
    return this.rpc('ping');
  }

  reconnect(): Promise<SidecarResult> {
    return this.rpc('reconnect');
  }

  /** P125: read-only probe — never triggers a connect. Falls back to ping on old sidecars. */
  async health(): Promise<SidecarResult<SidecarHealth>> {
    const r = await this.rpc('health');
    if (!r.ok && /unknown method/.test(r.error ?? '')) {
      const p = await this.ping();
      return { ok: p.ok, data: { connected: p.ok, state_version: 0, tool_count: 0 } as SidecarHealth, error: p.error };
    }
    return r as SidecarResult<SidecarHealth>;
  }

  async stateVersion(): Promise<number> {
    const r = await this.rpc('state');
    return r.ok ? Number(r.data?.state_version ?? 0) : 0;
  }

  isRunning(): boolean {
    return !!this.proc && this.ready;
  }

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
      p.resolve({ ok: false, code: 'NO_CONNECTION', error: err.message });
    }
    this.pending.clear();
    this.readyWaiters.splice(0).forEach((w) => w.reject(err));
  }
}

let singleton: SWSidecar | null = null;
export function getSidecar(opts?: SidecarOptions): SWSidecar {
  if (!singleton) singleton = new SWSidecar(opts);
  return singleton;
}
