# dot message bridge · piagent-chat

**目标：在自己的网页给当前同一个 dot 发消息，并接收它的回复。不是用另一个模型冒充 dot。**

默认 `CHAT_MODE=bridge`。本版提供经认证的 MCP Events 消息桥接原型。**代码和本地协议测试完成，不等于已连接你的 dot**：需要部署/隧道、OAuth 配置、安装插件，并在当前 dot 中订阅及验证真实往返。

## 工作方式

```
外部网页 → 已登录的私人服务端 → message.created webhook
                                      ↓
                               当前 dot 的订阅聊天
                                      ↓
                 bridge_read_message / bridge_reply
                                      ↓
                             网页异步显示回信
```

- 网页发送的内容由服务端存储。事件只携带消息 ID，由 dot 通过读取工具获取内容。
- dot 自己调用回信工具，网页轮询显示实际回信。不会调用 pi 模型自动替代 dot 回复。
- 支持新会话、持久化、导出、确认删除、手机布局。
- 订阅采用标准 webhook 签名、回调挑战验证、幂等订阅/回信、持久队列、限次重试、到期停止。
- 回调仅允许公网 HTTPS，DNS 解析后固定连接 IP，拒绝私网和重定向。
- OAuth JWT 校验 issuer / audience / signature / scope / owner subject；网页口令和 MCP OAuth 分离。
- 首版是异步消息通道，不是逐 token 的原生 dot API，不镜像 ChatGPT 全量聊天。会话和能力留在真正的 dot 中，不导出内部记忆。

## 当前状态与边界

本地模拟了浏览器发送 → 签名通知 → MCP 读取 → 幂等回信 → 网页可读取的完整协议链，使用测试认证/测试回调。**未完成真实 ChatGPT 插件安装、真实 OAuth 提供商联调、dot 事件订阅及回信验证**。浏览器图形测试也受当前构建环境限制未完成。

MCP Events 官方文档明确支持 dots，但实际可用性仍取决于账户/工作区设置。`2xx` 仅代表 webhook 收到，不表示 dot 已回复；界面会区分未连接、已订阅未验证、收到回信。插件被绑定到哪个聊天，必须由用户在那个聊天明确订阅并通过测试码确认。协议本身不提供可验证的 dot 身份标识。

## 本地查看界面

需要 Node.js 24（建议）或 22。

```bash
npm ci
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

把随机字符串写入 `.env` 的 `CHAT_ACCESS_TOKEN`，然后 `npm start`，打开 http://localhost:3000。此时可以查看界面、保存消息，但未订阅的消息**不会送达 dot**，连接后需手动重发。不要把这种状态当作可用聊天室。

## 接通真正的 dot

详见 [部署与接通步骤](docs/CONNECT_DOT.md)。至少需要：

1. 持续运行 Node 服务，并有公开 HTTPS 地址，或官方支持的 Secure MCP Tunnel。
2. 配置兼容 MCP 的 OAuth 2.1 授权服务器及单一用户 subject。此仓库校验 JWT，不内置授权服务器或伪造登录。
3. 在 ChatGPT Plugins 添加自定义 MCP 服务并授权；发现 `message.created`、读取和回信工具。
4. 在**要继续对话的那个 dot 聊天**明确订阅并授权该消息通道的读取与回复。
5. 网页发送随机测试码，确认同一个 dot 收到并通过回信工具返回。直到这一步完成才能称为接通。

桥接模式不需要 `PI_API_KEY`，也不利用 ChatGPT 网页 cookie、内部接口或会话抓取。

## pi agent 的作用

依然包含官方 pi agent 的独立模式，方便开发及回归测试：显式设置 `CHAT_MODE=standalone` 并配置 `PI_API_KEY` / `PI_PROVIDER` / `PI_MODEL`。该模式使用 `@earendil-works/pi-agent-core` 1.5.2，**不是当前 dot**，不会自动同步其记忆/提醒/工具；界面会标记独立模型回复。生产默认桥接模式不会调用它。

不把 pi 的输出伪装成当前 dot，也不以购买 API 额度代替真正的 dot 接入。

## 部署

```bash
docker compose up -d --build
```

Docker 默认绑定 `127.0.0.1:3000`。在前方配置 HTTPS 反向代理，例如 Caddy；设置 `COOKIE_SECURE=true`。MCP、OAuth metadata、网页都必须可达。反向代理保留 Host，SSE 不缓冲。不要直接开放明文端口。

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

GitHub Pages 无法运行后端。仓库上传不等于部署上线。当前单进程文件存储设计，不要启动多个副本共享同一数据目录。

## 安全和运维

- 单人服务：持有网页访问口令的人能读写全部会话。保护口令、服务器和备份。
- `data/` 中明文存储会话、订阅回调和签名密钥，文件权限受限且被 git 忽略；建议加密磁盘，切勿公开挂载或提交这些文件。
- OAuth 配置只接受单一 `MCP_OWNER_SUBJECT`，scope 为 `bridge`，JWT audience 必须严格匹配 `MCP_RESOURCE_URL`。
- OAuth 授权服务器负责登录、PKCE、令牌签发和客户端注册；本应用只做 JWT 校验，不支持 opaque token。撤权后应取消订阅并重启服务/更改 owner 或设 `BRIDGE_DELIVERY_ENABLED=false`，以立即停止旧订阅。JWT 离线验证不能即时感知授权服务器的令牌撤销。
- 订阅最多 24 小时，客户端需要刷新；秘密轮换有短重叠窗口。订阅重启后保留。
- 每条事件最多 5 次尝试，指数退避；410/413 不重试。无回放 cursor，断连时或未订阅时保存的消息不会自动重发。事件可能乱序或重复，回信工具以幂等键避免重复。
- 只部署一个实例；定期备份。文件存储跨文件操作不是事务数据库，极端崩溃时可能需要人工重发。
- 外部消息是数据，不自动授予 dot 执行高影响操作的权限。付款、发布、敏感数据等仍遵守 dot 的确认规则。

## 验证

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
```

测试包含：鉴权、CSRF、持久化、真实 pi Agent 模拟流；MCP 发现、订阅幂等、挑战失败、标准签名、稳定事件 ID 重试、读取/回信、回信去重、重启持久化、取消订阅、回调地址防护。模拟测试不等同于真实 dot 接通。

## 官方资料

- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [MCP 认证](https://developers.openai.com/plugins/build/auth)
- [连接与测试插件](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [pi 官方项目](https://github.com/earendil-works/pi)

## Sites 私有托管版

新增 [sites/](sites/) Worker + D1 移植，网页和 MCP 由平台身份保护，无需另配 OAuth 提供商。私有网页已发布：https://dot-private-message-bridge.fizzy-tulip-7700.chatgpt.site 。**插件安装、当前 dot 的 Events 订阅和真实随机码往返尚未验收，不能当作已接通。** 根目录的 Node 原型继续保留。
