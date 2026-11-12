# dot · pi workspace

一个可以在 ChatGPT 外运行的私人中文聊天平台。浏览器界面 + Node.js 后端，使用 **pi 官方 `@earendil-works/pi-agent-core` / `pi-ai`**，不是套壳模拟回复。

> 这是独立部署的助手，不是 ChatGPT 内同一个 dot 的远程入口。不会同步这里的会话、记忆、连接器、提醒或账户权限；ChatGPT 订阅也不包含本应用的模型 API 费用。需要你自己的模型 API key。首版没有联网搜索、交易、命令执行或后台提醒工具。

## 功能

- 桌面 / 手机自适应界面，中文优先，流式输出与停止生成。
- 多会话、服务端持久化、JSON 导出与确认删除。
- 访问口令登录，HttpOnly / SameSite cookie；密钥永远留在服务端。
- 配置模型和提供商；默认 OpenAI `gpt-4o-mini`。
- Docker、基础 CI 与不消耗模型额度的集成测试。

## 5 分钟本地启动

需要 Node.js 24（最低 22，建议 24）。

```bash
git clone https://github.com/Alex-Cross-one/piagent-chat.git
cd piagent-chat
npm ci
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

把生成的随机字符串写入 `.env` 的 `CHAT_ACCESS_TOKEN`，把自己的 API key 写入 `PI_API_KEY`。不要把密钥发到聊天、写入源码或提交到 GitHub。

```bash
npm start
```

打开 http://localhost:3000，用 `CHAT_ACCESS_TOKEN` 登录。

`PI_PROVIDER` / `PI_MODEL` 必须是 pi 模型目录中的有效组合。默认模型只是低成本起点，可自行换成所用提供商支持的型号。可以运行以下命令查看目录：

```bash
node --input-type=module -e "import {getBuiltinModels} from '@earendil-works/pi-ai/providers/all'; console.log(getBuiltinModels('openai').map(m=>m.id).join('\n'))"
```

## Docker 与远程访问

```bash
docker compose up -d --build
```

默认只绑定主机 `127.0.0.1:3000`。远程访问需要你自己的服务器与域名，并在前方配置 HTTPS 反向代理（例如 Caddy）。不要直接把未加密 HTTP 端口暴露到公网。

Caddy 示例（替换为你控制的域名）：

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

设 `COOKIE_SECURE=true` 后重启应用；代理必须保留原 Host，关闭 SSE 缓冲并允许至少 120 秒请求。反向代理、域名、TLS 和公网部署需另外配置，本仓库上传不代表已经部署上线。GitHub Pages 无法运行此 Node.js 后端。

## 数据与安全边界

- 单人部署设计：持有同一访问口令的人能查看/删除全部会话。不是多租户系统。
- 会话以 JSON 明文存入 `data/`（Docker 使用持久卷），不提交仓库。请保护服务器、加密磁盘并定期备份。应用删除不等于删除备份。
- 口令只保存在服务端配置；会话 cookie 有效 24 小时，重启后失效。登录有基本频率限制，但公网建议额外使用反向代理限流。
- 模型提供商会收到本次输入与最近最多 40 条成功历史消息；本地保存完整聊天。较早内容不进入上下文，没有自动记忆。请先了解提供商数据政策。
- 对话错误细节不直接展示，避免暴露密钥；没有 shell/文件访问工具。输出按纯文本显示，不执行模型返回的 HTML。
- 每次生成最多 120 秒；最多并发 3 个会话。API 用量由提供商计费，请设置额度限制。
- `.env`、`data/`、依赖目录已忽略。不要把真实配置加入 Git。

## 验证

```bash
npm run check
npm test
npm audit --omit=dev
```

测试覆盖登录、未授权访问、跨源请求阻止、会话创建/读取/删除、SSE、持久化及输入校验，使用模拟 agent，不调用真实模型。真实 API 的回答质量、账单及联网可用性需要配置你的 API key 后验证。

## 架构与来源

`public/` 无构建步骤静态前端 → `server.js` Express API / SSE → pi `Agent` → 模型提供商。

- pi 官方项目：https://github.com/earendil-works/pi
- agent 核心：https://www.npmjs.com/package/@earendil-works/pi-agent-core
- 模型层：https://www.npmjs.com/package/@earendil-works/pi-ai

旧 `@mariozechner` 包已由 npm 标记迁移到 `@earendil-works`，本项目采用新包名并锁定依赖版本。
