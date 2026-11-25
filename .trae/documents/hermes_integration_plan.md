# Hermes Agent 集成方案（Serverless 版）

## Repository Research

### 当前架构
```
[小程序 pages/assistant] → wx.cloud.callFunction → [cloudfunctions/chat] → 硅基流动 /chat/completions
                                                              ↑
[小程序 本地工具执行] ← utils/agent.js 循环 ← utils/agentTools.js（4 个本地工具，直接读 travelStore/wardrobeStore 等）
```

核心事实：
- LLM Key 已隐藏在云函数环境变量，客户端拿不到。
- Agent 循环在客户端 JS 实现（`utils/agent.js`），最多 3 轮工具调用、单工具 8s 超时。
- 工具分两种：读公开数据（searchAttractions 用本地 358 条 5A 数据）、读用户数据（直接查本地 store，能看到尚未 sync 的）。
- `travelStore / wardrobeStore / memoryStore / diaryStore` 全部是「本地优先 + syncPending」，云端集合分别叫 `travel.marks`、`wardrobe.items`、`travel.memories`、`diary.entries`。
- 小程序云函数有 60s 上限；个人主体无 AI 问答类目，生产构建自动剥离 AI 页面。
- 当前 LLM provider 是硅基流动 DeepSeek-V4-Flash。

### Hermes Agent 是什么
Nous Research 2026 年开源的 Python Agent 框架（42K GitHub stars），核心能力：

| 能力 | Hermes | 当前 |
|---|---|---|
| Agent 循环 | 服务端，原生多轮工具调用 | 客户端 JS，最多 3 轮 |
| 内置工具 | 70+（web_search、browser、vision、image_gen、terminal、file...） | 4 个本地工具 |
| 模型来源 | OpenAI 兼容任意端点，也可配 Nous Portal 订阅 | 硅基流动固定 |
| 状态管理 | `/v1/responses` 用 previous_response_id 或 conversation 维持会话 | 客户端拼 history |
| 流式事件 | SSE：token delta + `hermes.tool.progress` + `function_call` / `function_call_output` | 打字机泵，工具步骤靠客户端回调 |
| 停止/中断 | `POST /v1/runs/{id}/stop` | 客户端 `runSeq` 失效 |
| 审批流 | 服务端→客户端请求（approval / clarify） | 客户端 JS 直接 confirm |
| 持久记忆 | 跨会话 Honcho memory + 技能自动创建/自我改进 | 无 |
| 部署方式 | **Python 容器**（Docker 镜像 `nousresearch/hermes-agent:latest`）| CloudBase 云函数（Node.js）|
| 语言 | Python | 纯 JS |

## 架构决策

### 为什么不保留当前 JS 循环、只把 Hermes 当 LLM 后端
Hermes 的核心价值是**服务端 Agent 循环 + 70+ 内置工具 + SSE 事件流**。只换 LLM 后端等于什么都没换。

### 部署选型：CloudBase 云托管（不是 VPS）

腾讯云 CloudBase 云托管（Cloud Run）是跟你现有账号同生态的 serverless 容器服务：

| 选项 | 费用 | 闲置费用 | 你需要做什么 |
|---|---|---|---|
| ~~Lighthouse VPS~~ | ~~70元/月~~ | ~~70元/月~~ | ~~买服务器 + 装 Hermes + 运维~~ |
| **CloudBase 云托管（推荐）** | CPU/内存/调用次数按量计费 | **缩容到 0，零费用** | 写 Dockerfile → 上传镜像 → 配置伸缩策略 |
| Modal | $30/月免费额度，之后按秒 | 闲置几乎零 | 注册海外账号，Docker push |
| Daytona | 类似 Modal | 闲置几乎零 | 注册海外账号 |

**云托管的优势**：
1. 跟你已有 CloudBase 环境**完全同域**，云函数内调 Hermes API 不需要任何域名白名单
2. 自带 HTTPS 域名，小程序 request 白名单加一条就行
3. 缩容到 0 → 闲置时不花一分钱
4. Docker 镜像 `nousresearch/hermes-agent:latest` 直接可用
5. 控制台在你熟悉的 CloudBase 页面里，不用额外登录新平台

### 最终架构

```
┌─ 小程序 ──────────────────────────────────────────────────┐
│ pages/assistant                                             │
│   onSend → 优先：wx.cloud.callFunction('hermesBridge')     │
│            → （云函数内部 proxy 到 Hermes 容器）           │
│                                                             │
│   兜底：callFunction('chat') + 本地 agent.js 循环           │
│                                                             │
│   写入路径：客户端 → 本地 store → syncPending → 云端集合   │
└────────────────────────────────────────────────────────────┘
            │                              │
    云函数 hermesBridge          云函数 chat（降级）
    ┌──────────────────┐
    │ 认证 + 转发 + SSE │
    │ proxy + 结果缓存  │
    │ _openid 注入      │
    └────────┬─────────┘
             ↓
    ┌─ CloudBase 云托管 ──────────────────────────────────┐
    │ Docker: nousresearch/hermes-agent:latest            │
    │                                                       │
    │ 内置 API Server 监听 :8642                           │
    │   /v1/chat/completions                               │
    │   /v1/responses                                      │
    │   /v1/runs + /v1/runs/{id}/events + /v1/runs/{id}/stop │
    │                                                       │
    │ 启用的工具集：                                        │
    │   ✓ web_search     ✓ vision_analyze                   │
    │   ✓ image_generate ✓ text_to_speech                   │
    │   ✓ memory         ✓ skills                           │
    │                                                       │
    │ 禁用的工具集（安全红线）：                            │
    │   ✗ terminal   ✗ browser   ✗ file                    │
    │   ✗ process    ✗ patch                                    │
    │                                                       │
    │ 自定义工具（Python）：                                │
    │   searchAttractions  — 读本地 358 条 5A JSON         │
    │   getFootprint        — 查 CloudBase travel.marks    │
    │   getWardrobe         — 查 CloudBase wardrobe.items  │
    │   getMemories         — 查 CloudBase travel.memories │
    │   saveDiaryDraft      — 只返回草稿 JSON              │
    │                                                       │
    │ LLM 后端：硅基流动（继续，或随时切 Nous Portal）    │
    │                                                       │
    │ 存储：                                                │
    │   ~/.hermes/ 持久化（容器实例内，重启会丢）           │
    │   → 持久化方案：CloudBase 对象存储 COS 挂载为卷      │
    └───────────────────────────────────────────────────────┘
```

### 关键设计决定
1. **Hermes 容器通过云函数访问 CloudBase 集合**：Python 工具用 `cloudbase-admin` SDK 直接按 `_openid` 查集合。或者 Hermes 工具调云函数（`wx.cloud.callFunction` 的 HTTP 兼容层）。优先 Python SDK，少一跳。
2. **云函数代理**：hermesBridge 不自己跑 agent 循环，只做认证 + HTTPS 转发 + 流式代理。好处是 Hermes 地址不需要在小程序 request 白名单里（云函数内部调用不算）。
3. **本地工具保留作降级**：Hermes 容器冷启动或不可用时，切回原 `chat` 云函数 + 本地 `agent.js` 循环。
4. **写入操作仍由客户端确认**：Hermes 端 saveDiaryDraft 工具只返回 `{requiresConfirm: true, date, text, existing}`，客户端渲染确认卡后才写本地 store → syncPending。
5. **Hermes 持久化**：容器内 `~/.hermes/` 是临时文件，实例重启会丢。两种解法：(a) 关闭缩容到 0（常驻一个实例，增加费用但持久）；(b) 把 `~/.hermes/` 映射到 CloudBase 对象存储 COS 做卷挂载。个人自用场景建议先常驻 1 个实例（每月几块钱）。
6. **禁用高风险工具集**：terminal、browser、file、process、patch **必须禁用**，否则 Hermes 内置的 shell/file 操作能在容器里执行任意命令。

## Files and Modules

### 新增：Docker + Hermes 配置（不在现有目录）
- `server/Dockerfile` — 基于 `nousresearch/hermes-agent:latest`，加 Python 自定义工具 + CloudBase SDK + COS 卷挂载配置
- `server/hermes-config/.env` — `API_SERVER_ENABLED=true`、`API_SERVER_KEY`、硅基流动 API Key、CloudBase serverSecret
- `server/hermes-config/config.yaml` — 启用 API Server、启用哪些工具集（白名单）、禁用 terminal/file/browser/patch
- `server/hermes-config/SOUL.md` — 旅行助手人设（「南山工作台」旅行与生活助手，查景点、看足迹、配穿搭、写日记）
- `server/hermes-tools/attractions.py` — 自定义工具：searchAttractions（从 `attractions-5a.json` 加载 358 条数据）
- `server/hermes-tools/cloudbase_reader.py` — 自定义工具：getFootprint / getWardrobe / getMemories（按 `_openid` 查集合）
- `server/hermes-tools/save_draft.py` — 自定义工具：saveDiaryDraft（只返回草稿 JSON，不落库）
- `server/hermes-config/attractions-5a.json` — 从 `assets/data/attractions-5a.js` 一键导出

### 新增：小程序云函数
- `cloudfunctions/hermesBridge/index.js` — 对 Hermes 容器的认证代理
  - 入参 `{ action: 'runs'|'chat', payload, openid }`
  - action=runs：`POST /v1/runs` → 返回 run_id → SSE events 实时 proxy
  - action=chat：`POST /v1/chat/completions`（stream: true）→ proxy SSE 帧
  - action=stop：`POST /v1/runs/{id}/stop`
  - 所有请求注入 `Authorization: Bearer API_SERVER_KEY`
  - 60s 超时保护 + fallback 标志

### 保留 + 改造：现有云函数
- `cloudfunctions/chat/index.js` — 保留作 Hermes 不可用时的降级
- `cloudfunctions/hermesBridge/index.js`（改造部分）：增加 `fallback` 标志传递给前端

### 小程序前端改造
- `config.js` — 新增 `AGENT_BACKEND: 'hermes' | 'cloud'` 开关
- `utils/hermesClient.js` — 新增：封装 hermesBridge 调用
  - `run(input, options) → { runId, events }`
  - SSE 帧解析：`hermes.tool.progress` → 工具步骤事件；`message.delta` → token 事件
  - `stop(runId)`
  - `isHermesAvailable()` — 健康检查 + 超时检测
- `pages/assistant/assistant.js` — onSend 优先 hermesClient，失败 fallback 现有路径
- `pages/assistant/assistant.wxml` — 步骤卡片字段对齐 Hermes SSE 事件格式；写入确认卡复用现有逻辑
- `utils/agent.js + utils/agentTools.js` — **完整保留**，只在 fallback 路径用
- `scripts/build.js` — 把 `hermesClient.js` 加进 DROP_UTILS
- `app.json` — 不动

## Implementation Steps

### 阶段 0：CloudBase 云托管部署（手动，控制台操作）
1. CloudBase 控制台 → 云托管 → 新建服务
2. 服务名：`hermes-agent`，关联仓库选腾讯云镜像仓库
3. 编写 Dockerfile（见上），`docker build` → `docker push` 到镜像仓库
4. 伸缩策略：先设为最小 1 实例 + 最大 3 实例（关闭缩容到 0 以保证 `~/.hermes/` 持久化；后续接入 COS 卷后可开缩容到 0）
5. 暴露端口：8642
6. 环境变量：`API_SERVER_ENABLED=true`、`API_SERVER_KEY=<随机密钥>`、硅基流动 Key、CloudBase serverSecret
7. 部署 → 云托管控制台给一个 service.tcloudbaseapp.com 子域名
8. 小程序 request 白名单**可选**：走云函数代理则不用加；直连 Hermes SSE 则要加

### 阶段 1：Hermes 自定义工具
1. 把 `assets/data/attractions-5a.js` 导出为 `attractions-5a.json`（Node 脚本 10 行）
2. 写 `searchAttractions` Python 工具：从 JSON 加载，keyword/province/city 过滤，逻辑对齐现有 JS 版
3. 写 CloudBase 读取工具（`getFootprint / getWardrobe / getMemories`）：
   - 方案 A（推荐）：用 CloudBase Python Admin SDK，直查集合
   - 方案 B（备选）：调云函数（`wx.cloud.callFunction` HTTP 兼容层），好处是 openid 天然可信
4. 写 `saveDiaryDraft` 工具：只返回 JSON 草稿 `{requiresConfirm: true, date, text, existing}`
5. Hermes 配置禁用 terminal/browser/file/process/patch 工具集
6. 容器内 curl 测试每个工具

### 阶段 2：云函数 hermesBridge
1. 写 `cloudfunctions/hermesBridge/index.js`：
   - 入参：`{ action, payload }`
   - action=runs → `POST http://hermes容器内网地址:8642/v1/runs` → 返回 run_id
   - action=events → 云函数 proxy SSE → 小程序 `enableChunked:true` 接收
   - action=chat → `POST /v1/chat/completions` stream → proxy
   - action=stop → `POST /v1/runs/{id}/stop`
   - 全部请求加 `Authorization: Bearer API_SERVER_KEY`
   - 透传调用者 `_openid` 到 Hermes（注入 tool_call 上下文）
   - Hermes 不可用时返回 `{ unavailable: true, fallback: true }`

### 阶段 3：小程序前端
1. `config.js` 加开关
2. 写 `utils/hermesClient.js`：
   - `run(input)` → 返回 run_id，然后 `onChunkReceived` 解析 SSE
   - SSE 事件类型映射：
     - `event: hermes.tool.progress` → `{ type: 'tool', status, name, args }`
     - `data: choices[0].delta.content` → token delta
     - `data: choices[0].message.tool_calls` → 工具完成
     - `stop` 按钮 → `hermesBridge stop`
3. `assistant.js` 的 `onSend`：
   - 优先 hermesClient.run()
   - `isHermesAvailable() === false` 或 SSE 流断开 → fallback chat 云函数
   - 步骤卡片由 SSE `hermes.tool.progress` 事件驱动
4. 写入类工具返回 `requiresConfirm` 标记时 → 确认卡 → 本地 store → syncPending

### 阶段 4：保留降级 + 构建
1. 确认 agent.js / agentTools.js / chat 云函数完整保留
2. build.js 把 hermesClient.js 加进 DROP_UTILS
3. `node scripts/build.js prod` 验证：dist/prod 无 AI 关键词、无 assistant 页、无 hermes 相关 js

### 阶段 5：验证
1. Hermes 容器内 curl 测试：searchAttractions、getFootprint（用测试 openid）、getWardrobe、saveDiaryDraft
2. 开发者工具真机调试：assistant 页发「我去过哪」→ Hermes 返回真实足迹数据
3. SSE 步骤卡片正常显示（工具名、状态、结果摘要）
4. 「帮我写日记」→ 草稿卡 → 保存 → 本地 store → syncPending
5. 断云托管容器（或把伸缩策略设为 0 实例）→ 自动 fallback chat 云函数
6. 生产构建剥离正确

## Dependencies and Considerations

- **云托管内访问 CloudBase 集合**：Hermes Python 容器跟 CloudBase 云函数在同一环境里，用 CloudBase Admin SDK 或 HTTP API 按 `_openid` 查集合，**不需要**外部出网。
- **Hermes 的 `~/.hermes/` 持久化**：容器重启会丢。先常驻 1 实例解决（每月几块钱）；后续可以映射到 COS 卷挂载后再开缩容到 0。
- **Hermes 内置工具的安全边界**：部署时**必须**禁用 terminal、browser、file、process、patch 工具集。云函数代理进来的请求不能在容器里执行 shell。
- **60s 上限绕开**：用 `/v1/runs` 异步 API。POST 立即返回 run_id，SSE 事件流独立于 60s 限制（云函数对 SSE 也有超时，但比普通 callFunction 宽松）。
- **微信云开发自定义域名**：你的 filed 域名已绑在 CloudBase HTTP 网关。云托管的 service.tcloudbaseapp.com 子域已经自动在 request 白名单里（同域自动放行）。
- **成本估算**：常驻 1 实例（2 核 4G 缩容禁用）约 15 元/月 + LLM 调用费（硅基流动）。如果后续接入 COS 卷并开启缩容到 0，闲置时只需几毛钱/月存储费。
- **Windows 开发机**：本地开发测试用 Docker Desktop 跑 Hermes（`docker pull nousresearch/hermes-agent:latest`）；最终部署走 CloudBase 云托管。
- **个人主体合规**：集成 Hermes 不改变合规口径，assistant 页继续只出现在 dev 包里，生产构建自动剥离。

## Validation

| 项 | 方式 | 通过标准 |
|---|---|---|
| Hermes 容器可通 | 云托管控制台 → 日志看 Hermes 启动 → `curl /v1/chat/completions` | 返回 `choices[0].message.content` |
| 自定义工具可被模型调用 | curl 请求带 tools | `toolCalls` 非空且执行正确 |
| CloudBase 集合可被 Hermes 读取 | Hermes 工具 print 查询结果 | 返回正确 openid 数据 |
| SSE 事件正确 | 小程序 `wx.request enableChunked:true` + `onChunkReceived` | 收到 `hermes.tool.progress` + token delta |
| 步骤卡片渲染 | 真机调试 | 工具名/状态/结果摘要/确认卡显示正确 |
| 降级 fallback | 云托管缩到 0 → 发消息 | 自动切 chat 云函数 + agent.js |
| 生产构建剥离 | `node scripts/build.js prod` | dist/prod 无 AI 关键词，无 assistant 页 |
| 写入安全 | 直接 POST Hermes API | saveDiaryDraft 只返回草稿，不写任何地方 |

## Risks

| 风险 | 概率 | 影响 | 处理 |
|---|---|---|---|
| Hermes 内置高风险工具被滥用 | 高（默认启用） | 容器内执行任意 shell | config.yaml 里显式只启用 web_search/vision/image_generate/text_to_speech/memory/skills；禁用 terminal/browser/file/process/patch |
| 容器冷启动延迟（缩容到 0 时） | 高 | 首次请求 10~30s | 先常驻 1 实例；后续接 COS 卷后再考虑缩容到 0 |
| Hermes 版本快速迭代 | 高 | API breaking change | 锁定 Docker tag（如 `nousresearch/hermes-agent:v0.21.6`）；升级先在本地 Docker 测试 |
| CloudBase serverSecret 泄露 | 低 | 数据被读 | 只在 CloudBase 环境变量里，不放代码仓；Hermes 端只读集合权限 |
| SSE 60s 上限 | 中 | 长对话中断 | Runs API 是独立 HTTP 流，云函数 streaming 超时配置比普通 callFunction 宽松（可配到 180s）；超过则前端显示超时提示 + 手动重发 |
| Python SDK 调 CloudBase 兼容性 | 中 | Python 调集合比 Node SDK 慢/功能少 | 用 `cloudbase-admin` PyPI 包；不行就换调云函数（HTTP 兼容层） |
