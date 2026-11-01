/**
 * Anthropic Messages 请求 -> OpenAI chat 请求的纯转换.
 *
 * 输入是 /v1/messages 的请求体, 输出是本仓 chat 管线消费的 OpenAI 形态体.
 * 顶层 system 拆成首条 system 消息; content 块按类型拆解; tool_use 与
 * tool_result 转成 OpenAI 的 tool_calls / role:tool 消息.
 * cache_control / metadata / thinking 块 / top_k 在此丢弃: 上游没有对应物.
 */

/** Anthropic 消息体里的一种内容块(只列本转换关心的字段). */
interface Block {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: any
  tool_use_id?: string
  content?: any
  source?: { type?: string, data?: string, media_type?: string }
}

/**
 * 把 Anthropic Messages 请求体转换成 OpenAI chat 请求体.
 *
 * @param {any} body /v1/messages 请求体(JSON)
 * @returns {any} OpenAI /v1/chat/completions 形态的请求体
 */
export function anthropicToOpenAI(body: any): any {
  const out: any = {
    model: body.model,
    stream: body.stream === true,
    max_tokens: body.max_tokens,
    messages: buildMessages(body.system, body.messages),
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) out.tools = body.tools.map(mapTool)
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    out.stop = body.stop_sequences
  }
  if (body.tool_choice) out.tool_choice = mapToolChoice(body.tool_choice)
  if (body.tool_choice?.disable_parallel_tool_use === true) out.parallel_tool_calls = false
  return out
}

/**
 * 估算一次请求的 token 量(粗估).
 *
 * 判据: 非零, 随文本长度单调增, system 计入. 上游没有 count_tokens 端点,
 * 本估算只服务 /v1/messages/count_tokens 的响应形状.
 *
 * @param {any} body /v1/messages 请求体(JSON)
 * @returns {number} 估算 token 数(恒 >= 1)
 */
export function estimateTokens(body: any): number {
  let chars = 0
  if (typeof body?.system === 'string') chars += body.system.length
  if (Array.isArray(body?.system)) {
    for (const b of body.system) chars += typeof b?.text === 'string' ? b.text.length : 0
  }
  for (const msg of Array.isArray(body?.messages) ? body.messages : []) {
    chars += messageTextChars(msg?.content)
    chars += 4
  }
  for (const t of Array.isArray(body?.tools) ? body.tools : []) {
    chars += (t?.name?.length || 0) + (t?.description?.length || 0)
    chars += JSON.stringify(t?.input_schema || {}).length
  }
  return Math.max(1, Math.ceil(chars / 4))
}

/**
 * 组装 OpenAI messages 数组.
 *
 * @param {any} system 顶层 system(字符串 / 块数组 / 缺省)
 * @param {any} messages Anthropic messages 数组
 * @returns {any[]} OpenAI messages 数组
 */
function buildMessages(system: any, messages: any): any[] {
  const out: any[] = []
  const sysText = blocksText(system)
  if (sysText) out.push({ role: 'system', content: sysText })
  for (const msg of Array.isArray(messages) ? messages : []) {
    out.push(...convertMessage(msg))
  }
  return out
}

/**
 * 转换单条 Anthropic 消息(可能产出 1 条或多条 OpenAI 消息).
 *
 * user 里的 tool_result 每块独立成一条 role:tool 消息, 文本块合到末尾.
 *
 * @param {any} msg Anthropic 消息(role + content)
 * @returns {any[]} 产出的 OpenAI 消息(1 条或多个)
 */
function convertMessage(msg: any): any[] {
  const content = msg?.content
  if (typeof content === 'string') return [{ role: msg.role, content }]
  const blocks: Block[] = Array.isArray(content) ? content : []
  if (msg?.role === 'assistant') return [convertAssistant(blocks)]
  return convertUser(blocks)
}

/**
 * 转换 assistant 消息: 文本进 content, tool_use 进 tool_calls.
 *
 * @param {Block[]} blocks 内容块数组
 * @returns {any} 单条 OpenAI assistant 消息
 */
function convertAssistant(blocks: Block[]): any {
  const out: any = { role: 'assistant', content: null }
  const texts: string[] = []
  const calls: any[] = []
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    if (b?.type === 'tool_use' && b.id && b.name) {
      calls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      })
    }
    // thinking 块不转换到 OpenAI 消息.
  }
  if (texts.length > 0) out.content = texts.join('')
  if (calls.length > 0) out.tool_calls = calls
  return out
}

/**
 * 转换 user 消息: text 合并, tool_result 逐块成 role:tool 消息.
 *
 * @param {Block[]} blocks 内容块数组
 * @returns {any[]} OpenAI 消息(文本 1 条 + 每个工具结果各 1 条)
 */
function convertUser(blocks: Block[]): any[] {
  const out: any[] = []
  const texts: string[] = []
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text)
    } else if (b?.type === 'image' && b.source?.data) {
      texts.push(`[image: ${b.source.media_type || 'image/unknown'}]`)
    } else if (b?.type === 'tool_result') {
      if (texts.length > 0) {
        out.push({ role: 'user', content: texts.join('') })
        texts.length = 0
      }
      out.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: resultText(b.content) })
    }
  }
  if (texts.length > 0 || out.length === 0) {
    out.push({ role: 'user', content: texts.join('') })
  }
  return out
}

/**
 * 取 tool_result 块的文本形态.
 *
 * @param {any} content tool_result 的 content(字符串 / 块数组)
 * @returns {string} 文本内容
 */
function resultText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b?.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * 把 system / 文本块集合取成纯文本.
 *
 * @param {any} content 字符串或块数组
 * @returns {string} 拼接后的文本(空集合为空串)
 */
function blocksText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (typeof b?.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('')
}

/**
 * 统计一段 content 的字符数(估算用).
 *
 * @param {any} content 字符串或块数组
 * @returns {number} 字符数
 */
function messageTextChars(content: any): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content) {
    if (typeof b?.text === 'string') n += b.text.length
    if (b?.type === 'tool_result') n += resultText(b.content).length
    if (typeof b?.input === 'object' && b.input) n += JSON.stringify(b.input).length
  }
  return n
}

/**
 * 转换单个工具声明.
 *
 * @param {any} tool Anthropic 工具(name / description / input_schema)
 * @returns {any} OpenAI function 工具
 */
function mapTool(tool: any): any {
  return {
    type: 'function',
    function: {
      name: tool?.name,
      description: tool?.description,
      parameters: tool?.input_schema ?? { type: 'object', properties: {} },
    },
  }
}

/**
 * 转换 tool_choice.
 *
 * @param {any} choice Anthropic tool_choice(auto / any / tool / none)
 * @returns {any} OpenAI tool_choice
 */
function mapToolChoice(choice: any): any {
  if (choice?.type === 'none') return 'none'
  if (choice?.type === 'any') return 'required'
  if (choice?.type === 'tool' && choice?.name) {
    return { type: 'function', function: { name: choice.name } }
  }
  return 'auto'
}
