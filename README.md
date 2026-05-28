# Qwen-2API

将 [Qwen](https://chat.qwen.ai) 网页版聊天接口转换为 **OpenAI 兼容 API** 的反向代理服务。

## 功能特性

- **OpenAI 兼容格式** — 支持 `/v1/chat/completions` 和 `/v1/models` 端点，可直接对接支持 OpenAI API 的客户端
- **流式/非流式响应** — 完整支持 SSE 流式输出和一次性返回两种模式
- **多账号令牌池** — 支持配置多个 Qwen 账号/令牌，自动负载均衡与故障转移
- **并发控制与请求队列** — 每个令牌最大 10 并发，超出时自动排队（队列上限 100）
- **多模态能力** — 通过模型后缀支持思考、深度研究、图片生成、视频生成、网页开发、PPT 等模式
- **令牌自动刷新** — 配置账号密码后，令牌过期时自动重新登录
- **Web 管理面板** — 内置可视化管理界面，实时查看令牌池状态、队列情况及可用模型
- **独立管理密码** — 管理面板使用独立的 `ADMIN_PASSWORD`，与 API Key 完全分离
- **多 API Key** — 支持配置多个 API Key，可通过 Web 面板动态增删，即时生效
- **热加载** — 令牌、API Key 的增删操作即时生效，无需重启服务，自动持久化到 `.env`
- **自动注册脚本** — 附带 Playwright 自动注册工具（`qwen-register.js`）

## 项目结构

```
├── src/
│   ├── index.js       # 应用入口，Express 服务器与路由配置
│   ├── auth.js        # 令牌池管理、多 API Key 管理、登录、刷新、并发控制
│   ├── admin-auth.js  # 管理面板独立密码认证模块
│   ├── chat.js        # Qwen API 对话接口（创建会话、发送消息、SSE 解析）
│   ├── openai.js      # OpenAI 格式适配层（请求转换、流式/非流式响应）
│   ├── models.js      # 模型列表获取与 OpenAI 格式转换
│   ├── headers.js     # 请求头管理（模拟浏览器环境）
│   └── queue.js       # 请求排队机制
├── frontend/
│   ├── index.html     # 管理面板前端页面
│   └── index.js       # 前端备用入口（独立 Express 服务）
├── qwen-register.js   # Qwen 账号自动注册脚本（Playwright）
├── Dockerfile         # Docker 镜像构建文件
├── docker-compose.yml # Docker Compose 编排文件
├── .dockerignore      # Docker 构建排除文件
├── package.json
├── .env.example       # 环境变量示例
└── .gitignore
```

## 快速开始

### 环境要求

- Node.js >= 18（需要原生 `fetch` 支持）

### 安装

```bash
git clone https://github.com/qing1189/qwen2026528.git
cd qwen2026528
npm install
```

### 配置

复制环境变量模板并编辑：

```bash
cp .env.example .env
```

`.env` 文件支持以下配置项：

| 变量 | 说明 | 示例 |
|------|------|------|
| `QWEN_ACCOUNTS` | Qwen 账号（邮箱:密码），多个用逗号分隔 | `email1:pass1,email2:pass2` |
| `QWEN_TOKENS` | 直接提供 JWT 令牌，多个用逗号分隔 | `eyJ...,eyJ...` |
| `API_KEYS` | 多个 API Key，逗号分隔（也可通过面板动态管理） | `sk-key1,sk-key2` |
| `API_KEY` | 兼容旧配置，单个 API Key（会自动合并到 API_KEYS） | `sk-your-key` |
| `ADMIN_PASSWORD` | 管理面板独立密码（与 API Key 分离） | `my-admin-pwd` |
| `PORT` | 服务端口，默认 3000 | `3000` |

> - `QWEN_ACCOUNTS` 和 `QWEN_TOKENS` 至少配置一个。使用账号密码时服务会自动登录获取令牌并在过期后自动刷新。
> - `API_KEYS` 未设置时所有 API 请求无需认证；设置后需携带有效 Key。
> - `ADMIN_PASSWORD` 未设置时管理面板无需密码即可访问。

### 启动

```bash
# 生产模式
npm start

# 开发模式（自动重载）
npm run dev
```

启动后访问：
- 管理面板：`http://localhost:3000/admin`
- 健康检查：`http://localhost:3000/`

## API 使用

### 聊天补全

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{
    "model": "qwen-plus-latest",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 获取模型列表

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer sk-your-key"
```

### 模型后缀

通过在模型名称后添加后缀来启用不同能力：

| 后缀 | 模式 | 说明 |
|------|------|------|
| `-thinking` | 思考模式 | 启用深度推理，输出 `reasoning_content` |
| `-deep-research` | 深度研究 | 联网搜索 + 多步研究 |
| `-image` / `-t2i` | 图片生成 | 文本生成图片 |
| `-video` / `-t2v` | 视频生成 | 文本生成视频 |
| `-webdev` / `-web-dev` | 网页开发 | 生成网页代码 |
| `-slides` | PPT 生成 | 生成演示文稿 |

示例：
```bash
# 使用思考模式
"model": "qwen-plus-latest-thinking"

# 生成图片
"model": "qwen-plus-latest-image"

# 深度研究
"model": "qwen-plus-latest-deep-research"
```

### 额外参数

请求体中可传入以下非标准参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `enable_thinking` | boolean | 强制开启思考模式 |
| `enable_search` | boolean | 强制开启联网搜索 |

## 管理面板

访问 `/admin` 可使用内置管理面板，功能包括：

- 实时查看服务状态、总容量、账号数、队列信息和 API Key 数量
- 令牌池详情（状态、过期时间、错误数、并发数）
- 可用模型列表及能力标签
- **API Key 管理** — 查看、添加、删除 API Key（即时生效，自动持久化）
- 手动添加 JWT 令牌
- 通过邮箱密码登录添加令牌
- 自动刷新（5秒/10秒/30秒可选）

### 认证说明

管理面板使用独立的 `ADMIN_PASSWORD` 认证，**与 API Key 完全分离**：

- **管理面板** → 使用 `ADMIN_PASSWORD` 登录
- **API 接口** (`/v1/*`) → 使用 `API_KEYS` 中的任一 Key

这样即使 API Key 泄露，攻击者也无法访问管理面板；管理员也无需知道具体的 API Key 即可管理服务。

## 自动注册

项目附带 `qwen-register.js` 脚本，可自动注册 Qwen 账号：

```bash
# 自动生成临时邮箱注册
node qwen-register.js

# 使用指定邮箱密码注册
node qwen-register.js your@email.com your_password
```

> 需要安装 Playwright：`npx playwright install chromium`

## 架构说明

```
客户端请求 (OpenAI 格式)
        │
        ▼
   [API Key 验证]
        │
        ▼
   [请求队列] ←── 无可用令牌时排队等待
        │
        ▼
   [令牌池] ←── 负载均衡，选择活跃请求最少的令牌
        │
        ▼
   [OpenAI → Qwen 格式转换]
        │
        ▼
   [Qwen Web API] ←── 创建会话 → 发送消息 → SSE 流式响应
        │
        ▼
   [SSE 解析 & OpenAI 格式输出]
        │
        ▼
   客户端接收响应
```

### 核心机制

- **令牌池**：每个令牌支持最多 10 个并发请求，自动选择负载最低的令牌
- **错误计数**：连续错误 3 次的令牌将被暂时排除
- **队列系统**：所有令牌满载时请求进入队列，有空闲时自动派发
- **令牌持久化**：新增令牌会自动写入 `.env` 文件

## Docker 部署

### 快速启动

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 Qwen 账号或令牌

# 2. 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止服务
docker compose down
```

### 单独构建镜像

```bash
# 构建
docker build -t qwen-2api .

# 运行
docker run -d \
  --name qwen-2api \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  qwen-2api
```

### 端口配置

- 容器内部固定监听 `3000` 端口
- 通过 `.env` 中的 `PORT` 变量控制宿主机映射端口（默认 `3000`）
- 如需修改宿主机端口，修改 `.env` 中 `PORT=8080` 即可

## 许可证

MIT
