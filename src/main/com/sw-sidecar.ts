// src/main/com/sw-sidecar.ts
//
// 常驻 Python 边车客户端。spawn `python -m sw_agent`，通过 stdio 逐行 JSON-RPC 通信。
// 这是新架构的执行核心：取代“每次起 cscript 跑 VBS”。
//
// 协议（每行一个 JSON）：
//   → {"id":N,"method":"list_tools"|"call"|"ping"|"reconnect","params":{...}}
//   ← {"id":N,"ok":true,"data":...} | {"id":N,"ok":false,"error":"..."}
//   边车启动时先推一条 {"id":null,"ok":true,"data":{"ready":true,...}} 握手。

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
  /** python 可执行文件；默认按平台猜 */
  pythonPath?: string;
  /** sidecar 包所在目录（含 sw_agent/）；默认 resources/sidecar */
  cwd?: string;
  /** 单次调用超时(ms) */
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

  /** 启动边车进程并等待 ready 握手。可重复调用（已启动则直接返回）。 */
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
      if (this.proc === proc) this.proc = null; // BUGFIX: 允许下次 start() 重新拉起（崩溃自愈）
      this.cleanup(new Error(`边车进程退出 (code=${code})`));
    });
    proc.on('error', (e) => {
      if (this.proc === proc) this.proc = null;
      this.cleanup(new Error(`边车启动失败：${e.message}`));
    });

    // 等 ready 握手（10s 超时）
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
      this.opts.onLog?.(`[sidecar:log] ${s}`); // 非 JSON 当日志
      return;
    }
    // 握手
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

  /** 取工具清单（OpenAI function schema）。已过滤 internal 工具（如 capture_view）。 */
  async listTools(includeInternal = false): Promise<any[]> {
    const r = await this.rpc('list_tools');
    if (!r.ok) throw new Error(r.error || 'list_tools 失败');
    const tools: any[] = r.data || [];
    return includeInternal ? tools : tools.filter((t) => !t.x_meta?.internal);
  }

  /** 调用一个工具，返回结构化结果。 */
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
    this.readyWaiters.splice(0).forEach((fn) => fn()); // 解除 start() 的等待
  }
}

let singleton: SWSidecar | null = null;
export function getSidecar(opts?: SidecarOptions): SWSidecar {
  if (!singleton) singleton = new SWSidecar(opts);
  return singleton;
}
