# MCP Forwarder for Vercel

该工程将 MCP 转发服务器重构为“可在 Vercel 部署并通过 /api 访问”的形式，兼容 @modelcontextprotocol/inspector 的 SSE 连接方式，支持长连接与 JSON-RPC 流式转发。

核心端点（Vercel Serverless Functions）：
- GET /api/sse：SSE 入口（标准 SSE 头、心跳、断线重连；原样透传上游事件）
- POST /api/sse/message：消息通道，将 JSON-RPC 请求转发到上游 /sse/message，保留查询与必要头
- POST /api/mcp：兼容流式 HTTP 的 JSON-RPC 转发（透传 Accept 与 Mcp-Session-Id）
- GET /api/health：健康检查，输出配置摘要
- OPTIONS：为上述路由提供预检，补全 Allow-Headers 与 Expose-Headers（Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID, Origin, X-Requested-With）

环境变量（在 Vercel 控制台 -> Settings -> Environment Variables 配置）：
- UPSTREAM_URL：上游 Streamable HTTP 端点（默认 https://mcp.deepwiki.com/mcp）
- UPSTREAM_SSE_URL：上游 SSE 端点（默认将 UPSTREAM_URL 的 /mcp 推断为 /sse）
- UPSTREAM_HEADERS_JSON：需要附加到上游的请求头 JSON，例如 {"Authorization":"Bearer <API_KEY>","Mcp-Session-Id":"<固定会话>"}
- CORS_ORIGIN：允许跨域的 Origin（默认 *，建议填写实际域名）
- UPSTREAM_TIMEOUT_MS：上游请求超时（默认 0 即不施加硬超时）

部署步骤：
1) 推送本仓库至 GitHub/GitLab。
2) 在 Vercel 新建 Project，选择该仓库。
3) 在 Vercel 控制台设置环境变量（见上）。
4) 部署完成后，Inspector 选择 SSE，连接 https://{your-app}.vercel.app/api/sse。
   - 若需要鉴权或固定会话（Authorization/Mcp-Session-Id），在 UPSTREAM_HEADERS_JSON 中配置即可。

使用与验证：
- SSE：`curl -N -H "Accept: text/event-stream" https://{your-app}.vercel.app/api/sse`
  - 心跳 `: heartbeat` 每 15 秒输出；若上游断流，代理会发出 warn 事件并指数退避重连。
- 消息通道：当 SSE 推送 endpoint（如 `/sse/message?sessionId=...`）后，可在本地或浏览器对 `/api/sse/message?sessionId=...` 发起 POST JSON-RPC。
- 健康检查：`curl https://{your-app}.vercel.app/api/health`

代码结构：
- api/sse.js：SSE 入口（GET/OPTIONS）
- api/sse/message.js：消息通道（POST/OPTIONS）
- api/mcp.js：Streamable HTTP JSON-RPC 转发（POST/OPTIONS）
- api/health.js：健康检查（GET/OPTIONS）
- src/lib/upstream.js：共用上游转发与 headers/Agent 管理
- src/lib/logger.js：简易结构化日志
- vercel.json：函数运行时与路由配置
- .env.example：本地仿真时的示例（Vercel 上请用控制台环境变量）

Vercel 云端限制与建议：
- Hobby（免费）计划的 Serverless Functions 通常只有较短的最大执行时长（如 10s）。SSE 长连接与 ask_question 这类长时调用可能被中途终止。
- 建议：
  - 选择 Pro 以提升 maxDuration（如 60s）。
  - 或改用 Edge Functions（更适合长连接与流式转发）。
  - 控制工具调用时长，必要时通过分页或分步调用缩短单次请求。

Inspector 连接方法（SSE）：
- 在 Inspector 选择 SSE 模式，地址填写 `https://{your-app}.vercel.app/api/sse`。
- 若你的上游需要授权：在环境变量 `UPSTREAM_HEADERS_JSON` 中加入 `{"Authorization":"Bearer <API_KEY>"}`；如需固定会话，加入 `{"Mcp-Session-Id":"<sessionId>"}`。

本地仿真（非 Vercel 环境）：
- 该工程为 Vercel Functions 目录结构，不包含独立的本地 Node 服务器。若需本地调试，可配合 `vercel dev`（需安装 Vercel CLI），或参考我们在另一个工程 mcp-forwarder-node 的本地服务器版本。

常见问题：
- 连接后不上线工具：通常是缺少鉴权或会话；请在 UPSTREAM_HEADERS_JSON 配置 Authorization 或固定会话。
- GET /api/sse 无事件：检查 UPSTREAM_SSE_URL 是否能访问；若上游只提供 /mcp，则代理会将 /mcp 推断为 /sse，但若上游没有 /sse 需显式提供正确端点。
- ask_question 超时：Serverless 函数时长限制或上游响应慢导致；代理默认不施加硬超时，但云端会有上限。可选择 Pro/Edge 或缩短单次请求。
