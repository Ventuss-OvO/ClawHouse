# ClawHouse Protocol Specification

Plugin ↔ iOS App 通信协议约定，基于 OpenClaw Gateway Protocol 3。

---

## 连接流程

### 1. 配对（一次性）

```
iOS App                          User                         OpenClaw Gateway
  │                                │                               │
  │  1. Generate token             │                               │
  │  2. Show pairing text ────────►│                               │
  │                                │  3. Send to claw via          │
  │                                │     Discord/WhatsApp ────────►│
  │                                │                               │
  │                                │  4. Claw installs plugin      │
  │                                │     and configures token      │
  │                                │                               │
  │  5. User enters Gateway URL    │                               │
  │     in app                     │                               │
  │                                │                               │
  │  6. WebSocket connect ─────────────────────────────────────────►│
  │  7. Protocol 3 handshake       │                               │
  │  8. clawhouse.pair RPC ────────────────────────────────────────►│
  │  9. Pair success ◄─────────────────────────────────────────────│
  │                                │                               │
```

### 2. 常规连接（每次启动）

```
iOS App                                          Gateway
  │                                                 │
  │  WebSocket connect ────────────────────────────►│
  │  ◄──────────── connect.challenge (nonce, ts) ───│
  │  connect (token, role:operator, scopes) ───────►│
  │  ◄────────────── hello-ok (deviceToken, policy) │
  │                                                 │
  │  ◄─────────── event stream (agent, chat, tick)  │
  │  RPC: chat.send / chat.history / sessions.list  │
  │                                                 │
```

---

## 自定义 Gateway 方法

### `clawhouse.pair`

配对验证。iOS app 在首次连接成功后调用。

**Request:**
```json
{
  "type": "req",
  "id": "uuid",
  "method": "clawhouse.pair",
  "params": {
    "token": "base64url-encoded-token",
    "deviceId": "ios-device-uuid",
    "deviceName": "iPhone 16 Pro",
    "platform": "ios",
    "appVersion": "0.1.0"
  }
}
```

**Response (success):**
```json
{
  "type": "res",
  "id": "uuid",
  "ok": true,
  "payload": {
    "success": true,
    "agentId": "main"
  }
}
```

**Response (failure):**
```json
{
  "type": "res",
  "id": "uuid",
  "ok": false,
  "error": {
    "code": "INVALID_TOKEN",
    "message": "Pairing token does not match"
  }
}
```

### `clawhouse.state`

获取当前 claw 状态。

**Request:**
```json
{
  "type": "req",
  "id": "uuid",
  "method": "clawhouse.state",
  "params": {}
}
```

**Response:**
```json
{
  "type": "res",
  "id": "uuid",
  "ok": true,
  "payload": {
    "state": "working",
    "detail": "web_search",
    "timestamp": 1709337600000,
    "idleSince": null
  }
}
```

---

## Claw 状态定义

| State | 值 | 触发条件 | Plugin 端事件 |
|-------|----|---------|--------------|
| Idle | `idle` | 无任务运行，idle < 5min | agent.run.after hook |
| Working | `working` | agent 正在处理 | agent.run.before hook |
| Out | `out` | 调用外部工具 | tool.call.before hook (外部工具) |
| Returning | `returning` | 外部工具返回 | tool.call.after hook |
| Chatting | `chatting` | 发送消息给用户 | outbound.sendText |
| Resting | `resting` | idle 5-30 min | idle monitor (30s 轮询) |
| Sleeping | `sleeping` | idle > 30 min | idle monitor (30s 轮询) |

### 外部工具判定

以下 tool name 模式视为"外出"（claw 走出门）：

```
gmail, google_calendar, web_search, web_browse,
http_request, slack, discord, twitter,
github, notion, linear
```

其他工具视为"在桌前工作"。

---

## 事件流映射

iOS app 监听的 Gateway 原生事件及对应行为：

| Gateway Event | App 行为 |
|--------------|---------|
| `agent` | 解析 payload 判断 working/out/returning |
| `chat` | 信箱亮灯，新消息提示 |
| `tick` | 心跳，用于 idle 检测和连接健康监控 |
| `presence` | 更新连接状态指示器 |
| `exec.approval.requested` | 弹出审批面板 |
| `connect.challenge` | 触发 Protocol 3 握手 |
| `shutdown` | 显示断开提示，准备重连 |

---

## RPC 方法使用

| 方法 | 用途 | 参数 |
|------|------|------|
| `chat.send` | 发消息 | `{ text, sessionKey }` |
| `chat.history` | 拉历史 | `{ sessionKey, limit }` |
| `chat.abort` | 中止生成 | `{}` |
| `sessions.list` | 列所有会话 | `{ search? }` |
| `clawhouse.pair` | 配对验证 | `{ token, deviceId, ... }` |
| `clawhouse.state` | 获取状态 | `{}` |

---

## iOS 后台策略

```
App 前台: WebSocket 连接，实时事件流
App 后台: 断开 WebSocket，Plugin 检测断开 → APNs 推送关键事件
App 恢复: 重连 WebSocket → Protocol 3 握手 → gap fill (chat.history)
```

重连策略: 指数退避 + 随机抖动（base 1s, max 60s, 最多 10 次）
