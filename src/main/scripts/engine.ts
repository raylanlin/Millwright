// src/main/scripts/engine.ts
//
// 脚本执行引擎 v3 (P6)。
//
// 关键修复：超时不再产生孤儿进程。
//   旧版用 `exec("chcp 65001 >nul && cscript ...")` 经 cmd 执行，timeout 只杀得掉
//   cmd 外壳，cscript 子进程继续在后台改 SolidWorks 文档 —— UI 报了"超时失败"，
//   脚本却还在跑，用户重试就是双重执行。
//   现在改用 spawn 直接起 cscript/python 拿真实 pid，超时用 `taskkill /T /F`
//   杀整棵进程树；cscript 用 //U 参数输出 UTF-16 到管道，不再需要 chcp。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { ScriptLanguage, ScriptResult } from '../../shared/types';
import { validateScript } from './sanitizer';
import { vbaToVbs, detectRuntimes, checkVbsCompatibility } from './vba-macro-writer';
import type { SolidWorksBridge } from '../com/sw-bridge';
import { writeVBSFile, safeUnlink } from '../com/vbs-writer';

const PYTHON_TIMEOUT_MS = 60_000;
const VBS_TIMEOUT_MS = 60_000;

type Runtime = 'python' | 'cscript';

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
}

/** Kill the entire process tree on Windows (taskkill /T); plain kill elsewhere. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch { /* best effort */ }
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}

/**
 * Run a child process with hard tree-kill on timeout.
 * `encoding` — how to decode the piped stdout/stderr.
 */
function runProcess(
  cmd: string,
  args: string[],
  timeoutMs: number,
  encoding: 'utf8' | 'utf16le',
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(outChunks).toString(encoding).trim(),
        stderr: Buffer.concat(errChunks).toString(encoding).trim(),
        exitCode,
        timedOut,
        spawnError,
      });
    };

    child.stdout.on('data', (d: Buffer) => outChunks.push(d));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d));
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}

export class ScriptEngine {
  private preferredRuntime: Runtime | null = null;
  private runtimeDetected = false;

  constructor(private readonly bridge: SolidWorksBridge) {}

  async detectRuntime(): Promise<Runtime> {
    if (this.runtimeDetected && this.preferredRuntime) return this.preferredRuntime;
    const runtimes = await detectRuntimes();
    if (runtimes.includes('cscript')) {
      this.preferredRuntime = 'cscript';
    } else if (runtimes.includes('python')) {
      this.preferredRuntime = 'python';
    } else {
      this.preferredRuntime = 'cscript';
    }
    this.runtimeDetected = true;
    return this.preferredRuntime;
  }

  getRuntime(): Runtime | null {
    return this.preferredRuntime;
  }

  async run(code: string, language: ScriptLanguage): Promise<ScriptResult> {
    const validation = validateScript(code, language);
    if (!validation.safe) {
      return {
        success: false, output: '',
        error: `安全校验未通过: ${validation.issues.join('; ')}`,
        duration: 0,
      };
    }

    if (language !== 'python') {
      const compat = checkVbsCompatibility(code);
      if (compat.length > 0) {
        return {
          success: false, output: '',
          error: `脚本包含无法在后台执行的 VBA 语法: ${compat.join('; ')}`,
          duration: 0,
        };
      }
    }

    const start = Date.now();
    try {
      if (language === 'python') {
        return await this.runPython(code, start);
      }
      return await this.runVBS(code, start);
    } catch (err) {
      return {
        success: false, output: '',
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
      };
    }
  }

  // ===== VBScript 执行（主路径）=====
  private async runVBS(vbaCode: string, startedAt: number): Promise<ScriptResult> {
    const ts = Date.now();
    const resultPath = path.join(os.tmpdir(), `sw_result_${ts}.json`);

    const vbsCode = vbaToVbs(vbaCode, { resultFilePath: resultPath });
    const scriptPath = writeVBSFile(vbsCode, 'sw_macro');

    const cscriptPath = `${process.env.SYSTEMROOT || 'C:\\Windows'}\\System32\\cscript.exe`;
    // //U: force Unicode (UTF-16LE) stdout on pipes — replaces the old chcp-via-cmd hack
    const out = await runProcess(cscriptPath, ['//NoLogo', '//U', scriptPath], VBS_TIMEOUT_MS, 'utf16le');

    const resultData = readResultFile(resultPath);
    safeUnlink(scriptPath);
    safeUnlink(resultPath);

    if (out.spawnError) {
      return { success: false, output: '', error: out.spawnError, duration: Date.now() - startedAt };
    }
    if (out.timedOut) {
      return {
        success: false,
        output: out.stdout,
        error:
          `脚本执行超时(${VBS_TIMEOUT_MS / 1000}秒)，已强制终止脚本进程。` +
          `可能原因: SolidWorks 正在重建/忙碌、弹出了等待确认的对话框、或操作过于复杂。` +
          `请检查 SolidWorks 当前状态后再重试（注意：超时前脚本可能已部分执行）。`,
        duration: Date.now() - startedAt,
        data: resultData ?? undefined,
      };
    }
    if (out.exitCode !== 0) {
      return {
        success: false,
        output: out.stdout,
        error: resultData && !resultData.success ? resultData.message : out.stderr || `脚本退出码 ${out.exitCode}`,
        duration: Date.now() - startedAt,
        data: resultData ?? undefined,
      };
    }
    if (resultData) {
      const echoOut = out.stdout;
      return {
        success: resultData.success,
        output: echoOut ? `${echoOut}\n${resultData.message || ''}`.trim() : resultData.message || '',
        error: resultData.success ? undefined : resultData.message,
        duration: Date.now() - startedAt,
        data: resultData,
      };
    }
    // 没有结果文件 = 脚本提前退出而未上报，绝不能当作成功
    return {
      success: false,
      output: out.stdout,
      error:
        '脚本未返回执行结果(可能提前退出或被终止)。' +
        (out.stderr ? ` stderr: ${out.stderr}` : '') +
        (out.stdout ? ` 输出: ${out.stdout}` : ''),
      duration: Date.now() - startedAt,
    };
  }

  // ===== Python 执行 =====
  private async runPython(code: string, startedAt: number): Promise<ScriptResult> {
    const ts = Date.now();
    const resultPath = path.join(os.tmpdir(), `sw_result_${ts}.json`);
    const scriptPath = path.join(os.tmpdir(), `sw_script_${ts}.py`);

    const enrichedCode = `import os as __os__\n__result_path__ = r"${resultPath}"\n\n${code}`;
    fs.writeFileSync(scriptPath, enrichedCode, 'utf8');

    // 与 sidecar 一致的解释器解析（PATH 里的 python / python3）
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const out = await runProcess(pythonCmd, [scriptPath], PYTHON_TIMEOUT_MS, 'utf8');

    const resultData = readResultFile(resultPath);
    safeUnlink(scriptPath);
    safeUnlink(resultPath);

    if (out.spawnError) {
      return { success: false, output: '', error: `Python 启动失败: ${out.spawnError}`, duration: Date.now() - startedAt };
    }
    if (out.timedOut) {
      return {
        success: false, output: out.stdout,
        error: `Python 脚本执行超时(${PYTHON_TIMEOUT_MS / 1000}秒)，进程树已终止。`,
        duration: Date.now() - startedAt, data: resultData ?? undefined,
      };
    }
    if (out.exitCode !== 0) {
      return {
        success: false, output: out.stdout,
        error: resultData?.message || out.stderr || `退出码 ${out.exitCode}`,
        duration: Date.now() - startedAt, data: resultData ?? undefined,
      };
    }
    return {
      success: resultData?.success ?? true,
      output: resultData?.message || out.stdout || '',
      error: out.stderr || undefined,
      duration: Date.now() - startedAt, data: resultData ?? undefined,
    };
  }
}

function readResultFile(p: string): { success: boolean; message: string } | null {
  try {
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      const text =
        buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
          ? buf.subarray(2).toString('utf16le')
          : buf.toString('utf8');
      return JSON.parse(text);
    }
  } catch { /* ignore */ }
  return null;
}
