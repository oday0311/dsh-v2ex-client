import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { z } from 'zod';
import { V2exError } from './errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_TOKENS = 1024;
const wellFormed = (value: string) => decoder.decode(encoder.encode(value)) === value;

export interface JsonModelRequest<T> {
  system: string;
  userData: string;
  schema: z.ZodType<T>;
  maxInputBytes: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
  tools: [];
  modelRoute?: string;
}

export interface ModelGateway {
  route(): string;
  completeJson<T>(request: JsonModelRequest<T>): Promise<T>;
}

interface ModelSelection { provider: string; model: string }
interface DshModelHost {
  agentDefaultModel?: { currentSelection(): ModelSelection | null | undefined };
  llm?: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> };
}

function selection(value: unknown): ModelSelection {
  if (!value || typeof value !== 'object') throw new V2exError('ai_unavailable');
  const { provider, model } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
    throw new V2exError('ai_unavailable');
  }
  return { provider, model };
}

export class DshModelGateway implements ModelGateway {
  constructor(private readonly host: DshModelHost) {}

  route(): string {
    try {
      const selected = selection(this.host.agentDefaultModel?.currentSelection());
      return JSON.stringify([selected.provider, selected.model]);
    } catch { throw new V2exError('ai_unavailable'); }
  }

  async completeJson<T>(request: JsonModelRequest<T>): Promise<T> {
    if (request.signal?.aborted) throw new V2exError('timeout');
    if (!this.host.llm || !this.host.agentDefaultModel) throw new V2exError('ai_unavailable');
    if (request.tools.length !== 0 || !Number.isSafeInteger(request.maxInputBytes) ||
      request.maxInputBytes < 1 || request.maxInputBytes > MAX_INPUT_BYTES ||
      !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
      request.maxOutputTokens > MAX_OUTPUT_TOKENS ||
      encoder.encode(request.system).byteLength + encoder.encode(request.userData).byteLength > request.maxInputBytes ||
      !wellFormed(request.system) || !wellFormed(request.userData)) {
      throw new V2exError('invalid_request');
    }
    let selected: ModelSelection;
    try {
      selected = request.modelRoute ? (() => {
        const route: unknown = JSON.parse(request.modelRoute);
        if (!Array.isArray(route) || route.length !== 2) throw new Error('route');
        return selection({ provider: route[0], model: route[1] });
      })() : selection(this.host.agentDefaultModel.currentSelection());
    } catch { throw new V2exError('ai_unavailable'); }
    const options: GenerateOptions = {
      provider: selected.provider, model: selected.model, system: request.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: request.userData }] }],
      tools: [], maxTokens: request.maxOutputTokens, signal: request.signal,
    };
    let output = '';
    let finished = false;
    let activeIndex: number | undefined;
    let blockText = '';
    try {
      for await (const chunk of this.host.llm.stream(options)) {
        if (request.signal?.aborted) throw new V2exError('timeout');
        if (finished) throw new V2exError('invalid_response');
        if (chunk.type === 'block-start') {
          if (chunk.blockType !== 'text' || activeIndex !== undefined) throw new V2exError('invalid_response');
          activeIndex = chunk.index; blockText = '';
        } else if (chunk.type === 'text-delta') {
          if (activeIndex !== chunk.index) throw new V2exError('invalid_response');
          blockText += chunk.text;
          output += chunk.text;
          if (encoder.encode(output).byteLength > MAX_OUTPUT_BYTES) throw new V2exError('invalid_response');
        } else if (chunk.type === 'block-end') {
          if (activeIndex !== chunk.index || chunk.block.type !== 'text' || chunk.block.text !== blockText) throw new V2exError('invalid_response');
          activeIndex = undefined;
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'aborted' || request.signal?.aborted) throw new V2exError('timeout');
          if (chunk.reason.kind === 'error') throw new V2exError('ai_unavailable');
          if (chunk.reason.kind !== 'stop' || activeIndex !== undefined) throw new V2exError('invalid_response');
          finished = true;
        } else if (chunk.type !== 'usage') {
          throw new V2exError('invalid_response');
        }
      }
    } catch (error) {
      if (error instanceof V2exError) throw error;
      throw new V2exError(request.signal?.aborted ? 'timeout' : 'ai_unavailable');
    }
    if (!finished || !output.trim() || !wellFormed(output)) throw new V2exError('invalid_response');
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { throw new V2exError('invalid_response'); }
    const result = request.schema.safeParse(parsed);
    if (!result.success) throw new V2exError('invalid_response');
    return result.data;
  }
}
