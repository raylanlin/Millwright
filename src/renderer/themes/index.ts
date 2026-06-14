// src/renderer/themes/index.ts
//
// 浅色 / 深色主题 token。
// 原型里是内联在 App 里的对象,这里拆到独立文件便于组件按需引入。

import type { ThemeName } from '../../shared/types';

export interface ThemeTokens {
  bg: string;
  sidebar: string;
  sidebarBorder: string;
  card: string;
  cardBorder: string;
  cardAlt: string;
  inputBg: string;
  inputBorder: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  userBubble: string;
  userBubbleText: string;
  aiBubble: string;
  aiBubbleBorder: string;
  codeBg: string;
  codeBorder: string;
  codeText: string;
  toolBg: string;
  toolBorder: string;
  toolText: string;
  btnPrimary: string;
  btnPrimaryText: string;
  btnSecondary: string;
  btnSecondaryText: string;
  btnSecondaryBorder: string;
  statusBarBg: string;
  modalOverlay: string;
  modalBg: string;
  scrollThumb: string;
  scrollHover: string;
  selectBg: string;
  placeholder: string;
  dot: string;
  // 语义状态色(执行结果 / 错误横幅),随主题切换避免深色模式下的浅色碎片
  successBg: string;
  successText: string;
  dangerBg: string;
  dangerText: string;
  dangerBorder: string;
  warnBg: string;
  warnText: string;
  warnBorder: string;
}

export const THEMES: Record<ThemeName, ThemeTokens> = {
  light: {
    bg: '#f3f4f6', sidebar: '#e9eaed', sidebarBorder: '#d4d5d9',
    card: '#ffffff', cardBorder: '#dcdde1', cardAlt: '#f0f0f3',
    inputBg: '#ffffff', inputBorder: '#ccced3',
    text: '#1f2937', textSecondary: '#5f6672', textMuted: '#8b8f98',
    accent: '#8b4545', accentSoft: '#f5ebeb', accentText: '#8b4545',
    userBubble: '#8b4545', userBubbleText: '#ffffff',
    aiBubble: '#ffffff', aiBubbleBorder: '#dcdde1',
    codeBg: '#f5f5f8', codeBorder: '#e0e1e5', codeText: '#2d6a4f',
    toolBg: '#edeef2', toolBorder: '#d4d5d9', toolText: '#4a4e59',
    btnPrimary: '#8b4545', btnPrimaryText: '#ffffff',
    btnSecondary: '#f5ebeb', btnSecondaryText: '#8b4545', btnSecondaryBorder: '#e8d4d4',
    statusBarBg: '#edeef2',
    modalOverlay: 'rgba(100,100,110,0.35)', modalBg: '#ffffff',
    scrollThumb: '#c8c9ce', scrollHover: '#a8a9ae',
    selectBg: '#ffffff', placeholder: '#aeb2ba',
    dot: '#8b4545',
    successBg: '#e8f5ec', successText: '#2d7a4a',
    dangerBg: '#fceaea', dangerText: '#c44040', dangerBorder: '#e57373',
    warnBg: '#fef3c7', warnText: '#92400e', warnBorder: '#f59e0b',
  },
  dark: {
    bg: '#1b1c20', sidebar: '#232428', sidebarBorder: '#313238',
    card: '#27282e', cardBorder: '#37383f', cardAlt: '#222328',
    inputBg: '#1e1f24', inputBorder: '#37383f',
    text: '#d5d6da', textSecondary: '#8e9099', textMuted: '#5e6068',
    accent: '#a05555', accentSoft: '#2e2222', accentText: '#c08a8a',
    userBubble: '#7a3e3e', userBubbleText: '#e8e9ed',
    aiBubble: '#27282e', aiBubbleBorder: '#37383f',
    codeBg: '#1e1f24', codeBorder: '#313238', codeText: '#7ec8a0',
    toolBg: '#2a2b31', toolBorder: '#37383f', toolText: '#9a9ca5',
    btnPrimary: '#a05555', btnPrimaryText: '#e8e9ed',
    btnSecondary: '#2e2222', btnSecondaryText: '#c08a8a', btnSecondaryBorder: '#3a2525',
    statusBarBg: '#222328',
    modalOverlay: 'rgba(0,0,0,0.55)', modalBg: '#27282e',
    scrollThumb: '#3a3b42', scrollHover: '#4a4b52',
    selectBg: '#1e1f24', placeholder: '#4e5058',
    dot: '#a05555',
    successBg: '#1c2e24', successText: '#7ec8a0',
    dangerBg: '#2e1c1c', dangerText: '#e08a8a', dangerBorder: '#5a3a3a',
    warnBg: '#2e2818', warnText: '#d8b878', warnBorder: '#6a5a2a',
  },
};
