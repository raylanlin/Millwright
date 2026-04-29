// src/main/store/env-fallback.ts
//
// .env 环境变量 → LLMConfig fallback。
//
// 当用户没在 UI 里配置 API Key,且 .env 里有对应协议的变量时,
// 启动时用 env 值作为默认配置。保存 UI 配置会覆盖这个 fallback。
//
// 安全:env 里的值永远只在进程内存里用,不会写回 electron-store,
// 因此不会意外持久化到 safeStorage 加密的存储里。

import * as fs from 'fs';
import * as path from 'path';
import type { LLMConfig, LLMProtocol } from '../../shared/types';
import { DEFAULT_URLS } from '../../shared/presets';

/**
 * 解析 .env 风格的文本。最小实现:
 *  - 支持 KEY=VALUE
 *  - 支持 KEY="VALUE" / KEY='VALUE'
 *  - 忽略 # 开头的注释行和空行
 *  - 不支持变量插值 ${OTHER}
 *  - 不支持多行 heredoc
 *
 * 够用于 .env.example 里的简单格式,不引入 dotenv 依赖。
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
    // 剥外层引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 行尾注释(只在无引号值时)—— #之前加空格才算注释
    if (!line.slice(eq + 1).trim().startsWith('"') && !line.slice(eq + 1).trim().startsWith("'")) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * 从给定的 env map 构造 LLMConfig fallback。按协议优先级:
 *   1. ANTHROPIC_*
 *   2. OPENAI_*  (直接 OpenAI)
 *   3. DEEPSEEK_*
 *   4. DASHSCOPE_* (阿里百炼)
 *   5. MINIMAX_*
 *
 * 只要第一个拿到 API_KEY 的就用它。返回 null 表示 env 里没配任何 key。
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
    if (!model) continue; // 没 model 也不是有效 fallback
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
 * 读取 .env 文件(如果存在)并返回解析结果。
 *
 * 查找路径优先级:
 *   1. process.env (Electron 启动时已经设置的环境变量)
 *   2. app.getAppPath() 下的 .env  (开发模式下一般是项目根)
 *   3. process.cwd() 下的 .env     (双重保险)
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
      // 忽略权限/IO 错误,.env fallback 永远不应该阻塞启动
    }
  };

  // cwd 优先级低于 appPath
  tryRead(path.join(process.cwd(), '.env'));

  // 只在 Electron 运行时环境下尝试读 app.getAppPath(),测试环境会跳过
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      tryRead(path.join(app.getAppPath(), '.env'));
    }
  } catch {
    // 不在 Electron 下运行(测试等),忽略
  }

  // process.env 里如果已经有同名变量,优先级最高(shell 覆盖文件)
  for (const key of Object.keys(process.env)) {
    if (process.env[key]) merged[key] = process.env[key]!;
  }

  return merged;
}

/**
 * 组合操作:读 .env + process.env → LLMConfig fallback,失败返回 null。
 */
export function loadEnvFallback(): LLMConfig | null {
  return envToConfig(readEnvFile());
}
