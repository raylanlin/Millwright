// src/main/store/env-fallback.ts
//
// `.env` environment variables → `LLMConfig` fallback.
//
// When the user has not yet configured an API key in the UI but the `.env` file
// contains variables for one of the supported protocols, the env values are
// used as the default config at startup. Saving the UI config overrides this fallback.
//
// Security: env values only ever live in process memory; they are never written
// back to `electron-store`, so they cannot accidentally leak into the
// `safeStorage`-encrypted store.

import * as fs from 'fs';
import * as path from 'path';
import type { LLMConfig, LLMProtocol } from '../../shared/types';
import { DEFAULT_URLS } from '../../shared/presets';

/**
 * Parse `.env`-style text. Minimal implementation:
 *   - Supports `KEY=VALUE`
 *   - Supports `KEY="VALUE"` / `KEY='VALUE'`
 *   - Ignores blank lines and lines starting with `#`
 *   - Does not support variable interpolation (`${OTHER}`)
 *   - Does not support multi-line heredocs
 *
 * Good enough for the simple format used in `.env.example`; avoids pulling in a `dotenv` dependency.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Trailing-line comment (only on unquoted values) — a `#` only counts as a comment when preceded by a space
    if (!line.slice(eq + 1).trim().startsWith('"') && !line.slice(eq + 1).trim().startsWith("'")) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Build an `LLMConfig` fallback from the given env map. Protocol priority order:
 *   1. `ANTHROPIC_*`
 *   2. `OPENAI_*`   (direct OpenAI)
 *   3. `DEEPSEEK_*`
 *   4. `DASHSCOPE_*` (Alibaba Bailian)
 *   5. `MINIMAX_*`
 *
 * The first protocol that yields a usable `API_KEY` wins. Returns `null` when
 * no key is configured in the env.
 */
export function envToConfig(env: Record<string, string>): LLMConfig | null {
  type Candidate = {
    protocol: LLMProtocol;
    keyVar: string;
    urlVar?: string;
    modelVar?: string;
    defaultURL?: string;
  };

  const candidates: Candidate[] = [
    {
      protocol: 'anthropic',
      keyVar: 'ANTHROPIC_API_KEY',
      modelVar: 'ANTHROPIC_MODEL',
      defaultURL: DEFAULT_URLS.anthropic,
    },
    {
      protocol: 'openai',
      keyVar: 'OPENAI_API_KEY',
      urlVar: 'OPENAI_BASE_URL',
      modelVar: 'OPENAI_MODEL',
      defaultURL: DEFAULT_URLS.openai,
    },
    {
      protocol: 'openai',
      keyVar: 'DEEPSEEK_API_KEY',
      urlVar: 'DEEPSEEK_BASE_URL',
      modelVar: 'DEEPSEEK_MODEL',
      defaultURL: 'https://api.deepseek.com',
    },
    {
      protocol: 'openai',
      keyVar: 'DASHSCOPE_API_KEY',
      urlVar: 'DASHSCOPE_BASE_URL',
      modelVar: 'DASHSCOPE_MODEL',
      defaultURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    {
      protocol: 'openai',
      keyVar: 'MINIMAX_API_KEY',
      urlVar: 'MINIMAX_BASE_URL',
      modelVar: 'MINIMAX_MODEL',
      defaultURL: 'https://api.minimax.chat/v1',
    },
  ];

  for (const c of candidates) {
    const apiKey = env[c.keyVar];
    if (!apiKey) continue;
    const baseURL = (c.urlVar && env[c.urlVar]) || c.defaultURL!;
    const model = (c.modelVar && env[c.modelVar]) || '';
    if (!model) continue; // missing model name → not a valid fallback
    return {
      protocol: c.protocol,
      baseURL,
      apiKey,
      model,
      stream: true,
      temperature: 0.3,
      maxTokens: 4096,
      timeoutMs: 120_000,
    };
  }
  return null;
}

/**
 * Read the `.env` file (if present) and return its parsed contents.
 *
 * Lookup priority order:
 *   1. `process.env` (already populated by Electron when it launches)
 *   2. `.env` under `app.getAppPath()`  (the project root in dev mode)
 *   3. `.env` under `process.cwd()`     (belt-and-suspenders)
 */
export function readEnvFile(): Record<string, string> {
  const merged: Record<string, string> = {};

  const tryRead = (filePath: string) => {
    try {
      if (fs.existsSync(filePath)) {
        const text = fs.readFileSync(filePath, 'utf8');
        Object.assign(merged, parseEnv(text));
      }
    } catch {
      // Ignore permission/IO errors — `.env` fallback must never block startup
    }
  };

  // cwd has lower priority than appPath
  tryRead(path.join(process.cwd(), '.env'));

  // Only attempt `app.getAppPath()` when running inside Electron; skip in test environments
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      tryRead(path.join(app.getAppPath(), '.env'));
    }
  } catch {
    // Not running under Electron (e.g. tests) — ignore
  }

  // Existing `process.env` entries always win over file contents (shell overrides file)
  for (const key of Object.keys(process.env)) {
    if (process.env[key]) merged[key] = process.env[key]!;
  }

  return merged;
}

/**
 * Convenience wrapper: read `.env` + `process.env`, and return an `LLMConfig` fallback (or `null` on failure).
 */
export function loadEnvFallback(): LLMConfig | null {
  return envToConfig(readEnvFile());
}
