// src/main/com/sw-sidecar.ts
//
// Long-lived Python sidecar client. Spawns the sidecar via `_bootstrap.py`
// (falling back to `-m sw_agent`) and exchanges line-delimited JSON-RPC over stdio.
//
// P14: bundled Python is the *embeddable* distribution, whose `._pth` prevents cwd
// from being added to sys.path — so `python -m sw_agent` raised ModuleNotFoundError
// and the sidecar died before handshake, silently falling back to VBS (no suppress /
// analyze_view). We now launch `_bootstrap.py` by path (it inserts its own dir on
// sys.path, then runpy-runs sw_agent), and surface the real stderr on failure.
//
// P10 fix — "边车未运行" instead of VBS fallback:
//   When the python process failed to spawn (no python) or exited immediately
//   (no pywin32 / missing sidecar dir), cleanup() unblocked the pending start()
//   waiters by RESOLVING them — start() returned success, handlers marked the
//   sidecar ready and skipped the VBS fallback, and the first RPC then failed
//   with "边车未运行" which surfaced as an agent error. The designed fallback
//   never fired. cleanup() now REJECTS pending start() waiters, and start()
//   correctly joins an in-flight handshake instead of returning early.

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { resolvePythonPath, resolveSidecarCwd } from '../python-path';

export interface SidecarResult<T = any> {
  ok: boolean;
  data?: T;
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
  /** Python executable; defaults are inferred from the current platform */
  pythonPath?: string;
  /** Directory that contains the sidecar package (must contain `sw_agent/`); defaults to `resources/sidecar` */
  cwd?: string;
  /** Per-call timeout in milliseconds */
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
  private lastStderr: string[] = [];  // ring buffer of recent stderr, surfaced on failure
  private opts: Required<Omit<SidecarOptions, 'onLog'>> & { onLog?: (l: string) => void };

  constructor(opts: SidecarOptions = {}) {
    this.opts = {
      pythonPath: opts.pythonPath || resolvePythonPath(),
      cwd: opts.cwd || resolveSidecarCwd(),
      callTimeoutMs: opts.callTimeoutMs ?? 60_000,
      onLog: opts.onLog,
    };
  }

  /**
   * Start the sidecar process and wait for the `ready` handshake.
   * Safe to call repeatedly: already-ready → resolves immediately; handshake
   * in flight → joins it; dead/never started → (re)spawns.
   * REJECTS when the process cannot start or dies before the handshake —
   * callers rely on this to decide the VBS fallback.
   */
  async start(): Promise<void> {
    if (this.proc && this.ready) return;
    if (!this.proc) this.spawnProc();
    // Join the (possibly just-started) handshake
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
    // P14: prefer the bootstrap script (embeddable-Python safe); fall back to -m for dev trees without it
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
      if (this.proc === proc) this.proc = null; // allow a future start() to respawn (crash self-heal)
      this.cleanup(new Error(`Python 组件已退出 (code=${code})${this.stderrTail()}`));
    });
    proc.on('error', (e) => {
      if (this.proc === proc) this.proc = null;
      this.cleanup(new Error(`Python 组件启动失败（未找到 python？）：${e.message}`));
    });
  }

  /** Last stderr lines, trimmed to a short tail — makes ModuleNotFoundError etc. visible in the error message. */
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
      this.opts.onLog?.(`[sidecar:log] ${s}`); // treat non-JSON lines as log output
      return;
    }
    // Handshake
    if (msg.id == null && msg.data && msg.data.ready) {
      this.ready = true;
      this.readyWaiters.splice(0).forEach((w) => w.resolve());
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error });
  }

  private rpc(method: string, params?: any): Promise<SidecarResult> {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.resolve({ ok: false, error: 'Python 组件未运行——请安装 Python + pywin32，或忽略此错误（将自动使用内置 VBS 引擎）' });
    }
    const id = this.nextId++;
    return new Promise<SidecarResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `Python 组件调用超时：${method}` });
      }, this.opts.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n');
    });
  }

  /** Fetch the tool catalog (OpenAI function schema). Internal tools (e.g. `capture_view`) are filtered out. */
  async listTools(includeInternal = false): Promise<any[]> {
    const r = await this.rpc('list_tools');
    if (!r.ok) throw new Error(r.error || 'list_tools failed');
    const tools: any[] = r.data || [];
    return includeInternal ? tools : tools.filter((t) => !t.x_meta?.internal);
  }

  /** Invoke a tool and return its structured result. */
  call(name: string, args?: Record<string, any>): Promise<SidecarResult> {
    return this.rpc('call', { name, args: args ?? {} });
  }

  ping(): Promise<SidecarResult> {
    return this.rpc('ping');
  }

  reconnect(): Promise<SidecarResult> {
    return this.rpc('reconnect');
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
      p.resolve({ ok: false, error: err.message });
    }
    this.pending.clear();
    // P10: REJECT pending start() calls — a dead sidecar must not look "ready"
    this.readyWaiters.splice(0).forEach((w) => w.reject(err));
  }
}

let singleton: SWSidecar | null = null;
export function getSidecar(opts?: SidecarOptions): SWSidecar {
  if (!singleton) singleton = new SWSidecar(opts);
  return singleton;
}
