# 宿主机硬件配置速查模板

用户安装本技能后，AI Agent 会自动运行 `scripts/detect-hardware.ps1` 获取当前电脑配置。
以下是常见配置对应的模型策略建议，供参考。

## 模板格式

将检测结果保存到 `references/hardware-profile.json`，AI Agent 会读取此文件做资源预算决策。

```json
{
  "device": "DESKTOP-XXXXXXX",
  "os": "Windows 11 / macOS / Linux",
  "detectedAt": "2026-05-30T15:00:00+08:00",
  "gpu": {
    "name": "NVIDIA GeForce GTX 960",
    "vramTotalMB": 4096,
    "vramFreeMB": 1800,
    "recommendedModelSize": "≤1.5B"
  },
  "cpu": {
    "cores": 4,
    "logicalProcessors": 4,
    "maxClockGHz": 3.6
  },
  "memory": {
    "totalGB": 16.0,
    "freeGB": 12.5
  },
  "summary": {
    "hasGPU": true,
    "gpuCapable": true,
    "recommendation": "可运行本地模型（建议 ≤1.5B）"
  }
}
```

## 模型选择决策树

```
宿主机有 GPU？
├── 是 → 显存 ≥ 3GB？
│   ├── 是 → 可用内存 ≥ 4GB？
│   │   ├── 是 → 🟢 本地模型可用
│   │   └── 否 → 🟡 轻量任务走本地，复杂任务走云端
│   └── 否 → 🟡 CPU 推理极慢，建议全走云端
└── 否 → 无 GPU
    └── CPU 核心 ≥ 4？
        ├── 是 → 🟡 仅超轻量任务走本地（≤0.5B），其余走云端
        └── 否 → 🔴 全走云端，本地体验太差
```

## 任务资源分类速查

### 🟢 低负载（本地无感）
- 日常闲聊问候
- 查询文件/目录
- 读取短文本并摘要
- 简单信息分类整理
- 系统状态检查
- 日程查询提醒
- 短文本翻译润色
- 回答已知知识库问题
- Yes/No 确认

### 🟡 中负载（本地可能卡）
- 写少量代码（< 50行）
- 中等长度文档分析
- 简单表格数据处理
- 图片识别（简图）

### 🔴 高负载（直接走云端）
- 多文件批量处理
- 大文档分析（> 100页）
- 复杂推理与多步任务
- 联网搜索
- 任何工具调用（exec/write/edit 等）
- 代码审查与调试
- 网络请求与 API 调用
- 写复盘文档/结构化输出
- 知识库读写
