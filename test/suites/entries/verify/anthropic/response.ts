/**
 - OpenAI -> Anthropic 响应转换的可证伪验证.
 *
 - 覆盖两条回程: 非流式整体 JSON 与流式 SSE 状态机. 判据取自 Anthropic
 - Messages 响应的真实形态: message_start 首发且仅一次, content_block 的
 - start/delta/stop 配对, tool_use 的 input_json_delta 拼回可解析 JSON,
 - stop_reason 按 finish_reason 映射, message_stop 收尾.
 */
import assert from 'node:assert/strict'
import {
  openAIToAnthropicJson,
  createAnthropicSseState,
  createAnthropicSseTransform,
} from '../../../../../src/proxy/anthropic/response.ts'

let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`ok   ${name}`)
  } else {
    failed++
    console.error(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}

/** 构造一条 OpenAI SSE data 行(缩短测试里的长行). */
const oc = (obj) => 'data: ' + JSON.stringify(obj)

/** 把若干 OpenAI SSE data 行喂进状态机, 收集产出的事件块. */
function feedAll(state, lines) {
  const out = []
  for (const l of lines) out.push(...state.feed(l))
  out.push(...state.finish())
  return out
}

function parseEvents(blocks) {
  return blocks
    .flatMap((b) => b.split('\n'))
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)))
}

// 1) 纯文本流: 事件序列与配对
{
  const state = createAnthropicSseState('claude-sonnet-5')
  const events = parseEvents(feedAll(state, [
    oc({ choices: [{ delta: { content: 'he' } }] }),
    oc({ choices: [{ delta: { content: 'llo' } }] }),
    oc({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]',
  ]))
  const types = events.map((e) => e.type)
  check('message_start 首发', types[0] === 'message_start')
  check('message_stop 收尾', types[types.length - 1] === 'message_stop')
  check(
    '文本块 start/delta/stop 配对',
    types.includes('content_block_start')
      && types.filter((t) => t === 'content_block_delta').length >= 2
      && types.includes('content_block_stop'),
  )
  const text = events
    .filter((e) => e.type === 'content_block_delta')
    .map((e) => e.delta?.text || '')
    .join('')
  check('文本增量拼回原文', text === 'hello')
  const msgDelta = events.find((e) => e.type === 'message_delta')
  check('stop_reason 映射 end_turn', msgDelta?.delta?.stop_reason === 'end_turn')
  const start = events[0]
  check(
    'message_start 带模型名与空 content',
    start?.message?.model === 'claude-sonnet-5' && Array.isArray(start?.message?.content),
  )
}

// 2) 工具调用流: input_json_delta 拼回可解析 JSON
{
  const state = createAnthropicSseState('m')
  const events = parseEvents(feedAll(state, [
    oc({ choices: [{ delta: { tool_calls: [{
      index: 0, id: 'call_1', function: { name: 'read', arguments: '' },
    }] } }] }),
    oc({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"p":' } }] } }] }),
    oc({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] } }] }),
    oc({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]',
  ]))
  const startEv = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
  check('tool_use 块声明 id 与名字', startEv?.content_block?.id === 'call_1' && startEv?.content_block?.name === 'read')
  const json = events
    .filter((e) => e.delta?.type === 'input_json_delta')
    .map((e) => e.delta.partial_json)
    .join('')
  check('参数增量拼回可解析 JSON', (() => { try { return JSON.parse(json).p === 'a' } catch { return false } })())
  const msgDelta = events.find((e) => e.type === 'message_delta')
  check('stop_reason 映射 tool_use', msgDelta?.delta?.stop_reason === 'tool_use')
}

// 3) 文本 + 工具混排: 文本块先闭合, 块序号不重叠
{
  const state = createAnthropicSseState('m')
  const events = parseEvents(feedAll(state, [
    oc({ choices: [{ delta: { content: 'ok' } }] }),
    oc({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'bash', arguments: '{}' } }] } }] }),
    'data: [DONE]',
  ]))
  const starts = events.filter((e) => e.type === 'content_block_start')
  const stops = events.filter((e) => e.type === 'content_block_stop')
  check(
    '两个块各自 start',
    starts.length === 2
      && starts[0]?.content_block?.type === 'text'
      && starts[1]?.content_block?.type === 'tool_use',
  )
  check('两个块各自 stop 且序号配对', stops.length === 2 && stops[0]?.index === 0 && stops[1]?.index === 1)
}

// 4) 非流式整体 JSON: content 块与 usage
{
  const out = openAIToAnthropicJson({
    id: 'chatcmpl-1',
    choices: [{
      message: {
        role: 'assistant',
        content: 'answer',
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'ls', arguments: '{"x":1}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 12, completion_tokens: 34 },
  }, 'claude-sonnet-5')
  check('非流式形态字段', out.type === 'message' && out.role === 'assistant' && out.model === 'claude-sonnet-5')
  check('文本块在前', out.content[0]?.type === 'text' && out.content[0]?.text === 'answer')
  check(
    'tool_use 块在后且 input 已解析',
    out.content[1]?.type === 'tool_use' && out.content[1]?.name === 'ls' && out.content[1]?.input?.x === 1,
  )
  check(
    'stop_reason 与 usage',
    out.stop_reason === 'tool_use'
      && out.usage?.input_tokens === 12 && out.usage?.output_tokens === 34,
  )
}

// 5) TransformStream: 字节分片边界不打碎事件
{
  const state = createAnthropicSseState('m')
  const full = oc({ choices: [{ delta: { content: 'split-me' } }] }) + '\n\n'
  const t = createAnthropicSseTransform('m')
  const writer = t.writable.getWriter()
  const reader = t.readable.getReader()
  const collected = []
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      collected.push(new TextDecoder().decode(value))
    }
  })()
  const enc = new TextEncoder()
  const mid = Math.floor(full.length / 2)
  await writer.write(enc.encode(full.slice(0, mid)))
  await writer.write(enc.encode(full.slice(mid)))
  await writer.write(enc.encode('data: [DONE]\n\n'))
  await writer.close()
  await readAll
  const outText = collected.join('')
  const dataLines = outText.split('\n').filter((l) => l.startsWith('data: '))
  const events = dataLines.map((l) => { try { return JSON.parse(l.slice(6)) } catch { return null } })
  check(
    '分片字节流产出完整事件',
    events.some((e) => e?.type === 'message_start') && events.some((e) => e?.delta?.text === 'split-me'),
  )
  assert.ok(Array.isArray(dataLines))
}

// 6) 空流直接收尾: 也要有 start/stop 完整对
{
  const state = createAnthropicSseState('m')
  const events = parseEvents(feedAll(state, ['data: [DONE]']))
  const types = events.map((e) => e.type)
  check(
    '空流事件仍完整',
    types[0] === 'message_start' && types.includes('content_block_stop') === false
      && types[types.length - 1] === 'message_stop',
  )
}

if (failed) {
  console.error(`FAILED ${failed}`)
  process.exit(1)
}
console.log('ALL PASS')
