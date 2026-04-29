// src/renderer/hooks/useTheme.ts

import { useCallback, useEffect, useState } from 'react';
import type { ThemeName } from '../../shared/types';
import { THEMES } from '../themes';

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeName>('light');

  useEffect(() => {
    window.api.theme.load().then((t) => setThemeState(t));
  }, []);

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    window.api.theme.save(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'light' ? 'dark' : 'light');
  }, [theme, setTheme]);

  return { theme, setTheme, toggle, tokens: THEMES[theme] };
}
