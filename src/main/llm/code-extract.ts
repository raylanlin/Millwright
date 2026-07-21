// src/main/llm/code-extract.ts

import type { ScriptLanguage } from '../../shared/types';

export interface ExtractedCode {
  code: string;
  language: ScriptLanguage;
  /** Start offset of the code block in the original text — used for segmented rendering */
  start: number;
  end: number;
}

/**
 * Matches ` ```lang\n...\n``` ` style code blocks.
 * Supported language tags:
 *   - VBA:  vba, visualbasic, vb, basic
 *   - Py:   python, py, python3
 * Case-insensitive.
 */
const FENCE_RE = /```([a-zA-Z0-9_+-]+)?\s*\n([\s\S]*?)```/g;

const VBA_LANGS = new Set(['vba', 'visualbasic', 'vb', 'basic']);
const PY_LANGS = new Set(['python', 'py', 'python3']);

/**
 * Extract the first VBA or Python code block from the text.
 * Returns `null` if none is found.
 * If multiple blocks are present, the first one is returned (users usually only execute the first).
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
      // No language tag → heuristic inference
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

/** Extract every code block */
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
 * Heuristic inference used when no language tag is present.
 * Deliberately conservative: only commit to a language when there's a clear signal,
 * otherwise return `null` so the caller can skip the block entirely.
 *
 * Detection order: Python first, then VBA. (Python source often contains the literal
 * string `"SldWorks.Application"`, which would otherwise trigger the VBA rule.)
 */
function inferLanguage(code: string): ScriptLanguage | null {
  // Python strong signals (checked first)
  if (/^\s*import\s+win32com/m.test(code)) return 'python';
  if (/^\s*from\s+\w+\s+import\s+/m.test(code)) return 'python';
  if (/\bwin32com\.client\.Dispatch\b/.test(code)) return 'python';
  // Python weaker signal: `import` of common stdlib / pywin32 modules
  if (/^\s*import\s+(os|sys|win32com)\b/m.test(code)) return 'python';

  // VBA strong signals
  if (/\bDim\s+\w+\s+As\s+/i.test(code)) return 'vba';
  if (/\bSub\s+\w+\s*\(/i.test(code) && /\bEnd\s+Sub\b/i.test(code)) return 'vba';
  // Note: this rule is easy to false-trigger on the string "SldWorks.Application"
  //       inside Python source — that's why Python signals must be checked first.
  if (/\bSldWorks\.(SldWorks|Application)\b/i.test(code)) return 'vba';

  return null;
}
