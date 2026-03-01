# ClawHouse PRD

## 产品概述

ClawHouse 是一个开源 iOS 客户端，连接用户自托管的 OpenClaw Gateway，将 AI agent 的操作过程和数据以游戏化的方式呈现。核心隐喻：用户和 claw 共享一个"客厅"，claw 是一个有行为状态的角色（工作、外出、休息），客厅内的物件承载真实功能（日历、笔记、任务看板）。

ClawHouse 不是旁观型 companion app，而是一个有完整交互能力的 OpenClaw 全功能客户端，具备收发消息、语音输入、查看多 channel 对话记录等全部功能。游戏化是表现层，实用功能是留存基础。

---

## 目标用户

OpenClaw 现有用户（约 30-40 万），技术背景，已有自托管 Gateway 和公网暴露方案（Cloudflare Tunnel 等）。

---

## 竞品分析与差异化

| 维度 | Pixel Agents | AgentOffice | AI-Tamago | ClawHouse |
|------|-------------|-------------|-----------|-----------|
| 平台 | VS Code 扩展 | Web | Web | iOS 原生 |
| Agent 来源 | Claude Code | 内置 Ollama | 内置 LLM | 连接用户自有 Gateway |
| 视觉风格 | 像素风 | 像素风 | 简约 | 手绘风"客厅" |
| 交互深度 | 只读观察 | 自动运行 | 对话 | 观察 + 干预 + 游戏化 |
| 游戏化 | 无 | 轻度 | Tamagotchi 式 | 完整养成系统 |

核心差异化：
1. **移动端优先** — 随时随地查看 agent 状态，目前没有任何 iOS 原生应用在做这件事
2. **客厅隐喻** — 温暖家居感而非冰冷办公室
3. **主动干预** — 不仅观察，还能通过 app 控制/指导 agent
4. **生态整合** — 直接对接 OpenClaw 30-40 万用户群

---

## 核心隐喻：客厅

用户和 claw 共享一个客厅空间。客厅内的所有元素都对应真实功能：

| 客厅元素 | 对应功能 | 数据来源 |
|---------|---------|---------|
| 墙上日历 | 日程看板 | Calendar 事件 |
| 桌上笔记本 | 笔记系统 | OpenClaw memory / notes |
| 便利贴墙 | Todo 列表 | 任务数据 |
| 信箱 | 收发消息 | 多 channel 消息流 |
| 门 | claw 外出状态 | 外部服务访问事件 |
| 沙发/床 | claw 休息状态 | idle 状态 |
| 电视/屏幕 | 当前工作展示 | 活跃任务详情 |

---

## Claw 角色状态机

Claw 在客厅中是一个有动画表现的角色，状态由 Gateway event stream 驱动。
iOS 端使用 **GKStateMachine**（GameplayKit）管理状态转换：

| 状态 | 触发条件 | 视觉表现 |
|-----|---------|---------|
| 工作中 | 正在处理用户指令 | 在桌前操作 |
| 外出 | 访问外部服务（Gmail、网页、API） | 走出门，门上显示去向标签 |
| 回来汇报 | 外部服务调用完成，返回结果 | 推门进来，带着"战利品" |
| 休息 | idle 超过阈值 | 躺沙发 / 看书 / 睡觉 |
| 聊天 | 用户主动对话 | 面向用户，对话气泡 |
| 忙碌排队 | 多任务堆积 | 桌上堆满文件 |

---

## 功能规格

### P0：核心功能（MVP）

#### 1. 配对连接

**流程：**
1. 用户在 ClawHouse app 中点击"连接 Claw"
2. App 生成唯一 token
3. App 显示一段预格式化文本，包含：plugin 的安装命令 + 用户专属 token
4. 用户复制该文本，通过任意现有 channel（Discord、WhatsApp 等）发送给自己的 claw
5. Claw 安装 plugin，plugin 使用 token 向 Gateway 注册 ClawHouse channel
6. 配对完成，app 通过 WebSocket 连接 Gateway，开始接收 event stream

**技术细节（已确认）：**
- ClawHouse 在 Gateway 端是 **Plugin**（非 Skill），因为需要调用 `api.registerChannel()` 注册新消息频道
- Plugin 发布在 npm + GitHub，开源
- App 通过 WebSocket (JSON text frames) 连接 Gateway，默认端口 18789
- 连接握手遵循 Protocol 3：服务端发 `connect.challenge`(含 nonce) → 客户端发 `connect`(含 auth token) → 服务端返回 `hello-ok`(含 deviceToken)
- App 使用 `operator` 角色连接，scopes: `operator.read`, `operator.write`
- 首次连接后 Gateway 签发 `deviceToken`，客户端持久化保存，后续复用
- Gateway URL 由用户在 plugin 配置中指定（Cloudflare Tunnel URL 或自定义域名）

#### 2. 消息交互

- 文本输入：标准聊天输入框，通过 `chat.send` RPC 发送指令给 claw
- 语音输入：iOS 原生语音识别转文本，文本通过 `chat.send` 发送给 Gateway
- 消息展示：通过 `sessions.list` 获取所有会话，`chat.history` 按 session 拉取历史
- 消息来源标记：Session key 格式为 `agent:{agentId}:{provider}:{chatId}`，可解析出 channel 来源

**已确认的 RPC 方法：**
- `chat.send` — 发送消息
- `chat.history` — 获取聊天历史（参数：`sessionKey` + `limit`）
- `chat.abort` — 中止生成
- `sessions.list` — 列出所有会话（支持 `search` 过滤元数据）

**当前限制：**
- 无 `chat.search` 方法，不支持跨会话消息内容搜索（Issue #19725 提案中）
- 消息历史存储为 JSONL 文件，每 session 一个文件

#### 3. 客厅主界面

- 2D 手绘风格客厅场景（SpriteKit + SpriteView）
- SwiftUI 通过 ZStack 叠加在 SpriteKit 场景上（状态栏、控制面板等）
- Claw 角色实时反映当前状态（GKStateMachine 驱动帧动画）
- 可点击的功能物件（日历、笔记本、便利贴墙、信箱）
- 点击物件展开对应功能面板

#### 4. Event Stream 监听与状态映射

监听 Gateway WebSocket event stream，将事件映射为角色行为：

**已确认的事件类型映射：**

| Gateway 事件 | Claw 状态 | 视觉表现 |
|-------------|----------|---------|
| `agent` (event, streaming) | 工作中 | 在桌前操作，显示思考/输出流 |
| `agent` (tool_call payload) | 外出 | 走出门，门上标签显示工具名 |
| `agent` (tool_result payload) | 回来汇报 | 推门进来，展示结果摘要 |
| `chat` | 聊天/收到消息 | 信箱亮灯，面向用户 |
| `tick` (连续无 agent 事件 >5min) | 休息 | 坐到沙发上 |
| `tick` (连续无 agent 事件 >30min) | 深度休息 | 睡觉 |
| `presence` | 连接状态 | 更新连接指示器 |
| `exec.approval.requested` | 等待审批 | 举手示意，弹出审批面板 |

**提议中的细粒度事件（Issue #6467，待确认是否已合并）：**
- `agent.started` / `agent.finished` — Agent 生命周期
- `tool.call` / `tool.output` — 工具调用详情
- `subagent.spawned` / `subagent.finished` — 子代理

### P1：功能面板

#### 5. 日程看板

- 点击墙上日历打开
- 展示日/周视图
- 数据来源：claw 返回的 calendar 事件
- 支持通过对话让 claw 创建/修改日程

#### 6. Todo 列表

- 点击便利贴墙打开
- 展示任务列表，状态标记（待办/进行中/完成）
- 数据来源：claw 的 task/todo 数据

#### 7. 笔记

- 点击桌上笔记本打开
- 展示 claw memory 中的笔记内容
- 只读浏览 + 通过对话编辑

### P2：增强体验

#### 8. 外出动画与旅行日志

- Claw 访问不同外部服务时，用不同的"外出"动画
- 维护一个"旅行日志"，记录 claw 去过哪些服务、做了什么
- 可回看历史

#### 9. 客厅自定义

- 更换客厅风格/主题
- 自定义 claw 角色外观
- 解锁装饰物件

#### 10. 通知系统

- claw 完成重要任务时通过 APNs 推送通知
- 长时间 idle 后恢复活动时通知
- 可配置通知类型和频率
- 关键事件在 WebSocket 断开时（app 后台）通过 APNs 补发

---

## 技术架构

### 客户端（iOS App）

| 层级 | 选择 | 理由 |
|------|------|------|
| 语言 | Swift | iOS 原生 |
| UI 框架 | SwiftUI + SpriteKit (SpriteView) | 声明式 UI + 2D 动画 |
| 角色状态管理 | GKStateMachine (GameplayKit) | Apple 原生状态机，每个状态对应帧动画 |
| 网络层 | URLSessionWebSocketTask | 零依赖，async/await 原生支持，Starscream 已停止维护 |
| 数据持久化 | SwiftData | iOS 17+ 原生 ORM |
| 推送通知 | APNs | 后台事件补充 |
| 最低支持 | iOS 17 | SwiftData + 现代 WebSocket API |
| CI/CD | GitHub Actions + Fastlane | 开源友好 |

**SpriteKit + SwiftUI 集成方案：**
- `SpriteView` 渲染客厅场景，`ZStack` 叠加 SwiftUI 控件
- SpriteKit ↔ SwiftUI 通信使用 Delegate 模式 + `@Published` 属性
- 非活跃状态降帧至 15fps，后台 `isPaused = true`（0% CPU）
- 手绘风格纹理使用 `filteringMode = .linear`，打包为 TextureAtlas

**已知风险：**
- SpriteView 在 SwiftUI 中有内存释放问题，需手动管理 scene 生命周期
- iOS 不支持后台 WebSocket 长连接，必须前台重连 + gap fill

### OpenClaw Plugin（开源）

> **重要修正：** 原 PRD 中标注为"Skill"，调研后确认应为 **Plugin**。
> Skill 是纯文本指令（SKILL.md），无法注册 channel；Plugin 是 TypeScript 代码，可以调用 `api.registerChannel()` 注册新消息频道。

- 仓库：GitHub 公开 + npm 发布
- 语言：TypeScript
- 项目结构：
  ```
  openclaw-plugin-clawhouse/
  ├── src/
  │   ├── index.ts          # export default register(api)
  │   └── index.test.ts
  ├── openclaw.plugin.json  # Plugin manifest
  ├── tsconfig.json
  ├── package.json
  └── dist/
  ```
- 功能：
  - `api.registerChannel()` — 注册 ClawHouse 为新消息频道
  - `api.registerGatewayMethod()` — 自定义 RPC 端点（配对握手、事件转发等）
  - `api.registerService()` — 后台服务（维护与 iOS app 的连接状态）
  - 出站消息：实现 `outbound.sendText()` 将 agent 消息转发给 iOS app
- 安装方式：`openclaw plugins install openclaw-plugin-clawhouse`

### 通信架构

```
┌─────────────┐    WebSocket (Protocol 3)   ┌──────────────────┐
│  ClawHouse   │◄──────────────────────────►│  OpenClaw        │
│  iOS App     │  JSON text frames          │  Gateway :18789  │
│              │  via CF Tunnel / 公网      │                  │
│  ┌─────────┐ │                            │  ┌────────────┐  │
│  │ SwiftUI │ │                            │  │ ClawHouse  │  │
│  │ + Sprite│ │  握手:                     │  │ Plugin     │  │
│  │   Kit   │ │  1. connect.challenge ←    │  │ (channel)  │  │
│  └─────────┘ │  2. connect (token) →      │  └────────────┘  │
│  ┌─────────┐ │  3. hello-ok ←             │                  │
│  │URLSession│ │                            │  ┌────────────┐  │
│  │WebSocket│ │  RPC:                      │  │ Discord    │  │
│  └─────────┘ │  chat.send / chat.history  │  │ Channel    │  │
│  ┌─────────┐ │  sessions.list / agent.run │  └────────────┘  │
│  │SwiftData│ │                            │                  │
│  └─────────┘ │  Events:                   │  ┌────────────┐  │
│              │  agent / chat / tick /      │  │ WhatsApp   │  │
│              │  presence / exec.approval   │  │ Channel    │  │
└─────────────┘                             └──────────────────┘
                        ↓ (后台)
                   APNs 推送补充
```

### 连接要求

- 用户 Gateway 必须有公网可达地址（Cloudflare Tunnel 推荐，免费）
- App 内提供 Cloudflare Tunnel 配置引导（针对尚未配置的用户）
- 零中继服务器，完全 P2P，零运营成本

### 后台策略

iOS 对后台网络限制严格，方案：
1. **App 进入后台** → 优雅关闭 WebSocket（`.goingAway`），暂停 SpriteKit（0% CPU）
2. **关键事件** → Plugin 端检测 WebSocket 断开，通过 APNs 推送通知
3. **App 回到前台** → 重新连接 WebSocket，执行 Protocol 3 握手，gap fill 拉取错过的事件
4. **重连策略** → 指数退避 + 随机抖动（base 1s, max 60s, 最多 10 次）

---

## 分发策略

### Phase 1：TestFlight

- 首发通过 TestFlight 分发
- 目标用户是技术群体，TestFlight 零门槛
- 快速迭代，不受 App Store 审核周期限制
- CI/CD：GitHub Actions + Fastlane，tag 触发自动构建上传
- 公开 TestFlight 链接，最多 10,000 名外部测试者

### Phase 2：App Store

- 产品稳定后提交 App Store
- 审核策略（Guideline 2.1 合规）：
  - **混合方案**：首次启动提供"连接服务器"和"体验 Demo"两个入口
  - Demo 模式内置模拟数据和模拟 WebSocket 连接，展示完整 UI 和交互
  - App Review Notes 中提供 demo 路径说明
  - 参考 Home Assistant iOS（提供 demo.home-assistant.io）和 Nextcloud iOS 的成功案例
  - 免费 app，无内购，审核宽松
  - 明确标注为开源项目的客户端

---

## 开源策略

- iOS app 代码：GitHub 公开，MIT License
- OpenClaw plugin 代码：GitHub 公开，MIT License
- 接受社区贡献：客厅主题、claw 皮肤、功能面板插件

---

## MVP 范围与开发顺序

### Sprint 1：连接层（1-2 周）

- [ ] OpenClaw Plugin 开发：`api.registerChannel()` 注册 ClawHouse channel
- [ ] Plugin 配对握手：接收 token，注册 channel，转发 Gateway URL
- [ ] iOS 端 URLSessionWebSocketTask 连接建立
- [ ] Protocol 3 握手实现（connect.challenge → connect → hello-ok）
- [ ] Token 生成与持久化（Keychain 存储 deviceToken）
- [ ] 基础消息收发验证（chat.send + chat.history）

### Sprint 2：客厅界面（2-3 周）

- [ ] 客厅场景搭建（SpriteKit + SpriteView + SwiftUI ZStack）
- [ ] Claw 角色基础状态动画（GKStateMachine：工作、休息、外出、回来）
- [ ] 手绘风格纹理制作 + TextureAtlas 打包
- [ ] Event stream 监听与状态映射（agent/chat/tick/presence 事件）
- [ ] 可点击物件的交互骨架

### Sprint 3：消息与对话（1-2 周）

- [ ] 完整聊天界面
- [ ] 多 channel 消息聚合与来源标记（sessions.list + chat.history）
- [ ] 语音输入（iOS 原生 Speech framework）
- [ ] 消息通知

### Sprint 4：功能面板（2-3 周）

- [ ] 日程看板
- [ ] Todo 列表
- [ ] 笔记浏览
- [ ] 面板与客厅物件的切换动画

### Sprint 5：打磨与分发（1-2 周）

- [ ] Demo 模式（DemoWebSocketProvider + 模拟事件流）
- [ ] 后台策略（断开/重连/APNs 补推/gap fill）
- [ ] Cloudflare Tunnel 配置引导
- [ ] TestFlight 分发（GitHub Actions + Fastlane）
- [ ] README、文档、社区宣发素材

**预估总周期：7-12 周**

---

## 已解决的技术确认项

| # | 原始问题 | 调研结论 |
|---|---------|---------|
| 1 | Gateway event stream 的具体 schema | 已确认：三种帧类型（req/res/event），已知事件包括 `agent`, `chat`, `presence`, `tick`, `shutdown`, `health`, `exec.approval.requested` 等。详细 schema 定义于 `src/gateway/protocol/schema.ts`（TypeBox） |
| 2 | Channel 注册 API 细节 | 已确认：需要使用 **Plugin**（非 Skill）。Plugin 通过 `api.registerChannel({ plugin: channelConfig })` 注册，完整接口定义于 `src/channels/plugins/types.plugin.ts` |
| 3 | WebSocket 鉴权机制 | 已确认：Protocol 3 三步握手。支持 Token/Password/Tailscale Headers/Device Keypair 四种认证模式。首次连接签发 deviceToken，后续复用 |
| 4 | 多 channel 消息历史查询 | 已确认：`sessions.list` 列出所有会话 → `chat.history(sessionKey, limit)` 按会话拉取。Session key 格式：`agent:{agentId}:{provider}:{chatId}`。无跨会话搜索 |
| 5 | Claw 角色视觉风格 | 已确定：手绘风 |

## 仍需确认的细节

1. `chat.history` 完整参数（offset/cursor/before/after），需查看 `src/gateway/server-methods/chat.ts`
2. Agent Event Stream API (Issue #6467) 是否已合并到主分支
3. JSONL 消息行的精确 TypeScript interface
4. Plugin 的 APNs 推送集成方案（可能需要自定义 gateway method）

---

## 命名

**ClawHouse** — 致敬 Clubhouse，暗示可探索的空间感，未来可扩展社交能力。
