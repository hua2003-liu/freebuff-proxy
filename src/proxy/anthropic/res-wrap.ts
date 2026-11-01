/**
 * Anthropic 回程的 res 包装器.
 *
 * chat 管线把本包装器当成普通 res 使用: 管线写出的仍是 OpenAI 形态
 * (流式 SSE / 整体 JSON / OpenAI 错误信封), 包装器在写出口实时转成
 * Anthropic 形态再交给底层连接. 头部延迟到首个字节才真正发出, 便于
 * 按最终形态修正 content-type 与 content-length.
 */

import { createAnthropicSseState, openAIToAnthropicJson } from './response.ts'

/** HTTP 状态码 -> Anthropic 错误类型的映射. */
const ERROR_TYPE: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  429: 'rate_limit_error',
  529: 'overloaded_error',
}

/**
 * 回程包装器的有状态实现.
 */
class AnthropicReply {
  /** 底层 ServerResponse. */
  target: any
  /** 回程形态与回显模型名. */
  meta: { stream: boolean, model: string }
  status = 200
  headHeaders: any = null
  headSent = false
  /** 缓冲的非流式/错误体(字符串分段). */
  buffered: string[] = []
  /** 流式状态机(非流式为 null). */
  state: ReturnType<typeof createAnthropicSseState> | null
  /** 流式行缓冲(分片边界可能打在行中间). */
  lineBuf = ''

  /**
   * @param {any} target 底层 ServerResponse
   * @param {{ stream: boolean, model: string }} meta 回程形态与回显模型名
   */
  constructor(target: any, meta: { stream: boolean, model: string }) {
    this.target = target
    this.meta = meta
    this.state = meta.stream ? createAnthropicSseState(meta.model) : null
  }

  /**
   * 延迟发头: 首个字节前才真正 writeHead.
   *
   * @param {any} extra 追加头(content-type / content-length)
   * @returns {void} 无返回
   */
  sendHead(extra: any): void {
    if (this.headSent) return
    this.headSent = true
    this.target.writeHead(this.status, { ...(this.headHeaders || {}), ...(extra || {}) })
  }

  /**
   * 把一条完整的上游 data 行转成事件块并写出(仅流式路径调用).
   *
   * @param {string} line 完整 SSE 行
   * @returns {boolean} 底层 write 的背压返回值
   */
  writeLine(line: string): boolean {
    const blocks = this.state!.feed(line)
    if (blocks.length === 0) return true
    return this.target.write(blocks.join(''))
  }

  /**
   * 管线写体入口: 流式逐行转换, 缓冲模式累积.
   *
   * @param {any} chunk 字符串或 Buffer
   * @returns {boolean} 底层 write 的背压返回值
   */
  write(chunk: any): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (this.status >= 400 || !this.meta.stream) {
      this.buffered.push(text)
      return true
    }
    if (!this.headSent) this.sendHead({})
    this.lineBuf += text
    const parts = this.lineBuf.split('\n')
    this.lineBuf = parts.pop() || ''
    let ok = true
    for (const line of parts) {
      if (line.trim()) ok = this.writeLine(line) && ok
    }
    return ok
  }

  /**
   * 管线收尾入口: 按形态分流收场.
   *
   * @param {any} [chunk] 尾包(可缺省)
   * @returns {void} 无返回
   */
  end(chunk?: any): void {
    if (chunk !== undefined && chunk !== null) this.write(chunk)
    if (this.status >= 400) {
      this.writeBufferedEnd(errorEnvelope(this.buffered.join(''), this.status))
      return
    }
    if (!this.meta.stream) {
      this.writeBufferedEnd(safeConvert(this.buffered.join(''), this.meta.model))
      return
    }
    this.endStream()
  }

  /**
   * 缓冲路径的一次性写出.
   *
   * @param {any} obj 已转换的响应对象(或原文)
   * @returns {void} 无返回
   */
  writeBufferedEnd(obj: any): void {
    const body = typeof obj === 'string' ? obj : JSON.stringify(obj)
    this.sendHead({ 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
    this.target.end(body)
  }

  /**
   * 流式收场: 冲刷行缓冲, 发收尾事件块.
   *
   * @returns {void} 无返回
   */
  endStream(): void {
    if (!this.headSent) this.sendHead({})
    const st = this.state!
    if (this.lineBuf.trim()) this.target.write(st.feed(this.lineBuf).join(''))
    this.target.write(st.finish().join(''))
    this.target.end()
  }

  /**
   * 管线发头入口: 只记录, 延迟发出.
   *
   * @param {number} code HTTP 状态码
   * @param {any} [headers] 响应头
   * @returns {void} 无返回
   */
  writeHead(code: number, headers?: any): void {
    this.status = code
    this.headHeaders = headers
  }
}

/**
 * 创建包装后的 res 对象.
 *
 * 除 writeHead / write / end / headersSent 外, 一切属性与方法透传底层 res
 * (setHeader 的观测头, once('drain') 的背压通知, socket 等).
 *
 * @param {any} target 底层 ServerResponse
 * @param {{ stream: boolean, model: string }} meta 回程形态与回显模型名
 * @returns {any} 包装后的 res(Proxy)
 */
export function createAnthropicReply(target: any, meta: { stream: boolean, model: string }): any {
  const impl = new AnthropicReply(target, meta)
  return new Proxy(target, {
    get(t: any, prop) {
      if (prop === 'writeHead') return impl.writeHead.bind(impl)
      if (prop === 'write') return impl.write.bind(impl)
      if (prop === 'end') return impl.end.bind(impl)
      if (prop === 'headersSent') return impl.headSent || Boolean(t.headersSent)
      const v = Reflect.get(t, prop)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}

/**
 * 非流式体转换, 失败原样返回.
 *
 * @param {string} text 管线写出的完整响应体
 * @param {string} model 回显模型名
 * @returns {any} Anthropic message 对象(转换失败时为原文)
 */
function safeConvert(text: string, model: string): any {
  try {
    const obj = text ? JSON.parse(text) : {}
    return openAIToAnthropicJson(obj, model)
  } catch {
    return text
  }
}

/**
 * 错误体转换: OpenAI 错误信封 -> Anthropic 错误信封.
 *
 * @param {string} text 管线写出的错误体
 * @param {number} code HTTP 状态码
 * @returns {any} { type: 'error', error: { type, message } }
 */
function errorEnvelope(text: string, code: number): any {
  let message = text
  try {
    const obj = JSON.parse(text)
    message = obj?.error?.message || obj?.message || text
  } catch {
    message = text || `upstream error ${code}`
  }
  return {
    type: 'error',
    error: { type: ERROR_TYPE[code] || 'api_error', message },
  }
}
