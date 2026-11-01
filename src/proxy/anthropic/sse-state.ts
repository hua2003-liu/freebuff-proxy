/**
 * OpenAI chunk SSE -> Anthropic 事件流的流式状态机.
 *
 * 按块跟踪 start/delta/stop: 文本块先开先关, 工具块随后; 工具调用的
 * arguments 增量原样转发为 input_json_delta. 产出是完整的 Anthropic
 * 事件块(event + data).
 */

/** OpenAI finish_reason -> Anthropic stop_reason 的映射. */
export const STOP_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
}

/** 流式状态机的可变上下文(每请求一份). */
interface SseCtx {
  model: string
  out: string[]
  started: boolean
  nextIdx: number
  textIdx: number
  chars: number
  stopReason: string
  tools: Map<number, { outIdx: number, open: boolean }>
}

/**
 * 生成一个消息 id.
 *
 * @returns {string} msg_ 前缀的随机 id
 */
export function newMsgId(): string {
  return 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 建一份流式状态机上下文.
 *
 * @param {string} model 回显给下游的模型名
 * @returns {SseCtx} 上下文
 */
function mkCtx(model: string): SseCtx {
  return {
    model, out: [], started: false, nextIdx: 0, textIdx: -1, chars: 0,
    stopReason: '', tools: new Map(),
  }
}

/**
 * 追加一个事件块到上下文输出.
 *
 * @param {SseCtx} ctx 状态机上下文
 * @param {string} type 事件类型
 * @param {any} data 事件数据
 * @returns {void} 无返回
 */
function emitEvent(ctx: SseCtx, type: string, data: any): void {
  ctx.out.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * 发出 message_start(仅一次).
 *
 * @param {SseCtx} ctx 状态机上下文
 * @returns {void} 无返回
 */
function ensureStart(ctx: SseCtx): void {
  if (ctx.started) return
  ctx.started = true
  emitEvent(ctx, 'message_start', {
    type: 'message_start',
    message: {
      id: newMsgId(), type: 'message', role: 'assistant', model: ctx.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
}

/**
 * 闭合文本块(若有).
 *
 * @param {SseCtx} ctx 状态机上下文
 * @returns {void} 无返回
 */
function closeTextIfOpen(ctx: SseCtx): void {
  if (ctx.textIdx >= 0) {
    emitEvent(ctx, 'content_block_stop', { type: 'content_block_stop', index: ctx.textIdx })
    ctx.textIdx = -1
  }
}

/**
 * 处理一条文本增量.
 *
 * @param {SseCtx} ctx 状态机上下文
 * @param {string} text 增量文本
 * @returns {void} 无返回
 */
function onText(ctx: SseCtx, text: string): void {
  if (!text) return
  ensureStart(ctx)
  if (ctx.textIdx < 0) {
    ctx.textIdx = ctx.nextIdx++
    emitEvent(ctx, 'content_block_start', {
      type: 'content_block_start', index: ctx.textIdx, content_block: { type: 'text', text: '' },
    })
  }
  ctx.chars += text.length
  emitEvent(ctx, 'content_block_delta', {
    type: 'content_block_delta', index: ctx.textIdx,
    delta: { type: 'text_delta', text },
  })
}

/**
 * 处理一条工具调用增量.
 *
 * @param {SseCtx} ctx 状态机上下文
 * @param {any} tc OpenAI tool_call 增量条目
 * @returns {void} 无返回
 */
function onToolCall(ctx: SseCtx, tc: any): void {
  ensureStart(ctx)
  const idx = Number(tc?.index) || 0
  let entry = ctx.tools.get(idx)
  if (!entry) {
    closeTextIfOpen(ctx)
    entry = { outIdx: ctx.nextIdx++, open: true }
    ctx.tools.set(idx, entry)
    emitEvent(ctx, 'content_block_start', {
      type: 'content_block_start',
      index: entry.outIdx,
      content_block: { type: 'tool_use', id: tc?.id || 'toolu_unknown', name: tc?.function?.name || '' },
    })
  }
  const args = tc?.function?.arguments
  if (typeof args === 'string' && args) {
    ctx.chars += args.length
    emitEvent(ctx, 'content_block_delta', {
      type: 'content_block_delta',
      index: entry.outIdx,
      delta: { type: 'input_json_delta', partial_json: args },
    })
  }
}

/**
 * 喂入一条完整的 SSE data 行.
 *
 * @param {SseCtx} ctx 状态机上下文
 * @param {string} line 形如 data: {...} 的行(不带换行)
 * @returns {string[]} 本次产出的事件块(可为空)
 */
function feedLine(ctx: SseCtx, line: string): string[] {
  ctx.out.length = 0
  const payload = line.trim()
  if (!payload.startsWith('data: ')) return ctx.out
  const body = payload.slice(6).trim()
  if (body === '[DONE]') return ctx.out
  let obj: any
  try {
    obj = JSON.parse(body)
  } catch {
    return ctx.out
  }
  const choice = obj?.choices?.[0]
  if (choice?.delta?.content) onText(ctx, choice.delta.content)
  if (choice?.finish_reason) ctx.stopReason = choice.finish_reason
  for (const tc of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
    onToolCall(ctx, tc)
  }
  return ctx.out
}

/**
 * 流结束收尾: 闭合未关块, 发 message_delta 与 message_stop.
 *
 * @param {SseCtx} ctx 状态机上下文
 * @returns {string[]} 收尾事件块
 */
function finishStream(ctx: SseCtx): string[] {
  ctx.out.length = 0
  ensureStart(ctx)
  closeTextIfOpen(ctx)
  for (const entry of ctx.tools.values()) {
    if (entry.open) {
      entry.open = false
      emitEvent(ctx, 'content_block_stop', { type: 'content_block_stop', index: entry.outIdx })
    }
  }
  emitEvent(ctx, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: STOP_REASON[ctx.stopReason] || 'end_turn', stop_sequence: null },
    usage: { output_tokens: Math.ceil(ctx.chars / 4) },
  })
  emitEvent(ctx, 'message_stop', { type: 'message_stop' })
  return ctx.out
}

/**
 * 创建流式转换状态机.
 *
 * 消费上游的完整 SSE data 行, 产出 Anthropic 事件块. 用法: 逐行调 feed,
 * 流结束后调 finish 收尾.
 *
 * @param {string} model 回显给下游的模型名
 * @returns {{ feed: (line: string) => string[], finish: () => string[] }} 状态机
 */
export function createAnthropicSseState(model: string) {
  const ctx = mkCtx(model)
  return {
    /**
     * 喂入一条完整的 SSE data 行.
     *
     * @param {string} line 形如 data: {...} 的行(不带换行)
     * @returns {string[]} 本次产出的事件块(可为空)
     */
    feed(line: string): string[] {
      return feedLine(ctx, line)
    },
    /**
     * 流结束收尾.
     *
     * @returns {string[]} 收尾事件块
     */
    finish(): string[] {
      return finishStream(ctx)
    },
  }
}
