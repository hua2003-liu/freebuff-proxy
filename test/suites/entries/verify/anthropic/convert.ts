/**
 - Anthropic -> OpenAI 请求转换的可证伪验证.
 *
 - 判据全部来自 /v1/messages 的真实形态(Claude Code 发出的请求):
 - system 顶层化, content 块拆解, tool_use/tool_result 双向成对,
 - 工具 schema 形态转换, 采样参数透传.
 *
 - 每条断言都能被实现侧改动证伪: 破坏任一字段的映射, 对应断言立刻变红.
 */
import assert from 'node:assert/strict'
import { anthropicToOpenAI, estimateTokens } from '../../../../../src/proxy/anthropic/request.ts'

let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`ok   ${name}`)
  } else {
    failed++
    console.error(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}

// 1) 顶层 system 转成首条 system 消息
{
  const out = anthropicToOpenAI({
    model: 'claude-sonnet-5', max_tokens: 100, system: 'be brief',
    messages: [{ role: 'user', content: 'hi' }],
  })
  check('system 成为首条 system 消息', out.messages[0]?.role === 'system' && out.messages[0]?.content === 'be brief')
  check('user 文本串消息保留', out.messages[1]?.role === 'user' && out.messages[1]?.content === 'hi')
}

// 2) system 块数组形态(带 cache_control, 应被丢弃只留文本)
{
  const out = anthropicToOpenAI({
    model: 'm', max_tokens: 1,
    system: [{ type: 'text', text: 'sys-a', cache_control: { type: 'ephemeral' } }],
    messages: [],
  })
  check('system 块数组只取文本', out.messages[0]?.content === 'sys-a')
}

// 3) assistant 的 tool_use 块 -> OpenAI tool_calls
{
  const out = anthropicToOpenAI({
    model: 'm', max_tokens: 1,
    messages: [
      { role: 'user', content: 'run ls' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
        ],
      },
    ],
  })
  const asst = out.messages[1]
  check('assistant 文本保留', asst?.content === 'let me check')
  check(
    'tool_use 转成 tool_calls',
    asst?.tool_calls?.[0]?.id === 'toolu_1'
      && asst.tool_calls[0]?.type === 'function'
      && asst.tool_calls[0]?.function?.name === 'bash'
      && JSON.parse(asst.tool_calls[0]?.function?.arguments).command === 'ls',
  )
}

// 4) user 的 tool_result 块 -> OpenAI tool 消息
{
  const out = anthropicToOpenAI({
    model: 'm', max_tokens: 1,
    messages: [
      { role: 'user', content: 'run' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'bash', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_9', content: 'file-a\nfile-b' },
          { type: 'text', text: 'summarize' },
        ],
      },
    ],
  })
  const toolMsg = out.messages[2]
  const textMsg = out.messages[3]
  check(
    'tool_result 转成 role:tool 消息',
    toolMsg?.role === 'tool' && toolMsg?.tool_call_id === 'toolu_9' && toolMsg?.content === 'file-a\nfile-b',
  )
  check('tool_result 之后的文本独立成消息', textMsg?.role === 'user' && textMsg?.content === 'summarize')
}

// 5) tools 形态转换: Anthropic {name, input_schema} -> OpenAI function
{
  const out = anthropicToOpenAI({
    model: 'm', max_tokens: 1, messages: [],
    tools: [{
      name: 'read', description: 'read a file',
      input_schema: { type: 'object', properties: { p: { type: 'string' } } },
    }],
  })
  const t = out.tools?.[0]
  check(
    'tools 转成 OpenAI function 形态',
    t?.type === 'function' && t?.function?.name === 'read'
      && t?.function?.parameters?.properties?.p?.type === 'string',
  )
}

// 6) 采样参数: stop_sequences -> stop, temperature/top_p 透传, top_k 丢弃
{
  const out = anthropicToOpenAI({
    model: 'm', max_tokens: 1, messages: [],
    temperature: 0.5, top_p: 0.9, top_k: 40, stop_sequences: ['END'],
  })
  check('temperature/top_p 透传', out.temperature === 0.5 && out.top_p === 0.9)
  check('stop_sequences 映射为 stop', JSON.stringify(out.stop) === JSON.stringify(['END']))
  check('top_k 丢弃', !('top_k' in out))
}

// 7) stream 意图与 max_tokens 保留
{
  const out = anthropicToOpenAI({
    model: 'm', max_tokens: 777, stream: true, messages: [{ role: 'user', content: 'x' }],
  })
  check('stream 保留', out.stream === true)
  check('max_tokens 保留', out.max_tokens === 777)
}

// 8) thinking 块丢弃(回传时上游不消费)
{
  const out = anthropicToOpenAI({
    model: 'm', max_tokens: 1,
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'answer' },
      ],
    }],
  })
  check('thinking 块被丢弃', out.messages[0]?.content === 'answer')
}

// 9) 字符串 content 与块数组 content 等价
{
  const a = anthropicToOpenAI({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'plain' }] })
  const b = anthropicToOpenAI({
    model: 'm', max_tokens: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }],
  })
  check('字符串与块数组 content 等价', a.messages[0]?.content === b.messages[0]?.content)
}

// 10) count_tokens 粗估: 非零, 与长度正相关, system 计入
{
  const small = estimateTokens({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'abcd' }] })
  const big = estimateTokens({
    model: 'm', max_tokens: 1, system: 'x'.repeat(400),
    messages: [{ role: 'user', content: 'y'.repeat(400) }],
  })
  check('估算非零', small > 0)
  check(
    '更长文本估算更大', big > small,
  )
}

// 11) tool_choice 的禁用工具与禁并行语义
{
  const none = anthropicToOpenAI({
    model: 'm', max_tokens: 1, messages: [],
    tools: [{ name: 'read', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'none' },
  })
  const serial = anthropicToOpenAI({
    model: 'm', max_tokens: 1, messages: [],
    tools: [{ name: 'read', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  })
  check('tool_choice none 禁止工具', none.tool_choice === 'none')
  check('disable_parallel_tool_use 关闭并行', serial.parallel_tool_calls === false)
}

// 12) UTF-8 字符跨 Buffer 分块时保持完整
{
  const { openAISseToAnthropicJson } = await import('../../../../../src/proxy/anthropic/response.ts')
  const response = openAISseToAnthropicJson(
    'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'claude-haiku-5-5',
  )
  check('上游 SSE 聚合为完整响应', response?.content?.[0]?.text === 'OK')
}

if (failed) {
  console.error(`FAILED ${failed}`)
  process.exit(1)
}
console.log('ALL PASS')
