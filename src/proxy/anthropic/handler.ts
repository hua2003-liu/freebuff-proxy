/**
 * /v1/messages 的入口装配.
 *
 * 读体 -> Anthropic 模型名做档位映射 -> 转成 OpenAI 体 -> 合成请求与包装
 * res 交给既有 chat 管线. 管线内部(选号/重试/透传)零感知.
 */

import { anthropicToOpenAI, estimateTokens } from './request.ts'
import { createAnthropicReply } from './res-wrap.ts'
import { readRequestBody, sendJson } from '../../util/http.ts'
import { bodyReadTimeoutMs } from '../config/limits.ts'

/**
 * 解析 Anthropic 模型名: claude-* 按档位映射, 其余原样返回.
 *
 * @param {string} name 下游请求的模型名
 * @param {any} config 合并后的运行配置(含 anthropic 段与 DEFAULTS 兜底)
 * @returns {string} 落到 freebuff 模型口径的名字
 */
export function resolveAnthropicModel(name: string, config: any): string {
  if (!name || !name.startsWith('claude')) return name
  const cfg = config?.anthropic || {}
  const small = typeof cfg.smallModel === 'string' && cfg.smallModel ? cfg.smallModel : ''
  const main = typeof cfg.mainModel === 'string' && cfg.mainModel ? cfg.mainModel : ''
  if (name.includes('haiku')) return small || name
  return main || name
}

/**
 * 处理 POST /v1/messages.
 *
 * @param {any} ctx 依赖集合(config / runtimes / settingsStore)
 * @param {any} req 下游请求
 * @param {any} res 下游响应
 * @param {(req: any, res: any) => Promise<void>} chatHandler 既有 chat 入口
 * @returns {Promise<void>} 处理完成
 */
export async function handleMessages(
  ctx: any, req: any, res: any, chatHandler: (req: any, res: any) => Promise<void>,
): Promise<void> {
  let raw: Buffer
  try {
    raw = await readRequestBody(req, undefined, bodyReadTimeoutMs(ctx))
  } catch (err: any) {
    sendBodyReadError(res, err)
    return
  }
  let anthropicBody: any
  try {
    anthropicBody = JSON.parse(raw.toString('utf8') || '{}')
  } catch {
    sendJson(res, 400, errorBody('Invalid JSON body', 'invalid_request_error'))
    return
  }
  const converted = anthropicToOpenAI({
    ...anthropicBody,
    model: resolveAnthropicModel(String(anthropicBody?.model || ''), ctx.config),
  })
  const convertedBuf = Buffer.from(JSON.stringify(converted))
  const synth = syntheticRequest(req, convertedBuf)
  const reply = createAnthropicReply(res, {
    stream: converted.stream === true,
    model: String(anthropicBody?.model || ''),
  })
  await chatHandler(synth, reply)
}

/**
 * 处理 POST /v1/messages/count_tokens.
 *
 * @param {any} ctx 依赖集合(bodyReadTimeoutMs 用)
 * @param {any} req 下游请求
 * @param {any} res 下游响应
 * @returns {Promise<void>} 处理完成
 */
export async function handleCountTokens(ctx: any, req: any, res: any): Promise<void> {
  let raw: Buffer
  try {
    raw = await readRequestBody(req, undefined, bodyReadTimeoutMs(ctx))
  } catch (err: any) {
    sendBodyReadError(res, err)
    return
  }
  let body: any
  try {
    body = JSON.parse(raw.toString('utf8') || '{}')
  } catch {
    sendJson(res, 400, errorBody('Invalid JSON body', 'invalid_request_error'))
    return
  }
  sendJson(res, 200, { input_tokens: estimateTokens(body) })
}

/**
 * 构造交给 chat 管线的合成请求.
 *
 * 请求体经 Symbol.asyncIterator 供给(管线用 for-await 读体), socket 委托
 * 真实请求(断开感知与 abort 都挂在那).
 *
 * @param {any} real 真实下游请求
 * @param {Buffer} bodyBuf 转换后的请求体
 * @returns {any} 合成请求对象
 */
function syntheticRequest(real: any, bodyBuf: Buffer): any {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(bodyBuf.length),
  }
  const auth = real?.headers?.authorization || real?.headers?.Authorization
  if (typeof auth === 'string' && auth) headers.authorization = auth
  const iter = async function* () {
    yield bodyBuf
  }
  return {
    method: 'POST',
    url: '/v1/chat/completions',
    headers,
    socket: real?.socket,
    aborted: false,
    destroyed: false,
    destroy() {},
    [Symbol.asyncIterator]: iter,
  }
}

/**
 * 写 Anthropic 形态的错误响应体.
 *
 * @param {string} message 错误描述
 * @param {string} type Anthropic 错误类型
 * @returns {any} 响应体对象
 */
function errorBody(message: string, type: string): any {
  return { type: 'error', error: { type, message } }
}

/**
 * 读体失败的统一收场(过大 / 超时 / 客户端断开).
 *
 * @param {any} res 下游响应
 * @param {any} err 读体异常
 * @returns {void} 无返回
 */
function sendBodyReadError(res: any, err: any): void {
  if (err && err.statusCode === 413) {
    sendJson(res, 413, errorBody('Request body too large', 'invalid_request_error'))
    return
  }
  if (!err || err.code === 'client_aborted') return
  if (err && err.statusCode === 408) {
    sendJson(res, 408, errorBody('Timed out reading request body', 'api_error'))
    return
  }
  throw err
}
