# MCP Forwarder Vercel 修复记录

## 🚨 问题描述

在 Vercel 上部署后，MCP Inspector 无法连接，而本地 success.js 可以正常工作。

## 🔍 根本原因

通过对比分析，发现 Vercel 版本缺少了一个关键功能：**自动 session 初始化**

### 具体差异：

1. **success.js 有自动 session 初始化**：
   - 当客户端没有提供 sessionId 时，会自动向上游发起 initialize 请求
   - 成功获取 session 后继续进行 SSE 连接
   - 失败时给出友好的错误提示

2. **Vercel 版本缺少此功能**：
   - 只是简单传递 sessionId，没有自动创建机制
   - 没有 session 就无法建立有效连接

## 🛠️ 修复方案

### 1. 添加 autoInitializeSession 函数

在 `src/lib/upstream.js` 中添加了自动初始化功能：

```javascript
async function autoInitializeSession(extraHeaders = {}) {
  // 向上游发起 initialize 请求
  // 获取 sessionId 和服务器信息
  // 返回初始化结果
}
```

### 2. 修改 SSE 处理逻辑

在 `api/sse.js` 和 `api/mcp.js` 中添加 session 自动初始化：

```javascript
// 如果未携带 sessionId，尝试自动初始化获取
if (!sessionId) {
  writeEvent(res, 'info', { msg: 'no_session_provided_attempting_initialize' });
  const init = await autoInitializeSession(upstreamCfg.headersJson);
  if (init.ok && init.sessionId) {
    sessionId = String(init.sessionId);
    writeEvent(res, 'info', { msg: 'auto_session_created', sessionId });
  }
}
```

### 3. 支持 GET 请求的 SSE 模式

为 `api/mcp.js` 添加了 GET 方法支持，使其能够处理 SSE 连接。

## 🧪 测试方法

```bash
# 本地测试（使用原版 success.js）
npm run dev

# 测试连接
npm test
```

## 📋 部署注意事项

1. **环境变量配置**：
   ```
   UPSTREAM_URL=https://your-mcp-server.com/mcp
   UPSTREAM_SSE_URL=https://your-mcp-server.com/sse  # 可选
   UPSTREAM_HEADERS_JSON={"Authorization":"Bearer token"}  # 如果需要认证
   ```

2. **Vercel 限制**：
   - Serverless 函数有执行时间限制（maxDuration: 60秒）
   - SSE 长连接可能会被中断，需要重连机制
   - 无状态环境，无法保持持久连接

## 🔧 后续优化建议

1. **添加更多调试日志**，方便排查问题
2. **优化重连策略**，适应 Vercel 环境
3. **考虑使用 Edge Functions** 替代 Serverless Functions
4. **添加连接池管理**，提高性能

## 📚 相关文件

- `src/lib/upstream.js` - 上游连接管理
- `api/sse.js` - SSE 接口处理
- `api/mcp.js` - MCP 接口处理
- `test-connection.js` - 连接测试脚本