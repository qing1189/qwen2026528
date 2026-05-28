# Qwen-2API

将 [Qwen](https://chat.qwen.ai) 网页版聊天接口转换为 **OpenAI 兼容 API** 的反向代理服务。

## 功能特性

- **OpenAI 兼容格式** — 支持 `/v1/chat/completions` 和 `/v1/models` 端点
- **工具调用 (Function Calling)** — 支持 OpenAI 格式的 `tools` 参数，通过 DSML 协议实现
- **流式/非流式响应** — 完整支持 SSE 流式输出和一次性返回
- **多账号令牌池** — 多个 Qwen 账号/令牌，自动负载均衡与故障转移
- **并发控制与请求队列** — 每令牌最大 10 并发，超出自动排队（上限 100）
- **多模态能力** — 通过模型后缀支持思考、深度研究、图片生成、视频生成等
- **令牌自动刷新** — 配置账号密码后过期自动重新登录
- **令牌健康检测** — 单个/批量检测令牌有效性
- **Web 管理面板** — 可视化管理令牌池、API Key、队列状态
- **独立管理密码** — 管理面板使用独立 `ADMIN_PASSWORD`，与 API Key 分离
- **多 API Key 热加载** — 支持多个 API Key，通过面板动态增删，即时生效
- **热加载持久化** — 所有变更自动写入 `.env`，重启不丢失

## 架构

```
客户端请求 (OpenAI 格式)
        │
        ▼
   [API Key 验证] ←── 多 Key 支持，热加载
        │
        ▼
   [工具调用注入] ←── tools → DSML prompt 注入
        │
        ▼
   [请求队列] ←── 无可用令牌时排队等待
        │
        ▼
   [令牌池] ←── 负载均衡，选择最低负载令牌
        │
        ▼
   [Qwen Web API] ←── 创建会话 → 发送消息 → SSE 流
        │
        ▼
   [SSE 解析 + 工具调用提取]
        │
        ▼
   客户端接收 OpenAI 格式响应
```

## 项目结构

```
├── src/
│   ├── index.js        # Express 服务器与路由
│   ├── auth.js         # 令牌池、多 API Key、登录刷新、并发控制
│   ├── admin-auth.js   # 管理面板独立密码认证
│   ├── chat.js         # Qwen API 对话（创建会话、SSE 解析）
│   ├── openai.js       # OpenAI 格式适配（请求转换、流式响应）
│   ├── toolcall.js     # 工具调用 DSML 协议（注入 & 解析）
│   ├── models.js       # 模型列表与格式转换
│   ├── headers.js      # 请求头伪装
│   └── queue.js        # 请求排队
├── frontend/
│   └── index.html      # 管理面板
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── .dockerignore
```

## Docker 部署

### 1. 克隆项目

```bash
git clone https://github.com/qing1189/qwen2026528.git
cd qwen2026528
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

| 变量 | 说明 | 示例 |
|------|------|------|
| `QWEN_ACCOUNTS` | Qwen 账号（邮箱:密码），逗号分隔 | `a@b.com:pass1,c@d.com:pass2` |
| `QWEN_TOKENS` | JWT 令牌，逗号分隔 | `eyJ...,eyJ...` |
| `API_KEYS` | 多个 API Key，逗号分隔 | `sk-key1,sk-key2` |
| `API_KEY` | 兼容旧配置，单 Key | `sk-your-key` |
| `ADMIN_PASSWORD` | 管理面板密码 | `my-admin-pwd` |
| `PORT` | 宿主机映射端口 | `3000` |

> - `QWEN_ACCOUNTS` 和 `QWEN_TOKENS` 可都不配置，启动后通过面板添加
> - `API_KEYS` 未设置时 API 无需认证
> - `ADMIN_PASSWORD` 未设置时面板无需密码

### 3. 启动

```bash
docker compose up -d --build
```

### 4. 常用命令

```bash
# 查看日志
docker compose logs -f

# 停止
docker compose down

# 重新构建（代码更新后）
docker compose up -d --build
```

### 5. 访问

- **管理面板**: `http://your-ip:3000/admin`
- **API 端点**: `http://your-ip:3000/v1/chat/completions`
- **模型列表**: `http://your-ip:3000/v1/models`
- **健康检查**: `http://your-ip:3000/`

### 6. 数据持久化

`docker-compose.yml` 将宿主机的 `.env` 文件映射到容器内：

```yaml
volumes:
  - ./.env:/app/.env
```

通过面板添加的令牌和 API Key 会实时写入 `.env`，迁移时只需拷贝整个项目目录。

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

### 工具调用 (Function Calling)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{
    "model": "qwen-plus-latest",
    "messages": [{"role": "user", "content": "北京今天天气怎么样"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "获取指定城市天气",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    }]
  }'
```

### 模型后缀

| 后缀 | 说明 |
|------|------|
| `-thinking` | 深度推理，输出 `reasoning_content` |
| `-deep-research` | 联网搜索 + 多步研究 |
| `-image` / `-t2i` | 文本生成图片 |
| `-video` / `-t2v` | 文本生成视频 |
| `-webdev` | 生成网页代码 |
| `-slides` | 生成 PPT |

### 额外参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `enable_thinking` | boolean | 强制开启思考模式 |
| `enable_search` | boolean | 强制开启联网搜索 |

## 管理面板

访问 `/admin`，功能包括：

- **总览** — 状态、容量、账号数、队列、API Key 数
- **令牌管理** — 添加 JWT / 邮箱密码登录 / 删除 / 健康检测
- **API Key** — 增删管理，即时生效
- **模型** — 查看可用模型及能力标签

## 许可证

MIT
