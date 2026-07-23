// src/renderer/i18n/LocaleContext.tsx
//
// 语言上下文。用法与 useTheme 一致：持久化经 window.api.locale（electron-store）。
//   - <LocaleProvider> 包住 <App/>（见 main.tsx）
//   - const { locale, setLocale } = useLocale();
//   - const t = useT(); t('settings.save') / t('msg.execDone', { ms: 42 })

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { translate, type LocaleName } from './strings';

interface LocaleCtx {
  locale: LocaleName;
  setLocale: (l: LocaleName) => void;
  toggle: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<LocaleCtx | null>(null);

/** P4: 默认语言统一为英文（首次运行、未保存偏好时）。用户在设置中的选择仍然优先。 */
function detectDefault(): LocaleName {
  return 'en';
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleName>(detectDefault());

  useEffect(() => {
    // 已保存的偏好优先；没有则保留 detectDefault()
    window.api.locale?.load?.().then((l) => {
      if (l === 'zh' || l === 'en') setLocaleState(l);
    });
  }, []);

  const setLocale = useCallback((next: LocaleName) => {
    setLocaleState(next);
    window.api.locale?.save?.(next);
  }, []);

  const toggle = useCallback(() => {
    setLocale(locale === 'zh' ? 'en' : 'zh');
  }, [locale, setLocale]);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );

  return <Ctx.Provider value={{ locale, setLocale, toggle, t }}>{children}</Ctx.Provider>;
}

export function useLocale(): LocaleCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useLocale must be used within <LocaleProvider>');
  return c;
}

/** 便捷 hook：只取翻译函数。 */
export function useT() {
  return useLocale().t;
}
