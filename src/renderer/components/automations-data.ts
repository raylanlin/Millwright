// src/renderer/components/automations-data.ts
//
// 快捷自动化模板。label / desc / prompt 都做了 i18n：数据里存 key，
// 展示与发送时用 t() 取当前语言文案（prompt 也本地化——英文用户发英文提示词更自然）。

export interface AutomationTemplate {
  icon: string;
  /** i18n key 前缀；实际取 `${key}.label` / `${key}.desc` / `${key}.prompt` */
  key: string;
}

export const AUTOMATIONS: AutomationTemplate[] = [
  { icon: '⚙️', key: 'auto.fillet' },
  { icon: '📐', key: 'auto.exportPdf' },
  { icon: '🔩', key: 'auto.insertStd' },
  { icon: '📦', key: 'auto.rename' },
  { icon: '🔄', key: 'auto.mirror' },
  { icon: '📊', key: 'auto.bom' },
  { icon: '📏', key: 'auto.mass' },
  { icon: '🔍', key: 'auto.interference' },
];
