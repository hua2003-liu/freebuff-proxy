/**
 * OpenAI 响应 -> Anthropic Messages 响应的回程转换.
 *
 * 两条路径: 非流式整体 JSON 一次转换; 流式经 TransformStream 逐块喂给
 * 状态机(见 ./sse-state.ts), 字节分片边界不打碎事件.
 */

import { createAnthropicSseState } from './sse-state.ts'

export { createAnthropicSseState } from './sse-state.ts'

/**
 * 生成一个消息 id.
 *
 * @returns {string} msg_ 前缀的随机 id
 */
function newMsgId(): string {
  return 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

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
