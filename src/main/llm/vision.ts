// src/main/llm/vision.ts
//
// Visual understanding — client for "image-to-text" against a dedicated vision model.
//
// Use case: when a text-only main model invokes `analyze_view(question)` inside the
// agent loop, Node captures the screen and calls into this module to obtain a
// textual description that is then fed back to the main model.
// `question` is the prompt the **main model itself** wrote — the specific thing it
// wants to understand from the image — and it is reused as the image-to-text prompt.
//
// Uses the OpenAI-compatible multimodal message format (works with MiniMax / Kimi-Vision /
// GLM-4V / Qwen-VL, etc.).

import type { VisionConfig } from '../../shared/types';
import { toLLMError } from './errors';

export interface AnalyzeImageInput {
  question: string;        // Question drafted by the main model = image-to-text prompt
  imageDataUrl: string;    // data:image/png;base64,...
  config: VisionConfig;    // Dedicated vision-model configuration
  signal?: AbortSignal;
}

const CAPTION_SYSTEM =
  '你是 SolidWorks 三维视图分析助手。仔细观察给定的零件/装配体截图，' +
  '针对用户的问题给出准确、具体、结构化的回答：几何形状与主要特征、比例与对称性、' +
  '当前方位、可见的异常或缺陷。只描述你在图中确实看到的，无法判断的点要明确说“看不清/无法确定”，不要臆测。';

export async function analyzeImage(input: AnalyzeImageInput): Promise<string> {
  const { question, imageDataUrl, config, signal } = input;
  const base = config.baseURL.replace(/\/+$/, '');
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: CAPTION_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: question?.trim() || '请详细描述这个零件的当前状态。' },
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
