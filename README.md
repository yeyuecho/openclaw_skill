# OpenClaw Skills Repository

This repository hosts [OpenClaw](https://github.com/openclaw/openclaw) AI Agent skills.

## Architecture

- **[Three-Tier Agent Architecture](architecture/architecture-design.md)** — 三级子程序分配架构设计文档。主会话（无模型）→ 一级统筹（云端/本地）→ 二级执行 → 三级原子，自动化消息路由与分类引擎。
- **[Task Router System Design](architecture/design-task-router-system.md)** — 常驻路由子程序 + 桌面 GUI + 决策推送的全链路设计方案。

## Core Scripts

- **[auto-route.js](architecture/auto-route.js)** — 强制消息路由脚本，包含时间感知问候和多通道统一入口路由逻辑。
- **[test-classify.js](architecture/test-classify.js)** — 一级分类引擎原型，纯规则本地分类器（3ms内分类），不支持 AI 推理。
- **[token-cache.mjs](architecture/token-cache.mjs)** — DeepSeek API Token 缓存系统，Gateway 崩溃恢复后自动加载，避免上下文重建浪费 token。
- **[subagent-processor.mjs](architecture/subagent-processor.mjs)** — 子程序上下文处理器，管理子会话生命周期与结果汇总。
- **[install-token-cache.ps1](architecture/install-token-cache.ps1)** — Token 缓存安装脚本。
- **[HEARTBEAT.md](architecture/HEARTBEAT.md)** — 心跳检测配置文件，用于周期性任务检查。

## Skills

- **[model-resource-budget](skills/model-resource-budget/)** — 智能模型分层调度。自动检测宿主机硬件配置，结合任务复杂度做资源预算评估，在本地轻量模型和云端高性能模型之间智能路由。
- **[excel-office-tips](skills/excel-office-tips/)** — Excel/PPT高效办公技巧，涵盖数据透视表分析、VLOOKUP匹配、二级联动下拉菜单等11个高频场景，附带VBA代码和Excel公式模板。
- **[task-splitter](skills/task-splitter/)** — 智能任务拆分引擎。将复杂任务自动拆解为独立子任务，子智能体并行执行，默认使用本地模型，不溢出不费钱。
