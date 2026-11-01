# Agent Note: /v1/messages Anthropic 协议面(下游外壳适配)

Status: implemented

## Problem

Claude Code 只会讲 Anthropic Messages 协议(POST /v1/messages, 顶层 system,
content 块数组, tool_use/tool_result, SSE 事件流 message_start/content_block_*/
message_delta/message_stop). 本仓对下游只暴露 OpenAI 形态的
/v1/chat/completions, 于是 Claude Code 无法直连本代理.

上游封锁 web 通道与 bearer 通道后(409 chat_moved / 403
free_mode_cli_required), 免费额度的唯一出路是官方 CLI 形态, 本仓的 chat
管线就是这条链路的完整实现; 缺的只是下游协议面.

## Decision

适配层做成"下游外壳"(src/proxy/anthropic/), chat 管线零改动:

- 请求侧: handleMessages 读体 -> anthropicToOpenAI 纯转换 -> 合成请求
  (Symbol.asyncIterator 供体, socket 委托真实请求) -> 交给既有 chatHandler.
  选号/重试/换号/限流/透传全部复用.
- 回程侧: createAnthropicReply 包装 res, 拦截 writeHead/write/end, 把管线
  写出的 OpenAI SSE / 整体 JSON / OpenAI 错误信封实时转回 Anthropic 形态.
  头部延迟到首字节, 便于修正 content-type/content-length.
- 模型名: claude-* 按档位映射(claude-*haiku* -> anthropic.smallModel,
  其余 -> anthropic.mainModel), 真源是 ctx.config(启动时深合并 DEFAULTS
  与已存可调项), 面板两个 string 可调项(anthropic.mainModel/smallModel)
  由 specs 表自动渲染. 非 claude 名原样进 resolveModelAlias(唯一真源不动).
- count_tokens: 本地粗估(字符/4, 恒 200), 上游没有对应端点.
- 鉴权: authorize 增加 x-api-key 头读取(Anthropic SDK 的默认携带方式);
  ANTHROPIC_AUTH_TOKEN 走 Authorization Bearer 原样可用.

丢弃项: cache_control / metadata / thinking 块 / top_k(上游无对应物);
image 块降级为占位文本.

## Alternatives considered

- 什么都不做: 让用户经 claude-code-router / LiteLLM 等外部翻译层接
  /v1/chat/completions. 多一跳部署与故障面, tool 调用兼容性取决于第三方,
  放弃.
- 在管线内部逐点改(transport/forward.ts, reply/rewrite.ts, errors/respond.ts
  每个错误写出点加协议分支): 触面十几处, 每处都是回归风险, 与"管线对下游
  协议无感知"的现有分层相悖, 放弃.
- 复用 /v1/responses 的先例回 501: 等于宣布不支持 Claude Code, 放弃.
- 模型名写死映射表(claude-sonnet-5 -> 某固定 id): 目录随上游换代,
  写死会静默失效; 档位映射把选择交给面板, 默认值只作出厂兜底.
