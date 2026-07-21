// src/main/llm/vision.ts
//
// 视觉理解 —— 独立视觉模型的“图生文”客户端。
//
// 用途：主模型（text-only）在 agent 循环中调用 analyze_view(question) 时，
// 由 Node 截屏 → 调用这里 → 得到文字描述 → 回填给主模型。
// question 是主模型**自己写的提问**（它想搞清楚的具体问题），作为 image→text 的 prompt。
//
// 走 OpenAI 兼容的多模态消息格式（MiniMax / Kimi-vision / GLM-4V / Qwen-VL 等均适用）。

import type { VisionConfig } from '../../shared/types';
import { toLLMError } from './errors';

export interface AnalyzeImageInput {
  question: string;        // 主模型自拟的提问 = 图生文 prompt
  imageDataUrl: string;    // data:image/png;base64,...
  config: VisionConfig;    // 独立视觉模型配置
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

/** 把本地图片文件读成 data URL。format 来自 sidecar capture_view 的返回。 */
export async function fileToDataUrl(
  readFileBase64: (p: string) => Promise<string>,
  imagePath: string,
  format: string,
): Promise<string> {
  const mime = format === 'png' ? 'image/png' : format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : 'image/bmp';
  const b64 = await readFileBase64(imagePath);
  return `data:${mime};base64,${b64}`;
}
