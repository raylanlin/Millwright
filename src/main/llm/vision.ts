// src/main/llm/vision.ts (P7: caption prompt is now locale-aware — English default,
// Chinese when the UI locale is zh; the old version always sent Chinese.)

import type { VisionConfig, LocaleName } from '../../shared/types';
import { toLLMError } from './errors';

export interface AnalyzeImageInput {
  question: string;        // Question drafted by the main model = image-to-text prompt
  imageDataUrl: string;    // data:image/png;base64,...
  config: VisionConfig;    // Dedicated vision-model configuration
  signal?: AbortSignal;
  locale?: LocaleName;
}

const CAPTION_SYSTEM: Record<LocaleName, string> = {
  zh:
    '你是 SolidWorks 三维视图分析助手。仔细观察给定的零件/装配体截图，' +
    '针对用户的问题给出准确、具体、结构化的回答：几何形状与主要特征、比例与对称性、' +
    '当前方位、可见的异常或缺陷。只描述你在图中确实看到的，无法判断的点要明确说“看不清/无法确定”，不要臆测。',
  en:
    'You are a SolidWorks 3D-view analysis assistant. Examine the given part/assembly screenshot carefully and ' +
    'answer the question accurately, concretely, and in a structured way: geometry and main features, proportions ' +
    'and symmetry, current orientation, visible anomalies or defects. Describe only what you actually see; when ' +
    'something cannot be determined, say so explicitly — never guess.',
};

export async function analyzeImage(input: AnalyzeImageInput): Promise<string> {
  const { question, imageDataUrl, config, signal } = input;
  const locale: LocaleName = input.locale === 'zh' ? 'zh' : 'en';
  const base = config.baseURL.replace(/\/+$/, '');
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: CAPTION_SYSTEM[locale] },
      {
        role: 'user',
        content: [
          { type: 'text', text: question?.trim() || (locale === 'zh' ? '请详细描述这个零件的当前状态。' : 'Describe the current state of this part in detail.') },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 1024,
    stream: false,
  };
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw toLLMError(err, '视觉模型网络请求失败');
  }
  const text = await res.text();
  if (!res.ok) {
    throw toLLMError(new Error(text), `视觉模型请求失败 (HTTP ${res.status})`);
  }
  try {
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content ?? '（视觉模型无文本返回）';
  } catch {
    return '（视觉模型返回无法解析）';
  }
}

/** Read a local image file and return it as a data URL. The `format` argument comes from `sidecar capture_view`'s return value. */
export async function fileToDataUrl(
  readFileBase64: (p: string) => Promise<string>,
  imagePath: string,
  format: string,
): Promise<string> {
  const mime = format === 'png' ? 'image/png' : format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : 'image/bmp';
  const b64 = await readFileBase64(imagePath);
  return `data:${mime};base64,${b64}`;
}
