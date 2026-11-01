/**
 * api: /v1/messages 的端到端冒烟
 *
 * Anthropic 面 -> OpenAI 管线 -> Anthropic 回程的全链路: 档位映射落表,
 * 流式事件序列, 非流式 JSON, 错误信封转换, count_tokens.
 */

import { state } from '../../../../../smoke/state.ts'
import { base, config } from '../../../harness/runtime.ts'
import assert from 'node:assert/strict'

// 档位映射指向热会话绑定的模型: 共享 runtime 的付费时段保护会拒绝换模型
// (mock 语义: 每账号一小时买断且绑定模型), 换模型会让本用例 429.
config.anthropic = { mainModel: 'deepseek/deepseek-v4-flash', smallModel: 'mimo/mimo-v2.5' }

const MODEL = 'deepseek/deepseek-v4-flash'

const messages = (body: any, stream = false) =>
  fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ max_tokens: 100, ...body, stream }),
  })

// 流式: 事件序列完整, 档位映射落到上游
{
  state.calls = []
  state.mockMode = 'ok'
  const res = await messages({
    model: 'claude-sonnet-5',
    system: 'be brief',
    messages: [{ role: 'user', content: 'hello' }],
  }, true)
  assert.equal(res.status, 200, await res.clone().text())
  assert.ok(res.headers.get('content-type')?.includes('text/event-stream'))
  const text = await res.text()
  assert.ok(text.includes('event: message_start'), text.slice(0, 400))
  assert.ok(text.includes('"text_delta"') && text.includes('hi'))
  assert.ok(text.trimEnd().endsWith('event: message_stop\ndata: {"type":"message_stop"}'))
  const chatCall = state.calls.filter((c) => c.url.includes('/chat/completions')).at(-1)
  const upstreamBody = JSON.parse(chatCall.body)
  assert.equal(upstreamBody.model, MODEL, `tier map: ${upstreamBody.model}`)
  assert.equal(upstreamBody.messages[0].role, 'system')
  assert.ok(upstreamBody.messages[0].content.includes('be brief'))
}

// 非流式: OpenAI JSON 转 Anthropic message
{
  state.mockMode = 'ok'
  const res = await messages({
    model: MODEL,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.type, 'message')
  assert.equal(j.role, 'assistant')
  assert.equal(j.content[0].type, 'text')
  assert.equal(j.content[0].text, 'hi')
  assert.equal(j.stop_reason, 'end_turn')
}

// 请求侧转换: tools 与 tool_use/tool_result 历史落到上游 OpenAI 形态
{
  state.calls = []
  state.mockMode = 'ok'
  const res = await messages({
    model: MODEL,
    messages: [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'read', input: { p: 'a.txt' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'data' }],
      },
    ],
    tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object', properties: {} } }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  const upstreamBody = JSON.parse(state.calls.filter((c) => c.url.includes('/chat/completions')).at(-1).body)
  assert.equal(upstreamBody.tools[0].type, 'function')
  assert.equal(upstreamBody.tools[0].function.name, 'read')
  const toolMsg = upstreamBody.messages.find((m: any) => m.role === 'tool')
  assert.equal(toolMsg.tool_call_id, 'toolu_1')
  assert.equal(toolMsg.content, 'data')
  const asst = upstreamBody.messages.find((m: any) => m.role === 'assistant')
  assert.equal(asst.tool_calls[0].id, 'toolu_1')
}

// 错误路径: 上游非 2xx 转成 Anthropic 错误信封
{
  state.mockMode = 'tool_schema_reject'
  const res = await messages({
    model: MODEL,
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'read', description: 'd', input_schema: { type: 'object', properties: {} } }],
  })
  assert.equal(res.status, 404)
  const j = await res.json()
  assert.equal(j.type, 'error')
  assert.ok(typeof j.error?.message === 'string' && j.error.message.length > 0)
}

// count_tokens: 恒 200 且估算非零
{
  const res = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'abcd' }] }),
  })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.ok(Number.isInteger(j.input_tokens) && j.input_tokens >= 1)
}

state.mockMode = 'ok'
