import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { z } from 'zod';
import { V2exError } from './errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_TOKENS = 1024;
const wellFormed = (value: string) => decoder.decode(encoder.encode(value)) === value;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const blockIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function validUnicode(value: unknown): boolean {
  const ancestors = new WeakSet<object>();
  const stack: Array<{ value: unknown; leaving: boolean; depth: number }> = [{ value, leaving: false, depth: 0 }];
  let visits = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (typeof item.value === 'string') {
      if (!wellFormed(item.value)) return false;
      continue;
    }
    if (!item.value || typeof item.value !== 'object') continue;
    if (item.leaving) { ancestors.delete(item.value); continue; }
    if (ancestors.has(item.value) || item.depth > 128 || ++visits > 20_000) return false;
    ancestors.add(item.value);
    stack.push({ ...item, leaving: true });
    for (const [key, child] of Object.entries(item.value)) {
      if (!wellFormed(key)) return false;
      stack.push({ value: child, leaving: false, depth: item.depth + 1 });
    }
  }
  return true;
}

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
      if (typeof this.host.llm?.stream !== 'function') throw new V2exError('ai_unavailable');
      const selected = selection(this.host.agentDefaultModel?.currentSelection());
      return JSON.stringify([selected.provider, selected.model]);
    } catch { throw new V2exError('ai_unavailable'); }
  }

  async completeJson<T>(request: JsonModelRequest<T>): Promise<T> {
    if (request.signal?.aborted) throw new V2exError('timeout');
    let llm: DshModelHost['llm'];
    let defaultModel: DshModelHost['agentDefaultModel'];
    try { llm = this.host.llm; defaultModel = this.host.agentDefaultModel; }
    catch { throw new V2exError('ai_unavailable'); }
    if (!llm || !defaultModel || typeof llm.stream !== 'function') throw new V2exError('ai_unavailable');
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
      })() : selection(defaultModel.currentSelection());
    } catch { throw new V2exError('ai_unavailable'); }
    const options: GenerateOptions = {
      provider: selected.provider, model: selected.model, system: request.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: request.userData }] }],
      tools: [], maxTokens: request.maxOutputTokens, signal: request.signal,
    };
    const blocks = new Map<number, { text: string; closed: boolean }>();
    let finished = false;
    let protocolError = false;
    try {
      for await (const raw of llm.stream(options)) {
        try {
          if (request.signal?.aborted) throw new V2exError('timeout');
          if (finished || !record(raw)) throw new V2exError('invalid_response');
          const chunk = raw as Record<string, unknown>;
          if (chunk.type === 'block-start') {
            if (chunk.blockType !== 'text' || !blockIndex(chunk.index) ||
              blocks.has(chunk.index) || blocks.size >= 64) throw new V2exError('invalid_response');
            blocks.set(chunk.index, { text: '', closed: false });
          } else if (chunk.type === 'text-delta') {
            if (!blockIndex(chunk.index) || typeof chunk.text !== 'string') throw new V2exError('invalid_response');
            const block = blocks.get(chunk.index);
            if (!block || block.closed) throw new V2exError('invalid_response');
            block.text += chunk.text;
            if (encoder.encode([...blocks.values()].map(value => value.text).join('')).byteLength > MAX_OUTPUT_BYTES) {
              throw new V2exError('invalid_response');
            }
          } else if (chunk.type === 'block-end') {
            if (!blockIndex(chunk.index) || !record(chunk.block) ||
              chunk.block.type !== 'text' || typeof chunk.block.text !== 'string') {
              throw new V2exError('invalid_response');
            }
            const block = blocks.get(chunk.index);
            if (!block || block.closed || chunk.block.text !== block.text) throw new V2exError('invalid_response');
            block.closed = true;
          } else if (chunk.type === 'finish') {
            if (!record(chunk.reason) || typeof chunk.reason.kind !== 'string') {
              throw new V2exError('invalid_response');
            }
            const reason = chunk.reason;
            if (reason.kind === 'aborted' || reason.kind === 'error') {
              if (!record(reason.failure) || typeof reason.failure.code !== 'string' ||
                typeof reason.failure.message !== 'string') throw new V2exError('invalid_response');
              throw new V2exError(reason.kind === 'aborted' ? 'timeout' : 'ai_unavailable');
            }
            if (reason.kind !== 'stop' || [...blocks.values()].some(block => !block.closed)) {
              throw new V2exError('invalid_response');
            }
            finished = true;
          } else if (chunk.type === 'usage') {
            if (!record(chunk.usage)) throw new V2exError('invalid_response');
          } else {
            throw new V2exError('invalid_response');
          }
        } catch (error) {
          protocolError = true;
          throw error instanceof V2exError ? error : new V2exError('invalid_response');
        }
      }
    } catch (error) {
      if (request.signal?.aborted) throw new V2exError('timeout');
      if (protocolError && error instanceof V2exError) throw error;
      throw new V2exError(request.signal?.aborted ? 'timeout' : 'ai_unavailable');
    }
    if (request.signal?.aborted) throw new V2exError('timeout');
    const output = [...blocks.values()].map(block => block.text).join('');
    if (!finished || !output.trim() || !wellFormed(output) ||
      encoder.encode(output).byteLength > MAX_OUTPUT_BYTES) throw new V2exError('invalid_response');
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { throw new V2exError('invalid_response'); }
    try { if (!validUnicode(parsed)) throw new V2exError('invalid_response'); }
    catch { throw new V2exError('invalid_response'); }
    let result: ReturnType<typeof request.schema.safeParse>;
    try { result = request.schema.safeParse(parsed); }
    catch { throw new V2exError('invalid_response'); }
    if (!result.success) throw new V2exError('invalid_response');
    try { if (!validUnicode(result.data)) throw new V2exError('invalid_response'); }
    catch { throw new V2exError('invalid_response'); }
    return result.data;
  }
}
