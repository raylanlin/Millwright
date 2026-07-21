// src/main/llm/tools-schema.ts
//
// Converts `SW_TOOLS` (metadata for the 26 atomic tools) into the JSON-Schema
// tool definitions expected by model function-calling APIs. This is the key
// bridge for P1: it makes the model "aware" that these tools exist.
//
// - OpenAI-compatible (DeepSeek / Kimi / MiniMax / GPT):
//     { type:'function', function:{ name, description, parameters } }
// - Anthropic:
//     { name, description, input_schema }
//
// The `parameters` entries in `SW_TOOLS` are "field name → human-readable type
// string" (e.g. `'number (mm)'`). We heuristically map them to JSON-Schema types.

import { SW_TOOLS, type SWToolDefinition } from '../../shared/sw-tools';

/** P1 only wires up these tools initially; the full set of 26 will be unlocked once the loop is proven end-to-end. */
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

/** Parse specs like `'number (mm)'` / `'Front | Top | Right'` / `'string (可选)'` (optional) into JSON-Schema properties */
function paramToSchema(name: string, spec: string): {
  schema: { type: string; description?: string; enum?: string[] };
  required: boolean;
} {
  const lower = spec.toLowerCase();
  const optional = lower.includes('可选') || lower.includes('optional');

  // Enum: "a | b | c"
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
