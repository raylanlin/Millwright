// src/main/scripts/sanitizer.ts
//
// 脚本安全校验。
// 策略:保守黑名单 + 明确风险项清单,让用户知道为什么被拦。
// 后续可演化为允许列表 + 白名单 API 调用。

import type { ScriptValidation, ScriptLanguage } from '../../shared/types';

interface BlockedPattern {
  pattern: RegExp;
  reason: string;
  /** 适用的语言,不填表示通用 */
  languages?: ScriptLanguage[];
}

const BLOCKED_PATTERNS: BlockedPattern[] = [
  // —— 进程与系统控制 ——
  { pattern: /\b(kill|taskkill|shutdown|logoff)\b/i, reason: '进程终止/系统关闭' },
  { pattern: /\bformat\s+[a-z]:\s*[\\/]?/i, reason: '磁盘格式化' },
  { pattern: /\breg(?:\.exe)?\s+(add|delete|import)\b/i, reason: '注册表修改' },
  { pattern: /\bnet\s+(user|localgroup|accounts)\b/i, reason: '用户账户管理' },
  { pattern: /\bset-executionpolicy\b/i, reason: '修改 PowerShell 执行策略' },

  // —— 文件系统危险操作(VBA) ——
  {
    pattern: /\b(Kill|DeleteFile|RmDir|FileSystemObject\.DeleteFile|FileSystemObject\.DeleteFolder)\s*\(/i,
    reason: 'VBA 文件/目录删除',
    languages: ['vba'],
  },
  {
    pattern: /\bShell\s*\(/i,
    reason: 'VBA Shell 命令执行',
    languages: ['vba'],
  },
  {
    pattern: /\bWScript\.Shell\b/i,
    reason: 'Windows Script Host 命令执行',
    languages: ['vba'],
  },
  {
    pattern: /\bCreateObject\s*\(\s*["']WScript/i,
    reason: '创建 WScript 对象',
    languages: ['vba'],
  },

  // —— 文件系统危险操作(Python) ——
  { pattern: /\bos\.(system|popen|execl?|execvp?|spawnl?)\b/, reason: 'Python 命令执行', languages: ['python'] },
  { pattern: /\bsubprocess\.(call|run|Popen|check_output)\b/, reason: 'subprocess 调用', languages: ['python'] },
  { pattern: /\bshutil\.rmtree\b/, reason: 'shutil 递归删除', languages: ['python'] },
  { pattern: /\bos\.remove\b/, reason: 'os.remove 文件删除', languages: ['python'] },
  { pattern: /\bos\.unlink\b/, reason: 'os.unlink 文件删除', languages: ['python'] },

  // —— 网络请求 ——
  { pattern: /\b(Invoke-WebRequest|Invoke-RestMethod)\b/i, reason: 'PowerShell 网络请求' },
  { pattern: /\b(curl|wget)\s+https?:/i, reason: '命令行下载' },
  {
    pattern: /\bMSXML2\.(XMLHTTP|ServerXMLHTTP)\b/i,
    reason: 'VBA 发起 HTTP 请求',
    languages: ['vba'],
  },
  {
    pattern: /^\s*import\s+(urllib|requests|httpx|aiohttp)\b/m,
    reason: 'Python 网络库',
    languages: ['python'],
  },
];

export function validateScript(code: string, language: ScriptLanguage): ScriptValidation {
  const issues: string[] = [];
  for (const { pattern, reason, languages } of BLOCKED_PATTERNS) {
    if (languages && !languages.includes(language)) continue;
    if (pattern.test(code)) {
      issues.push(reason);
    }
  }
  // 去重
  const uniq = Array.from(new Set(issues));
  return { safe: uniq.length === 0, issues: uniq };
}
