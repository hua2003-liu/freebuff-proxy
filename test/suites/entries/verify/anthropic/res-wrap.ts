/**
 - Anthropic 回程包装 res 的可证伪验证.
 *
 - 包装器把 chat 管线写出的 OpenAI 形态(流式 SSE / 整体 JSON / 错误信封)
 - 实时转成 Anthropic 形态. 判据: 头部延迟到首字节才发, 流式逐事件转发,
 - 非流式与错误路径修正 content-length, 背压与 drain 透传到底层 res.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createAnthropicReply } from '../../../../../src/proxy/anthropic/res-wrap.ts'

let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`ok   ${name}`)
  } else {
    failed++
    console.error(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}

/** 模拟底层 ServerResponse: 记录头与体, write 恒返回可写. */
function fakeTarget() {
  const t = new EventEmitter()
  t.headersSent = false
  t.writeHeadStatus = null
  t.writeHeadHeaders = null
  t.headers = new Map()
  t.body = []
  t.setHeader = (k, v) => t.headers.set(k.toLowerCase(), v)
  t.getHeader = (k) => t.headers.get(k.toLowerCase())
  t.writeHead = (status, headers) => {
    t.writeHeadStatus = status
    t.writeHeadHeaders = headers || {}
    t.headersSent = true
  }
  t.write = (chunk) => {
    t.body.push(String(chunk))
    return true
  }
  t.end = (chunk) => {
    if (chunk) t.body.push(String(chunk))
    t.ended = true
  }
  return t
}

// 1) 流式: OpenAI SSE 进, Anthropic 事件块出, 头部修正
{
  const target = fakeTarget()
  const res = createAnthropicReply(target, { stream: true, model: 'claude-sonnet-5' })
  res.setHeader('content-type', 'text/event-stream')
  res.writeHead(200)
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n'
  const half = line.slice(0, 20)
  res.write(half)
  res.write(line.slice(20))
  res.end()
  const out = target.body.join('')
  check('头部状态 200', target.writeHeadStatus === 200)
  check(
    '事件块完整(message_start 到 message_stop)',
    out.includes('message_start') && out.includes('text_delta') && out.includes('"hi"') && out.includes('message_stop'),
  )
  check('分片边界不打碎事件', out.split('\n').some((l) => l.startsWith('data: ') && l.includes('message_start')))
  check('底层已收尾', target.ended === true)
}

// 2) 非流式: 整体 JSON 转换并修正 content-length
{
  const target = fakeTarget()
  const res = createAnthropicReply(target, { stream: false, model: 'claude-sonnet-5' })
  const openai = JSON.stringify({
    id: 'c1', choices: [{ message: { role: 'assistant', content: 'ans' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 5 },
  })
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(openai.length + 999) })
  res.write(openai)
  res.end()
  const out = target.body.join('')
  const obj = JSON.parse(out)
  check('非流式转成 message 形态', obj.type === 'message' && obj.content[0]?.text === 'ans')
  const len = target.writeHeadHeaders?.['content-length']
  check('content-length 已修正', len === String(Buffer.byteLength(out)))
}

// 3) 错误: OpenAI 错误信封转 Anthropic 错误信封
{
  const target = fakeTarget()
  const res = createAnthropicReply(target, { stream: false, model: 'm' })
  res.writeHead(429, { 'content-type': 'application/json' })
  res.write(JSON.stringify({ error: { message: 'account busy', code: 'account_busy' } }))
  res.end()
  const obj = JSON.parse(target.body.join(''))
  check(
    '错误信封形态',
    obj.type === 'error' && obj.error?.type === 'rate_limit_error' && obj.error?.message === 'account busy',
  )
  check('错误状态保留', target.writeHeadStatus === 429)
}

// 4) sendJson 形态(writeHead + end 一体, 无 write)
{
  const target = fakeTarget()
  const res = createAnthropicReply(target, { stream: false, model: 'm' })
  res.writeHead(503, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'no session', code: 'no_session' } }))
  const obj = JSON.parse(target.body.join(''))
  check('end 携带体也能转换', obj.type === 'error' && obj.error?.type === 'api_error')
}

// 5) 背压与 drain 透传
{
  const target = fakeTarget()
  let drainCb = null
  target.write = () => false
  target.once('drain', () => {
    drainCb = true
  })
  const res = createAnthropicReply(target, { stream: true, model: 'm' })
  res.writeHead(200)
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) + '\n\n'
  const backpressured = res.write(line) === false
  target.emit('drain')
  check('write 透传底层背压返回值', backpressured)
  check('drain 事件直达底层监听', drainCb === true)
}

// 6) setHeader 在 writeHead 之前设置的观测头保留
{
  const target = fakeTarget()
  const res = createAnthropicReply(target, { stream: true, model: 'm' })
  res.setHeader('x-freebuff-proxy-account', 'a@x.com')
  res.writeHead(200)
  res.end()
  check('观测头保留', target.headers.get('x-freebuff-proxy-account') === 'a@x.com')
}

if (failed) {
  console.error(`FAILED ${failed}`)
  process.exit(1)
}
console.log('ALL PASS')
