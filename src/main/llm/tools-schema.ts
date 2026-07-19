// src/main/llm/tools-schema.ts
//
// 把 SW_TOOLS（26 个原子工具的元数据）转换成大模型 function-calling 需要的
// JSON-Schema 工具定义。这是 P1 的关键桥梁：让模型"知道"这些工具的存在。
//
// - OpenAI 兼容（DeepSeek / Kimi / MiniMax / GPT）: { type:'function', function:{name,description,parameters} }
// - Anthropic: { name, description, input_schema }
//
// SW_TOOLS 里的 parameters 是 "字段名 -> 人类可读类型串"（如 'number (mm)'）。
// 我们把它启发式映射成 JSON-Schema 类型。

import { SW_TOOLS, type SWToolDefinition } from '../../shared/sw-tools';

/** P1 只先接通这几个工具，跑通闭环后再放开全部 26 个 */
export const P1_TOOL_ALLOWLIST = new Set<string>([
  'create_part',
  'create_sketch',
  'draw_rectangle',
  'draw_circle',
  'close_sketch',
  'extrude_feature',
  'cut_extrude',
  'create_fillet',
]);

interface JSONSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required: string[];
}

/** 把 'number (mm)' / 'Front | Top | Right' / 'string (可选)' 解析为 JSON-Schema 属性 */
function paramToSchema(name: string, spec: string): {
  schema: { type: string; description?: string; enum?: string[] };
  required: boolean;
} {
  const lower = spec.toLowerCase();
  const optional = lower.includes('可选') || lower.includes('optional');

  // 枚举: "a | b | c"
  if (spec.includes('|')) {
    const enumVals = spec
      .split('|')
      .map((s) => s.replace(/\(.*?\)/g, '').trim())
      .filter(Boolean);
    return {
      schema: { type: 'string', enum: enumVals, description: spec },
      required: !optional,
    };
  }

  let type = 'string';
  if (lower.startsWith('number')) type = 'number';
  else if (lower.startsWith('bool')) type = 'boolean';

  return { schema: { type, description: spec }, required: !optional };
}

function buildInputSchema(tool: SWToolDefinition): JSONSchema {
  const properties: JSONSchema['properties'] = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(tool.parameters)) {
    const { schema, required: req } = paramToSchema(name, spec);
    properties[name] = schema;
    if (req) required.push(name);
  }
  return { type: 'object', properties, required };
}

export interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: JSONSchema };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

function selectTools(onlyP1: boolean): SWToolDefinition[] {
  return onlyP1 ? SW_TOOLS.filter((t) => P1_TOOL_ALLOWLIST.has(t.name)) : SW_TOOLS;
}

export function buildOpenAITools(onlyP1 = true): OpenAITool[] {
  return selectTools(onlyP1).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: buildInputSchema(t),
    },
  }));
}

export function buildAnthropicTools(onlyP1 = true): AnthropicTool[] {
  return selectTools(onlyP1).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: buildInputSchema(t),
  }));
}
