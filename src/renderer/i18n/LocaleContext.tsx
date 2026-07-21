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

/** 默认语言：优先浏览器/系统语言，中文环境用 zh，其余 en。首次运行前的兜底。 */
function detectDefault(): LocaleName {
  const nav = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'en';
  return nav.startsWith('zh') ? 'zh' : 'en';
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
