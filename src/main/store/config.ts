// src/main/store/config.ts
//
// 配置持久化。
// 使用 electron-store 存储普通字段,但 API Key 用 Electron 的 safeStorage
// 加密后再存(safeStorage 在 Windows 上使用 DPAPI,macOS 使用 Keychain,
// Linux 使用 libsecret)。
//
// electron-store 是动态 import 的 ESM,我们在主进程 commonjs 下用 dynamic import。

import { safeStorage } from 'electron';
import type { LLMConfig, ThemeName } from '../../shared/types';
import { DEFAULT_CONFIG } from '../../shared/presets';
import { loadEnvFallback } from './env-fallback';

export interface StoredConfig {
  llm: Omit<LLMConfig, 'apiKey'>;
  /** 加密后的 base64,没配置过是 "" */
  encryptedApiKey: string;
  theme: ThemeName;
  /** 对话历史持久化版本号,后续迁移用 */
  schemaVersion: number;
}

const SCHEMA_VERSION = 1;

// 把 DEFAULT_CONFIG 里的 apiKey 拆掉 —— StoredConfig.llm 是 Omit<LLMConfig, 'apiKey'>
const { apiKey: _unusedDefaultKey, ...DEFAULT_LLM_WITHOUT_KEY } = DEFAULT_CONFIG;

const DEFAULT_STORED: StoredConfig = {
  llm: DEFAULT_LLM_WITHOUT_KEY,
  encryptedApiKey: '',
  theme: 'light',
  schemaVersion: SCHEMA_VERSION,
};

type StoreInstance = {
  get<K extends keyof StoredConfig>(key: K): StoredConfig[K];
  set<K extends keyof StoredConfig>(key: K, value: StoredConfig[K]): void;
  store: StoredConfig;
};

let storePromise: Promise<StoreInstance> | null = null;

async function getStore(): Promise<StoreInstance> {
  if (!storePromise) {
    storePromise = (async () => {
      // electron-store v8+ 是 ESM
      const { default: Store } = await import('electron-store');
      return new Store<StoredConfig>({
        name: 'sw-copilot-config',
        defaults: DEFAULT_STORED,
      }) as unknown as StoreInstance;
    })();
  }
  return storePromise;
}

/**
 * 加载完整 LLMConfig(含解密后的 apiKey)。
 *
 * 解析优先级:
 *   1. electron-store 里保存的配置(UI 设置过)
 *   2. .env / process.env 的 fallback(开发体验)
 *   3. DEFAULT_CONFIG(无 apiKey)
 */
export async function loadConfig(): Promise<LLMConfig> {
  const store = await getStore();
  const llm = store.get('llm');
  const encryptedApiKey = store.get('encryptedApiKey');
  let apiKey = '';

  if (encryptedApiKey && safeStorage.isEncryptionAvailable()) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(encryptedApiKey, 'base64'));
    } catch {
      // 解密失败(比如在另一台机器上、或 Key 被撤销),静默返回空
      apiKey = '';
    }
  }

  // 如果 electron-store 里没有 apiKey,尝试从 env 读取 fallback
  if (!apiKey) {
    const envFallback = loadEnvFallback();
    if (envFallback) {
      console.info(
        `[SW Copilot] 使用 .env fallback 配置: protocol=${envFallback.protocol}, model=${envFallback.model}`,
      );
      return envFallback;
    }
  }

  return { ...DEFAULT_CONFIG, ...llm, apiKey };
}

/**
 * 保存 LLMConfig。apiKey 会被加密存储;其它字段直接存。
 */
export async function saveConfig(config: LLMConfig): Promise<void> {
  const store = await getStore();
  const { apiKey, ...rest } = config;

  let encryptedApiKey = '';
  if (apiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
    } else {
      // 非常规情况(比如 Linux 上没装 libsecret):降级为明文存储,并在日志里警告。
      // TODO: 考虑在这种情况下拒绝保存,改用内存配置。
      console.warn('safeStorage 不可用,API Key 将以明文存储');
      encryptedApiKey = Buffer.from(apiKey, 'utf8').toString('base64');
    }
  }

  store.set('llm', rest);
  store.set('encryptedApiKey', encryptedApiKey);
}

export async function loadTheme(): Promise<ThemeName> {
  const store = await getStore();
  return store.get('theme') ?? 'light';
}

export async function saveTheme(theme: ThemeName): Promise<void> {
  const store = await getStore();
  store.set('theme', theme);
}
