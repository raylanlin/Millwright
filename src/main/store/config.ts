// src/main/store/config.ts
//
// Configuration persistence.
// Plain fields are stored via `electron-store`, but the API key is encrypted with
// Electron's `safeStorage` before persistence (`safeStorage` uses DPAPI on Windows,
// Keychain on macOS, and libsecret on Linux).
//
// `electron-store` is dynamically imported as ESM, since the main process runs
// under CommonJS.

import { safeStorage } from 'electron';
import type { LLMConfig, ThemeName } from '../../shared/types';
import { DEFAULT_CONFIG } from '../../shared/presets';
import { loadEnvFallback } from './env-fallback';

export interface StoredConfig {
  llm: Omit<LLMConfig, 'apiKey'>;
  /** Base64 of the encrypted API key; empty string when nothing is configured yet */
  encryptedApiKey: string;
  theme: ThemeName;
  /** Persistence schema version; reserved for future migrations */
  schemaVersion: number;
}

const SCHEMA_VERSION = 1;

// Strip `apiKey` out of DEFAULT_CONFIG — StoredConfig.llm is `Omit<LLMConfig, 'apiKey'>`
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      // `electron-store` v8+ is ESM-only
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
 * Load the full `LLMConfig` (with the decrypted `apiKey`).
 *
 * Resolution priority:
 *   1. Config persisted in `electron-store` (set via the UI).
 *   2. `.env` / `process.env` fallback (developer experience).
 *   3. `DEFAULT_CONFIG` (no API key).
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
      // Decryption failure (e.g. running on a different machine, or the OS key was revoked) — silently return empty
      apiKey = '';
    }
  }

  // If electron-store has no API key, try the env-based fallback
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
 * Save an `LLMConfig`. The API key is encrypted; all other fields are persisted as-is.
 */
export async function saveConfig(config: LLMConfig): Promise<void> {
  const store = await getStore();
  const { apiKey, ...rest } = config;

  let encryptedApiKey = '';
  if (apiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
    } else {
      // Unusual environment (e.g. Linux without libsecret): fall back to plaintext storage and warn in the log.
      // TODO: consider refusing to save in this case and keeping the config in memory instead.
      console.warn('safeStorage unavailable; API key will be stored in plaintext');
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
