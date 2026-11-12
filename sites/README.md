# dot 私人消息桥 · Sites 版

目标：在 ChatGPT Desktop 外的私人网页与原来的 dot 对话，不用独立模型冒充 dot。

本目录是独立的 Cloudflare Worker / D1 移植，不替换仓库根目录的 Node 原型。运行时由 Sites 保护为 owner-private，网页和 MCP 均使用平台注入的站点用户身份；所有数据库查询按该身份隔离。无需在仓库放置 OAuth client secret、API key 或网页共享口令。

## 当前验收状态

- Worker / D1 逻辑和 MCP Events 协议模拟测试通过。
- 私人 Site 已成功发布，MCP 插件已安装，真实 bridge_status 可调用；事件订阅尚未通过。
- 网页：https://dot-private-message-bridge.fizzy-tulip-7700.chatgpt.site （仅所有者可访问）。
- **尚未完成真实 dot 的订阅、回调与随机码往返，不算接通。**
- 不调用模型 API，不使用 ChatGPT 浏览器 cookie 或内部接口，不导出 dot 的内部记忆。

## 开发验证

Node.js 24，无额外运行依赖：

```sh
npm run check
npm test
npm run build
npm run validate
```

测试使用 SQLite 实际执行迁移并模拟 D1 API，覆盖身份缺失、跨 owner 隔离、CSRF、MCP 发现、签名挑战、重试队列、幂等回信、取消订阅竞态、密钥轮换和外键约束。模拟协议链不等于真实 dot 接通。生产 Worker 没有认证绕过开关。

## 发布

沿用 `.openai/hosting.json` 中已经注册的 Site 身份；不要重复创建 Site，也不要改动已有的其他站点。通过 Sites 官方 source / save / deploy 流程发布。`drizzle/` 是部署前执行的 schema-only D1 迁移，未在请求处理中创建表。

- `capabilities: ["mcp"]` 使 Sites 发布私人 MCP 插件。
- Sites 负责访问控制和 MCP OAuth，不部署第二套授权服务器。
- `worker/index.js` 同时包含页面、资源和 API。构建复制为 `dist/server/index.js`。
- 原型的永久删除仅在网页明确确认后执行。

## 接通和真实验收

1. 发布后检查私人 Site 的 MCP connection 和生成的插件。
2. 确认插件发现 `bridge_status`、`bridge_read_message`、`bridge_reply`、`message.created`。
3. 回到要继续对话的那个 dot，明确授权订阅 `message.created`，`channel_id=owner`，并通过 `bridge_reply` 回复此网页的普通对话。对其他外部动作的批准仍按原规则处理。
4. 验证服务器收到真实 `events/subscribe`、挑战验证成功，并保存订阅。
5. 网页发送新的随机测试码，核对原来的 dot 读取并实际调用回信工具返回该码。
6. 再测停止订阅、重连和重复事件去重。

Webhook 的 2xx 只表示收到事件，不能当作 dot 已回复。收到 MCP 回信也不能替代在指定 dot 对话中核对随机码。

## 安全边界与限制

- 网页在未订阅时只保存消息，连接后不自动补发旧消息。
- Callback 严格限定为 HTTPS 的 `chatgpt.com`、`api.openai.com` 或 `connectors.api.openai.com`，拒绝凭证、非标准端口和重定向。Worker 不使用可由订阅方任意选择的域名，因此不需要接受任意 DNS 目标。`connectors.api.openai.com` 已由实际平台订阅请求确认。若实际 OpenAI callback 使用其他 hostname，默认拒绝并报告；先核实其来源和所有权再改 allowlist，绝不为跑通而移除限制。
- 签名使用 Standard Webhooks HMAC-SHA256。签名秘密只存在服务端 D1，不发到网页、不写日志或源代码。订阅更新使用 revision 防止取消后被在途验证重新激活。
- 订阅最多 24 小时，需要客户端刷新。取消订阅后停止新的投递，但已经在途或已被接收的事件无法撤回。
- Outbox 持久存储，最多尝试 5 次；410、413、重定向不重试。请求触发队列处理，网页打开时轮询会推动重试，**关闭网页后不保证无人值守重试**。
- 首版无 exactly-once、旧事件回放或高可用承诺。回复通过唯一约束去重。删除会话级联删除消息和 outbox。
- 数据容量限制：100 个会话、每会话 1000 条消息，每分钟最多 30 条用户消息。
- 保持 owner-private。改变分享设置前需重新审查身份、数据与 MCP 权限边界。

## 官方资料

- https://developers.openai.com/plugins/build/mcp-events
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
