// src/main/com/sw-sidecar.ts
//
// Long-lived Python sidecar client. Spawns `python -m sw_agent` and exchanges
// line-delimited JSON-RPC over stdio. This is the execution core of the new
// architecture, replacing "spawn cscript + run VBS on every call".
//
// Protocol (one JSON per line):
//   → {"id":N,"method":"list_tools"|"call"|"ping"|"reconnect","params":{...}}
//   ← {"id":N,"ok":true,"data":...} | {"id":N,"ok":false,"error":"..."}
//   On startup the sidecar pushes one handshake message
//     {"id":null,"ok":true,"data":{"ready":true,...}}.

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

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
  private readyWaiters: Array<() => void> = [];
  private opts: Required<Omit<SidecarOptions, 'onLog'>> & { onLog?: (l: string) => void };

  constructor(opts: SidecarOptions = {}) {
    this.opts = {
      pythonPath: opts.pythonPath || (process.platform === 'win32' ? 'python' : 'python3'),
      cwd: opts.cwd || path.join(process.resourcesPath || process.cwd(), 'sidecar'),
      callTimeoutMs: opts.callTimeoutMs ?? 60_000,
      onLog: opts.onLog,
    };
  }

  /** Start the sidecar process and wait for the `ready` handshake. Safe to call repeatedly (returns immediately if already started). */
  async start(): Promise<void> {
    if (this.proc) return;
    const proc = spawn(this.opts.pythonPath, ['-m', 'sw_agent'], {
      cwd: this.opts.cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    this.proc = proc;

    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (b) => this.opts.onLog?.(`[sidecar:err] ${b}`));
    proc.on('exit', (code) => {
      this.opts.onLog?.(`[sidecar] 退出 code=${code}`);
      if (this.proc === proc) this.proc = null; // BUGFIX: allow a future start() to respawn the process (crash self-heal)
      this.cleanup(new Error(`边车进程退出 (code=${code})`));
    });
    proc.on('error', (e) => {
      if (this.proc === proc) this.proc = null;
      this.cleanup(new Error(`边车启动失败：${e.message}`));
    });

    // Wait for the `ready` handshake (10s timeout)
    await new Promise<void>((resolve, reject) => {
      if (this.ready) return resolve();
      const t = setTimeout(() => reject(new Error('边车握手超时（python / pywin32 未就绪？）')), 10_000);
      this.readyWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
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
      this.readyWaiters.splice(0).forEach((fn) => fn());
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
      return Promise.resolve({ ok: false, error: '边车未运行' });
    }
    const id = this.nextId++;
    return new Promise<SidecarResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `边车调用超时：${method}` });
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
    this.readyWaiters.splice(0).forEach((fn) => fn()); // unblock any pending start() calls
  }
}

let singleton: SWSidecar | null = null;
export function getSidecar(opts?: SidecarOptions): SWSidecar {
  if (!singleton) singleton = new SWSidecar(opts);
  return singleton;
}
