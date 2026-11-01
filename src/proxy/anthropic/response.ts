/**
 * OpenAI 响应 -> Anthropic Messages 响应的回程转换.
 *
 * 两条路径: 非流式整体 JSON 一次转换; 流式经 TransformStream 逐块喂给
 * 状态机(见 ./sse-state.ts), 字节分片边界不打碎事件.
 */

import { createAnthropicSseState, newMsgId } from './sse-state.ts'

export { createAnthropicSseState } from './sse-state.ts'

/**
 * 非流式: 把 OpenAI chat completion 对象转成 Anthropic message 对象.
 *
 * @param {any} obj OpenAI chat.completion 形态对象
 * @param {string} model 回显给下游的模型名(Anthropic 语义里的原请求名)
 * @returns {any} Anthropic Messages 响应体
 */
export function openAIToAnthropicJson(obj: any, model: string): any {
  const choice = obj?.choices?.[0] || {}
  const msg = choice.message || {}
  const content: any[] = []
  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content })
  }
  for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    content.push(toolUseBlock(call))
  }
  return {
    id: newMsgId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReasonOf(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: obj?.usage?.prompt_tokens ?? 0,
      output_tokens: obj?.usage?.completion_tokens ?? 0,
    },
  }
}

/**
 * 聚合上游 OpenAI SSE 响应并转换成 Anthropic message JSON.
 *
 * @param {string} text 完整的上游 SSE 文本
 * @param {string} model 回显给下游的模型名
 * @returns {any | null} Anthropic message; 未解析到数据块时返回 null
 */
export function openAISseToAnthropicJson(text: string, model: string): any | null {
  let id = ''
  let usage: any = null
  let finishReason = ''
  let content = ''
  const toolCalls = new Map<number, any>()
  let found = false

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (!payload || payload === '[DONE]') continue
    let chunk: any
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    found = true
    id = chunk.id || id
    usage = chunk.usage || usage
    const choice = chunk.choices?.[0]
    if (!choice) continue
    finishReason = choice.finish_reason || finishReason
    const delta = choice.delta || {}
    if (typeof delta.content === 'string') content += delta.content
    for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      appendToolCall(toolCalls, part)
    }
  }

  if (!found) return null
  return openAIToAnthropicJson({
    id,
    choices: [{
      message: { role: 'assistant', content: content || null, tool_calls: [...toolCalls.values()] },
      finish_reason: finishReason,
    }],
    usage,
  }, model)
}

/**
 * 累积一个 OpenAI SSE 工具调用分片.
 *
 * @param {Map<number, any>} calls 工具调用索引表
 * @param {any} part 工具调用增量
 * @returns {void} 无返回
 */
function appendToolCall(calls: Map<number, any>, part: any): void {
  const index = Number(part?.index) || 0
  let call = calls.get(index)
  if (!call) {
    call = { id: '', type: 'function', function: { name: '', arguments: '' } }
    calls.set(index, call)
  }
  if (typeof part.id === 'string') call.id += part.id
  if (typeof part.function?.name === 'string') call.function.name += part.function.name
  if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments
}

/**
 * 映射 finish_reason -> stop_reason.
 *
 * @param {string} reason OpenAI finish_reason
 * @returns {string} Anthropic stop_reason(未知值回落 end_turn)
 */
function stopReasonOf(reason: any): string {
  const map: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
  }
  return map[reason || ''] || 'end_turn'
}

/**
 * 把单个 OpenAI tool_call 转成 Anthropic tool_use 块.
 *
 * @param {any} call OpenAI tool_calls 条目
 * @returns {any} tool_use 内容块
 */
function toolUseBlock(call: any): any {
  let input: any = {}
  try {
    input = JSON.parse(call?.function?.arguments || '{}')
  } catch {
    input = {}
  }
  return { type: 'tool_use', id: call?.id || 'toolu_unknown', name: call?.function?.name || '', input }
}

/**
 * 创建字节流形态的转换 TransformStream.
 *
 * 内部按行切分上游字节流(容忍分片边界打在行中间), 逐行喂状态机.
 *
 * @param {string} model 回显给下游的模型名
 * @returns {TransformStream<Uint8Array, Uint8Array>} 转换流
 */
export function createAnthropicSseTransform(model: string): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const state = createAnthropicSseState(model)
  let buf = ''
  return new TransformStream({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true })
      const parts = buf.split('\n')
      buf = parts.pop() || ''
      for (const line of parts) {
        if (!line.trim()) continue
        for (const block of state.feed(line)) controller.enqueue(enc.encode(block))
      }
    },
    flush(controller) {
      if (buf.trim()) {
        for (const block of state.feed(buf)) controller.enqueue(enc.encode(block))
      }
      for (const block of state.finish()) controller.enqueue(enc.encode(block))
    },
  })
}
