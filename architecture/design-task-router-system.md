# 任务路由系统设计方案

> 设计日期：2026-06-01
> 目标：常驻路由子程序 + 桌面 GUI + 决策推送

---

## 整体架构概览

```
┌─────────────────────────────────────────────────────────┐
│                   Windows 11 宿主机                      │
│                                                         │
│  ┌──────────────┐    HTTP    ┌──────────────────────┐   │
│  │ 主会话 (MFD) │ ────────→  │  Route Server (:3456) │   │
│  │ (只做分拣)   │ ←────────  │  (常驻 Node.js 进程)  │   │
│  └──────────────┘  callback  │                       │   │
│                              │  ┌─────────────────┐  │   │
│                              │  │ 任务队列 (优先权) │  │   │
│                              │  └─────────────────┘  │   │
│  ┌──────────────┐            │  ┌─────────────────┐  │   │
│  │ 子程序 A     │ sessions   │  │ 状态注册表       │  │   │
│  │ (DeepSeek)   │ spawn/yield│  │ (内存+JSON持久)  │  │   │
│  └──────────────┘            │  └─────────────────┘  │   │
│                              │  ┌─────────────────┐  │   │
│  ┌──────────────┐            │  │ 决策管理器       │  │   │
│  │ 子程序 B     │            │  │ (等待用户抉择)   │  │   │
│  │ (DeepSeek)   │            │  └─────────────────┘  │   │
│  └──────────────┘            └──────────────────────┘   │
│                                          │              │
│                               WebSocket  │  REST API    │
│                                          ▼              │
│                              ┌──────────────────────┐   │
│                              │  桌面 GUI（浏览器)     │   │
│                              │  HTML/JS/CSS SPA     │   │
│                              │  打开 http://localhost│   │
│                              │  :3456/dashboard     │   │
│                              └──────────────────────┘   │
│                                          │              │
│                              ┌──────────────────────┐   │
│                              │  决策推送文件         │   │
│                              │  decisions/pending/   │   │
│                              └──────┬───────────────┘   │
│                                     │                   │
│                                     ▼                   │
│                              ┌──────────────────────┐   │
│                              │  主会话发送到         │   │
│                              │  DingTalk/微信/飞书   │   │
│                              └──────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 阶段一：路由子程序（Route Server）

### 核心设计

**技术选型**：单进程 Node.js HTTP 服务（零外部依赖，仅用 `http`, `fs`, `path`, `crypto`, `events` 内置模块）

**为什么不用 OpenClaw 子会话做路由？**
- OpenClaw 的 `sessions_spawn` 创建的子会话是**临时的**，会随任务完成而结束
- 路由需要**常驻**，需要在主会话生命周期之外独立运行
- 所以路由作为独立 Node.js 进程启动，通过 HTTP + 文件协议与主会话通信

### 启动方式

```mermaid
sequenceDiagram
    participant Main as 主会话 (MFDoom)
    participant Route as Route Server
    participant FS as 文件系统

    Main->>FS: 检查 route-server.pid 是否存在
    alt 已运行
        Main->>Route: 发送健康检查 GET /ping
    else 未运行
        Main->>Route: exec("node route-server.js &")
        Route->>FS: 写入 route-server.pid
        Route-->>Main: 服务就绪
    end
```

主会话启动时（或首次需要路由时）检查 PID 文件，不存在则启动。每次重启 Gateway 后自动重生。

### 消息接收机制

Route Server 暴露 HTTP API，主会话通过 HTTP 调用，子程序通过回调机制报告状态。

**为什么不走文件 IPC？**
- 文件读写有锁竞争风险，轮询延迟高
- HTTP 是无锁的，localhost 延迟 < 1ms
- 可以自然支持 WebSocket（GUI 实时刷新需要）

**为什么不走 stdin/stdout 管道？**
- 管道只能被一个进程持有，Route Server 需要同时与主会话、GUI、子程序通信
- 进程意外退出时管道断裂，HTTP 可优雅重试

### 任务流转设计

```
主会话收到消息
    │
    ▼
POST /api/tasks  { message, channel, user, context }
    │
    ▼
Route Server:
    ├──① 分词 + 关键词匹配（复用现有 route-task.js 算法）
    ├──② 创建任务记录 { id, name, status, created, priority }
    ├──③ 入队列（按优先级排序）
    │
    ▼
调度器（内部循环，每秒跑一次）:
    ├──④ 出队
    ├──⑤ 执行策略判断：
    │   ├── 简单任务（查文件/改配置）→ 直接 spawn 子进程 worker
    │   ├── AI 任务 → 回调主会话："请创建子程序处理任务 #{id}"
    │   └── 需要抉择 → 状态改为 awaiting_decision
    │
    ▼
    └──⑥ 更新状态注册表
```

### 状态注册表（内存 + 持久化）

```javascript
// 内存数据结构
{
  tasks: Map<taskId, {
    id: string,           // uuid
    name: string,         // 任务名称
    description: string,  // 用户原始消息
    status: 'queued' | 'running' | 'awaiting_decision' | 'completed' | 'failed',
    priority: 0-10,
    channel: string,      // 来源通道 (dingtalk/wechat/feishu)
    subagentInfo: {       // 如果是 AI 任务，记录子程序信息
      sessionKey: string | null,
      startedAt: string,
      completedAt: string | null
    },
    decisionRequest: {    // 如果需要决策
      prompt: string,
      options: [{ key, label }],
      selected: string | null
    },
    result: any,
    errors: string[],
    createdAt: string,
    updatedAt: string
  }>,
  queue: PriorityQueue<taskId>,
  workers: Map<workerPid, { taskId, status, startedAt }>
}
```

每 30 秒自动快照到 `data/task-registry.json`，服务重启时恢复。

### 管理已创建的执行子程序

子程序分为两类，路由用不同方式管理：

| 类型 | 管理方式 | 如何跟踪状态 |
|------|---------|------------|
| **本地 Worker**（Node.js 子进程） | `child_process.fork()`，直接父子通信 | `worker.on('message')` 接收状态更新 |
| **AI 子程序**（OpenClaw sessions_spawn） | 通过主会话间接管理 | 主会话通过 `POST /api/tasks/:id/callback` 报告子程序完成 |

**关键设计决策**：Route Server 不直接调用 `sessions_spawn`（因为没有 OpenClaw API），而是：
1. 主会话轮询 `GET /api/tasks/pending-ai`（每 2 秒）
2. 发现有需要 AI 处理的任务 → 创建子程序 → 完成后 `POST /api/tasks/:id/update`
3. 这样既保留了 OpenClaw 的子会话机制，又让路由统一管理状态

### 队列优先级策略

```
高优先级（priority 8-10）：老板直接提的需求、紧急故障
中优先级（priority 4-7）：常规任务、信息查询
低优先级（priority 1-3）：系统维护、知识沉淀、离线分析
```

---

## 阶段二：桌面 GUI

### 推荐方案：**方案 D — Web 技术（HTML/JS/CSS + HTTP Server）**

**推荐理由**（对比其他方案）：

| 方案 | 优点 | 缺点 | 评分 |
|------|------|------|:----:|
| 🅰 **Electron** | 原生窗口感 | 200MB+ 安装包、高内存(~200MB) | ❌ |
| 🅱 **HTTP + 浏览器** | 零安装、轻量(< 5MB)、热更新 | 需要开浏览器标签 | ✅ **推荐** |
| 🅲 **PowerShell WinForms** | 最轻量(< 1MB) | 开发效率低、样式丑、难维护 | ⚠️ 备选 |
| 🅳 **Node.js HTTP Server** | 共享路由端口、WebSocket天然支持 | 浏览器安全问题（localhost 无风险） | ✅ **最佳** |

**为什么不选 Electron？**
- GTX 960 只有 4GB 显存，Electron 每个窗口吃 150-200MB RAM
- 16GB 系统 RAM 够用但没必要浪费
- 浏览器已经是最成熟的渲染平台

**为什么不选 PowerShell WinForms？**
- 异步支持差，要做 WebSocket 实时更新非常复杂
- 样式全靠 Win32 API 手绘，开发时间翻 3 倍
- 维护困难，老板以后想加功能你得重新编译

**方案 D 的实操方式**：
- Route Server 内置一个 `http.createServer()`，在同一个端口（:3456）提供 REST API + 静态文件
- GUI 是一个单页 HTML 文件（`dashboard.html`），放在 `public/` 目录
- 打开 `http://localhost:3456/dashboard` 即可使用
- WebSocket 实现实时推送（路由状态变更时自动推送到浏览器）

### GUI 界面布局

```
┌─────────────────────────────────────────────────────────┐
│  🎯 任务路由控制面板                 2026-06-01 14:32   │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  统计数据条:                                        │ │
│  │  [排队: 2]  [运行中: 3]  [已完成: 47]  [失败: 1]   │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │ 📌 等待决策  │  │ ▶ 运行中    │  │ ⏳ 队列中    │     │
│  │  ┌─────────┐│  │  ┌─────────┐│  │  ┌─────────┐│     │
│  │  │选服务方案││  │  │语音识别 ││  │  │周报生成 ││     │
│  │  │ 12:30 🟡 ││  │  │ 已运行2m││  │  │ 优先级3 ││     │
│  │  │ [选A][选B]││  │  │ 进度:80%││  │  └─────────┘│     │
│  │  └─────────┘│  │  └─────────┘│  │  ┌─────────┐│     │
│  │              │  │  ┌─────────┐│  │  │翻译文档 ││     │
│  │              │  │  │百度ASR  ││  │  │ 优先级1 ││     │
│  │              │  │  │ 已运行5m││  │  └─────────┘│     │
│  │              │  │  └─────────┘│  │              │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 📋 任务详情 (点击任意任务展开)                       │ │
│  │  ─────────────────────────────────────────────       │ │
│  │  任务ID: abc-123                                    │ │
│  │  消息: "帮我把这份PDF转成Word"                       │ │
│  │  来源: 钉钉 | 状态: ✅ 已完成 | 耗时: 23秒           │ │
│  │  结果: output.docx (2.3MB)                           │ │
│  │  ─────────────────────────────────────────────       │ │
│  │  任务ID: def-456                                    │ │
│  │  消息: "语音识别用百度"                              │ │
│  │  来源: 微信 | 状态: ▶ 运行中 | 已运行: 2分15秒       │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                         │
│  ⚙️ [系统日志] [配置] [重启路由]                        │
└─────────────────────────────────────────────────────────┘
```

### 关键技术细节

**实时更新机制**：WebSocket（Server-Sent Events 降级方案）
- Route Server 提供 `/ws` 端点
- 事件类型：`task:new` / `task:status` / `task:completed` / `task:failed` / `decision:new`
- GUI 收到事件后局部刷新 DOM，不做全页刷新

**自启动**：

```powershell
# 方案 A（推荐）：开机自启 + 常驻
$routeCmd = "node C:\path\to\route-server.js"
$trigger = New-JobTrigger -AtStartup -RandomDelay 00:00:30
Register-ScheduledJob -Name "TaskRouteServer" -ScriptBlock { $using:routeCmd } -Trigger $trigger

# 方案 B：双击启动图标
# 创建一个 route-server.cmd 快捷方式放在启动文件夹
```

**浏览器自动打开**：
- Route Server 启动后自动尝试打开 `http://localhost:3456/dashboard`
- 使用 `child_process.exec('start http://localhost:3456/dashboard')`

---

## 阶段三：决策推送

### 完整设计

决策推送涉及三个组件协作：

```mermaid
sequenceDiagram
    participant AI as AI子程序(DeepSeek)
    participant Route as Route Server
    participant GUI as 桌面GUI
    participant Main as 主会话(MFDoom)
    participant Ding as DingTalk

    AI->>Route: POST /api/decisions { taskId, prompt, options }
    Note over Route: 任务状态→awaiting_decision

    Route-->>GUI: WebSocket → decision:new
    Note over GUI: 界面出现"待决策"卡片 + [选A][选B]按钮

    Route->>FS: 写入 decisions/pending/{taskId}.json
    Note over FS: 主会话每2秒轮询此目录

    Main->>FS: 发现新 decision 文件
    Main->>Ding: 发消息给老板
    Note over Ding: "需要您抉择：服务方案用A还是B？回复 选A 或 选B"

    Ding-->>Main: 老板回复 "选A"
    Main->>Route: POST /api/decisions/{taskId}/respond { selection: "A" }
    Route->>Route: 解除阻塞，任务继续
    Route-->>GUI: WebSocket → decision:resolved
    Route-->>AI: 返回结果 { selected: "A" }
```

### 决策文件协议

```json
// decisions/pending/{taskId}.json
{
  "taskId": "abc-123",
  "prompt": "需要您抉择：服务方案用A还是B？",
  "options": [
    { "key": "A", "label": "方案A：用百度语音识别（免费，准确率95%）" },
    { "key": "B", "label": "方案B：用阿里云语音识别（付费，准确率98%）" }
  ],
  "status": "pending",
  "expiresAt": "2026-06-01T15:00:00.000Z"
}

// 老板回复后：
// decisions/pending/{taskId}.json → decisions/resolved/{taskId}.json
{
  "taskId": "abc-123",
  "status": "resolved",
  "selected": "A",
  "respondedBy": "dingtalk",
  "respondedAt": "2026-06-01T14:35:00.000Z"
}
```

### 推送通道策略

```
老板决策时，按优先级依次尝试：
  ① DingTalk（主要通道，日常使用）
     → 主会话调用 DingTalk API 发送带决策信息的消息
     → 老板回复 → 主会话解析 → 回写决策文件
  
  ② WeChat（备用通道，如果 DingTalk 不在线）
     → 同样机制
  
  ③ Feishu（三线通道）
  
  ④ GUI 直接点击（桌面在眼前时最快捷）
     → 点击 [选A] 按钮 → AJAX POST /api/decisions/{id}/respond
     → 立即生效，无需等待聊天回复
```

### 聊天回复解析机制

老板在 DingTalk 回复 "选A" 或 "选B" → 主会话收到消息后：

1. 搜索 `decisions/pending/` 目录是否有等待决策的任务
2. 如果有多个 → 取最新的
3. 解析回复：
   - 匹配正则 `/选([A-Z\d])/` 或 `/选项([A-Z\d])/`
   - 找到对应 option key
4. `POST /api/decisions/{taskId}/respond { selection }`
5. 删除 pending 文件，移动到 resolved

**多决策并发场景**：按 taskId 严格对应，每个决策文件独立。老板回复时可带任务描述来消除歧义：
- 老板说 "方案用A" → 匹配最新 waiting 的决策
- 老板说 "语音识别选A" → 匹配描述包含"语音识别"的决策
- 老板说 "task-abc 选A" → 精确匹配 taskId

---

## 阶段四：完整消息流转图

### Mermaid 流程图（主图）

```mermaid
flowchart TB
    %% 外部输入
    User([👤 老板/用户]) -->|发消息| Channel
    
    subgraph Channel["📡 消息通道"]
        DingTalk
        WeChat
        Feishu
    end
    
    Channel -->|接收消息| Main
    
    subgraph Main["🧠 主会话 (MFDoom 1.5b)"]
        direction TB
        M1[收到消息] --> M2[POST /api/tasks]
        M2 --> M3{轮询 pending-ai}
        M3 -->|有AI任务| M4[sessions_spawn 子程序]
        M4 --> M5[子程序运行]
        M5 --> M6{sessions_yield}
        M6 --> M7[POST /api/tasks/update]
        M3 -->|无AI任务| M3
        
        M8{轮询 decisions/pending/}
        M8 -->|有决策待处理| M9[推送到聊天通道]
        M9 --> M10{老板回复?}
        M10 -->|选A/B| M11[POST /api/decisions/respond]
        M10 -->|其他| M12[确认/重发]
        M11 --> M8
        M8 -->|无决策| M8
    end
    
    subgraph Route["🔄 Route Server (:3456)"]
        direction TB
        R1[接收 POST /api/tasks] --> R2[关键词匹配]
        R2 --> R3[入队列]
        R3 --> R4{调度器}
        R4 -->|简单任务| R5[spawn 子进程 Worker]
        R4 -->|AI任务| R6[标记 pending-ai]
        R4 -->|需决策| R7[创建决策文件]
        R5 --> R8[更新状态注册表]
        R6 --> R8
        R7 --> R8
        R8 --> R9[WebSocket 广播状态变更]
    end
    
    subgraph GUI["🖥️ 桌面GUI (浏览器)"]
        direction TB
        G1[打开 localhost:3456] --> G2[WebSocket 连接]
        G2 --> G3[实时渲染任务列表]
        G3 --> G4{用户点击}
        G4 -->|查看详情| G5[GET /api/tasks/:id]
        G4 -->|决策按钮| G6[POST /api/decisions/respond]
    end
    
    subgraph Worker["⚙️ 执行层"]
        direction TB
        W1[本地Worker] -->|子进程| W2[文件操作/脚本执行]
        W1 -->|完成| W3[POST /api/tasks/callback]
        W4[AI子程序] -->|DeepSeek云端| W5[分析/推理/生成]
        W4 -->|完成| W6[通知主会话]
        W6 --> W7[主会话 POST callback]
    end
    
    %% 返回回路
    W3 --> Route
    W7 --> Route
    Route -->|结果回调| Main
    Main -->|回复结果| Channel
    Channel -->|呈现结果| User

    %% 样式
    classDef inbound fill:#e1f5fe,stroke:#0277bd
    classDef main fill:#fff3e0,stroke:#e65100
    classDef route fill:#e8f5e9,stroke:#2e7d32
    classDef gui fill:#f3e5f5,stroke:#7b1fa2
    classDef worker fill:#fce4ec,stroke:#c62828
    class User inbound
    class Main main
    class Route route
    class GUI gui
    class Worker worker
```

### 时序图：完整消息流转

```mermaid
sequenceDiagram
    participant U as 👤 老板
    participant CH as DingTalk
    participant M as 🧠 主会话
    participant R as 🔄 Route Server
    participant G as 🖥️ GUI
    participant W as ⚙️ Worker/子程序

    Note over U,W: === 场景：老板发消息 "语音识别用百度" ===

    U->>CH: 语音识别用百度
    CH->>M: 收到消息

    M->>R: POST /api/tasks { msg: "语音识别用百度", channel: "dingtalk" }
    activate R
    R->>R: 关键词匹配 → "语音识别" 命中
    R->>R: 创建任务 #1, 状态: queued
    R-->>G: WebSocket → task:new #1
    deactivate R

    R->>R: 调度器出队 #1
    Note over R: 判断：需要 AI 子程序处理
    R->>R: 标记任务 #1 为 pending-ai

    M->>R: GET /api/tasks/pending-ai
    R-->>M: [{ id: "#1", name: "语音识别" }]
    M->>M: sessions_spawn("语音识别用百度")
    M->>R: POST /api/tasks/update { id: "#1", status: "running" }
    R-->>G: WebSocket → task:status "#1" running
    activate W
    W->>W: AI处理中...
    W-->>G: WebSocket → task:status "#1" 进度

    Note over W: AI子程序需要老板抉择
    W->>M: 需要决策: 选百度还是阿里云?
    M->>R: POST /api/decisions { taskId: "#1", prompt: "...", options: [...] }
    R->>R: 任务 #1 状态 → awaiting_decision
    R->>R: 写 decisions/pending/#1.json
    R-->>G: WebSocket → decision:new
    G-->>G: 界面显示"待决策"卡片

    M->>M: 轮询到 decisions/pending/#1.json
    M->>CH: "需要您抉择：语音识别用百度还是阿里云？回复 选A 或 选B"
    CH->>U: 显示消息
    U->>CH: 选A
    CH->>M: 收到回复 "选A"
    M->>R: POST /api/decisions/#1/respond { selection: "A" }
    R->>R: 决策已选，任务继续
    R->>R: 删除 pending 文件
    R-->>G: WebSocket → decision:resolved
    R-->>W: 返回 { selected: "A" }

    W->>W: 继续处理（使用百度API）
    W->>M: 任务完成，返回结果
    M->>R: POST /api/tasks/update { id: "#1", status: "completed", result: "..." }
    R-->>G: WebSocket → task:completed "#1"
    M->>CH: "语音识别已完成，使用了百度API..."
    CH->>U: 显示结果
    deactivate W
```

---

## Route Server 接口设计（完整）

### REST API

| 方法 | 路径 | 用途 | 主会话调用 | GUI调用 | Worker调用 |
|:----:|:----|:----|:---------:|:-------:|:---------:|
| GET | `/ping` | 健康检查 | ✅ | - | - |
| POST | `/api/tasks` | 提交新任务 | ✅ | - | - |
| GET | `/api/tasks` | 列出所有任务 | - | ✅ | - |
| GET | `/api/tasks/:id` | 任务详情 | - | ✅ | - |
| GET | `/api/tasks/pending-ai` | 获取待AI处理 | ✅ | - | - |
| POST | `/api/tasks/:id/update` | 更新任务状态 | ✅ | - | ✅ |
| POST | `/api/tasks/:id/callback` | 任务完成回调 | ✅ | - | ✅ |
| POST | `/api/decisions` | 提交决策请求 | ✅ | - | ✅ |
| GET | `/api/decisions/pending` | 获取待处理决策 | ✅ | - | - |
| POST | `/api/decisions/:id/respond` | 响应决策 | ✅ | ✅ | - |
| GET | `/api/stats` | 统计数据 | - | ✅ | - |

### WebSocket 事件

| 事件名 | 负载 | 触发条件 |
|:-------|:-----|:---------|
| `task:new` | `{ id, name, channel, priority }` | 新任务入队 |
| `task:status` | `{ id, status, progress? }` | 状态变更 |
| `task:completed` | `{ id, result, duration }` | 任务完成 |
| `task:failed` | `{ id, errors }` | 任务失败 |
| `decision:new` | `{ taskId, prompt, options }` | 新决策请求 |
| `decision:resolved` | `{ taskId, selected }` | 决策已响应 |
| `server:health` | `{ uptime, queueLength, workers }` | 每 30 秒心跳 |

---

## 文件结构

```
workspace/
├── route-server.js          # 主路由服务（HTTP + WebSocket + 调度器）
├── route-task.js            # 关键词匹配（已有，复用）
├── lib/
│   ├── task-queue.js        # 优先队列实现
│   ├── task-registry.js     # 任务注册表（内存 + 持久化）
│   ├── decision-manager.js  # 决策管理器
│   ├── scheduler.js         # 调度器循环
│   ├── websocket.js         # WebSocket 服务
│   └── worker-manager.js    # 本地 Worker 管理
├── public/
│   ├── dashboard.html       # 主面板
│   ├── dashboard.css        # 样式
│   └── dashboard.js         # GUI 逻辑（WebSocket 客户端 + AJAX）
├── data/
│   └── task-registry.json   # 持久化快照
├── decisions/
│   ├── pending/             # 待处理的决策请求
│   └── resolved/            # 已处理的决策（归档）
└── logs/
    └── route-server.log     # 运行日志
```

---

## 技术风险与缓解

### 1. 进程崩溃恢复
- **风险**：Route Server 意外退出，队列中的任务丢失
- **缓解**：
  - 状态注册表每 30 秒快照到磁盘
  - 重启时从 `data/task-registry.json` 恢复（running 状态重置为 queued）
  - 主会话定时（每 30 秒）健康检查，发现路由挂了就重启
  - 使用 `process.on('uncaughtException')` 和 `process.on('unhandledRejection')` 兜底

### 2. 死锁 / 队列堆积
- **风险**：Worker 卡住不返回，队列越来越长
- **缓解**：
  - 每个任务有超时时间（简单任务 60s，AI 任务 300s）
  - 超时后标记为 failed 并通知老板
  - 队列最大长度 1000，超过则拒绝新任务
  - Worker 管理器监控子进程，僵尸进程自动 kill

### 3. 主会话挂掉
- **风险**：主会话崩溃，Route Server 的 pending-ai 任务无人认领
- **缓解**：
  - Route Server 记录每个 pending-ai 任务的创建时间
  - 超过 30 秒无人认领的，标记为 timeout 并尝试降级为本地 worker 处理
  - 本地优先：简单任务（文件操作/脚本执行）直接本地 worker 处理，不依赖 AI 子程序

### 4. 端口冲突
- **风险**：3456 端口被占用
- **缓解**：
  - 启动时检测端口可用性，被占则自动 +1 重试（最多 5 次）
  - 写 `data/port.txt` 记录实际端口
  - 自动打开的 dashboard 链接用实际端口

---

## 实施顺序

| 阶段 | 内容 | 预估工时 | 前置依赖 |
|:----:|:-----|:--------:|:---------|
| **1a** | Route Server 骨架：HTTP 服务 + 队列 + 状态注册表 | 1天 | 无 |
| **1b** | 关键词匹配集成 + pending-ai 回调 | 0.5天 | 1a |
| **1c** | Worker 管理（本地子进程） | 1天 | 1a |
| **2a** | GUI 静态页面 + REST API 集成 | 1天 | 1a |
| **2b** | WebSocket 实时更新 | 0.5天 | 2a |
| **2c** | 自启动 + 开机自动打开浏览器 | 0.5天 | 2a |
| **3a** | 决策管理器 + 文件协议 | 0.5天 | 1a |
| **3b** | 主会话决策轮询 + 聊天回复解析 | 0.5天 | 3a |
| **4** | 集成测试 + 日志 + 异常处理 | 1天 | 全部 |
| **合计** | | **~6.5天** | |

---

## 总结

| 组件 | 技术选型 | 核心优势 |
|:-----|:---------|:---------|
| **路由服务** | Node.js HTTP + WebSocket | 零外部依赖，与现有架构兼容，支持实时推送 |
| **桌面GUI** | 浏览器 HTML/JS/CSS SPA | 不计入内存占用的方案，热更新，开发效率高 |
| **决策推送** | 文件协议 + DingTalk API | 解耦路由与消息通道，老板可在任何通道回复 |
| **进程管理** | PID 文件 + 健康检查 | Gateway 重启后自动重生，崩溃自恢复 |
| **数据持久** | JSON 快照 | 零依赖，重启可恢复，可用 Git 追踪历史 |

整个系统只有 Node.js 内置模块，**零 npm 依赖**。保持轻量、可维护、易扩展。
