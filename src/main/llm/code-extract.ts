// src/main/llm/code-extract.ts

import type { ScriptLanguage } from '../../shared/types';

export interface ExtractedCode {
  code: string;
  language: ScriptLanguage;
  /** 代码块在原文中的起始偏移,用于渲染分段 */
  start: number;
  end: number;
}

/**
 * 匹配 ```lang\n...\n``` 风格代码块。
 * 支持的语言标签:
 *   - VBA:  vba, visualbasic, vb, basic
 *   - Py:   python, py, python3
 * 大小写不敏感。
 */
const FENCE_RE = /```([a-zA-Z0-9_+-]+)?\s*\n([\s\S]*?)```/g;

const VBA_LANGS = new Set(['vba', 'visualbasic', 'vb', 'basic']);
const PY_LANGS = new Set(['python', 'py', 'python3']);

/**
 * 从文本中抽取第一段 VBA 或 Python 代码块。
 * 返回 null 表示没找到。
 * 如果有多个代码块,返回第一段(用户通常只执行第一段)。
 */
export function extractFirstCodeBlock(text: string): ExtractedCode | null {
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const rawLang = (match[1] ?? '').toLowerCase().trim();
    const code = match[2].trimEnd();
    if (!code) continue;

    let language: ScriptLanguage | null = null;
    if (VBA_LANGS.has(rawLang)) language = 'vba';
    else if (PY_LANGS.has(rawLang)) language = 'python';
    else if (rawLang === '') {
      // 无语言标签,启发式推断
      language = inferLanguage(code);
    }

    if (language) {
      return {
        code,
        language,
        start: match.index,
        end: match.index + match[0].length,
      };
    }
  }
  return null;
}

/** 抽取所有代码块 */
export function extractAllCodeBlocks(text: string): ExtractedCode[] {
  FENCE_RE.lastIndex = 0;
  const results: ExtractedCode[] = [];
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const rawLang = (match[1] ?? '').toLowerCase().trim();
    const code = match[2].trimEnd();
    if (!code) continue;

    let language: ScriptLanguage | null = null;
    if (VBA_LANGS.has(rawLang)) language = 'vba';
    else if (PY_LANGS.has(rawLang)) language = 'python';
    else if (rawLang === '') language = inferLanguage(code);

    if (language) {
      results.push({
        code,
        language,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return results;
}

/**
 * 没有语言标签时的启发式推断。
 * 非常保守:有一个明确信号就选,否则返回 null(让调用方忽略该代码块)。
 *
 * 检测顺序:先 Python(因为 Python 代码里很可能出现 "SldWorks.Application" 字符串字面量,
 * 会误触 VBA 规则),再 VBA。
 */
function inferLanguage(code: string): ScriptLanguage | null {
  // Python 强信号(优先检测)
  if (/^\s*import\s+win32com/m.test(code)) return 'python';
  if (/^\s*from\s+\w+\s+import\s+/m.test(code)) return 'python';
  if (/\bwin32com\.client\.Dispatch\b/.test(code)) return 'python';
  // Python 较强信号:import + win32com 组合/常见 Python 语法
  if (/^\s*import\s+(os|sys|win32com)\b/m.test(code)) return 'python';

  // VBA 强信号
  if (/\bDim\s+\w+\s+As\s+/i.test(code)) return 'vba';
  if (/\bSub\s+\w+\s*\(/i.test(code) && /\bEnd\s+Sub\b/i.test(code)) return 'vba';
  // 注意:这条规则容易被 Python 代码里的 "SldWorks.Application" 字符串命中,
  //       所以 Python 信号必须在它之前。
  if (/\bSldWorks\.(SldWorks|Application)\b/i.test(code)) return 'vba';

  return null;
}
