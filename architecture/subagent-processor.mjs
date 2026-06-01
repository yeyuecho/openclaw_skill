#!/usr/bin/env node
/**
 * subagent-processor.mjs — 任务处理守护进程
 *
 * 配合 message-interceptor 插件工作。
 * 轮询 data/subagent-queue/ 目录，对每个非聊天任务：
 *   1. 使用 openclaw agent 创建隔离子会话执行任务
 *   2. 将结果通过 --deliver 发送回用户
 *   3. 清理已完成的任务文件
 *
 * 启动： node subagent-processor.mjs
 * 可选： --once (只处理当前队列，然后退出)
 *       --verbose (详细日志)
 *
 * 工作目录： <workspace>/ (自动检测)
 */

import { readFileSync, readdirSync, unlinkSync, renameSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// ─── 自检测工作目录 ──────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = __dirname;
const QUEUE_DIR = join(WORKSPACE_DIR, "data", "subagent-queue");
const ACTIVE_DIR = join(QUEUE_DIR, "active");
const FAILED_DIR = join(QUEUE_DIR, "failed");

// 确保目录存在
try { mkdirSync(ACTIVE_DIR, { recursive: true }); } catch {}
try { mkdirSync(FAILED_DIR, { recursive: true }); } catch {}

// ─── 配置 ────────────────────────────────────────────────

const CONFIG = {
  POLL_INTERVAL_MS: 2000,     // 轮询间隔
  AGENT_TIMEOUT_SECONDS: 120, // 子程序超时
  MODEL: "deepseek/deepseek-v4-flash", // 子程序默认模型
  MAX_RETRIES: 2,             // 每个任务最大重试次数
};

const VERBOSE = process.argv.includes("--verbose");
const RUN_ONCE = process.argv.includes("--once");

// ─── 日志 ────────────────────────────────────────────────

function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}

function verbose(...args) {
  if (VERBOSE) log("[DEBUG]", ...args);
}

// ─── 读取任务文件 ────────────────────────────────────────

function readTaskFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    log(`[ERROR] 无法读取任务文件 ${filePath}: ${e.message}`);
    return null;
  }
}

// ─── 主处理逻辑 ─────────────────────────────────────────

async function processTask(task, filePath) {
  const { taskId, content, channelId, senderId, classifyResult } = task;

  // 使用临时子会话 key（每次任务独立）
  const sessionKey = `subagent:task:${taskId}`;

  // 构建 openclaw agent 命令参数
  const args = [
    "agent",
    "--session-key", sessionKey,
    "-m", content,
    "--model", CONFIG.MODEL,
    "--deliver",
  ];

  // 指定回复通道（如果已知）
  if (channelId) {
    args.push("--reply-channel", channelId);
  }
  if (senderId) {
    args.push("--reply-to", senderId);
  }

  verbose(`执行: openclaw ${args.join(" ")}`);

  try {
    const stdout = execSync(`openclaw ${args.join(" ")}`, {
      timeout: CONFIG.AGENT_TIMEOUT_SECONDS * 1000,
      windowsHide: true,
      encoding: "utf-8",
    });
    log(`✅ 任务 ${taskId.slice(0, 8)} 完成 (${content.slice(0, 40)})`);
    verbose(`输出: ${stdout.slice(0, 200)}`);
    return true;
  } catch (e) {
    log(`❌ 任务 ${taskId.slice(0, 8)} 失败: ${e.message}`);
    if (e.stdout) verbose(`STDOUT: ${e.stdout}`);
    if (e.stderr) verbose(`STDERR: ${e.stderr}`);
    return false;
  }
}

// ─── 轮询主循环 ─────────────────────────────────────────

async function pollLoop() {
  log("🟢 subagent-processor 已启动");
  log(`   队列目录: ${QUEUE_DIR}`);
  log(`   轮询间隔: ${CONFIG.POLL_INTERVAL_MS}ms`);
  log(`   运行模式: ${RUN_ONCE ? "单次" : "持续守护"}`);

  let iterationCount = 0;

  while (true) {
    iterationCount++;
    verbose(`轮询 #${iterationCount}`);

    let files = [];
    try {
      files = readdirSync(QUEUE_DIR)
        .filter(f => f.endsWith(".json") && !f.startsWith("."))
        .sort() // 最早创建的优先
        .map(f => join(QUEUE_DIR, f));
    } catch {
      // 目录不存在或无权限
      if (iterationCount === 1) {
        log(`[WARN] 队列目录不存在或不可读: ${QUEUE_DIR}`);
        try { mkdirSync(QUEUE_DIR, { recursive: true }); log(`✅ 已创建队列目录`); } catch {}
      }
    }

    if (files.length > 0) {
      log(`📦 发现 ${files.length} 个待处理任务`);

      for (const filePath of files) {
        // 检查文件是否仍然存在（可能被其他进程处理了）
        if (!existsSync(filePath)) continue;

        const fileName = filePath.split("\\").pop() || filePath.split("/").pop();
        const task = readTaskFile(filePath);

        if (!task) {
          // 损坏的任务文件，移到 failed
          const failedPath = join(FAILED_DIR, fileName);
          try { renameSync(filePath, failedPath); } catch {}
          continue;
        }

        // 移到 active 目录表示开始处理
        const activePath = join(ACTIVE_DIR, fileName);
        let currentPath = filePath;
        try { renameSync(filePath, activePath); currentPath = activePath; } catch {}

        // 处理任务
        let success = false;
        for (let retry = 0; retry <= CONFIG.MAX_RETRIES; retry++) {
          if (retry > 0) {
            log(`🔄 重试 #${retry}/${CONFIG.MAX_RETRIES} 任务 ${task.taskId?.slice(0, 8)}`);
            // 短暂延迟后重试
            await new Promise(r => setTimeout(r, 1000));
          }
          success = await processTask(task, currentPath);
          if (success) break;
        }

        if (success) {
          // 成功：删除 active 文件
          try { unlinkSync(currentPath); } catch {}
        } else {
          // 失败：移到 failed 目录
          const failedPath = join(FAILED_DIR, fileName);
          try { renameSync(currentPath, failedPath); } catch {}
          log(`💀 任务 ${task.taskId?.slice(0, 8)} 已移至失败队列`);
        }
      }
    }

    if (RUN_ONCE) {
      log("🏁 单次模式已完成，退出");
      break;
    }

    // 等待下次轮询
    await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
  }
}

// ─── 启动 ────────────────────────────────────────────────

process.on("SIGINT", () => { log("\n🛑 收到 SIGINT，正在停止..."); process.exit(0); });
process.on("SIGTERM", () => { log("\n🛑 收到 SIGTERM，正在停止..."); process.exit(0); });

pollLoop().catch(e => {
  console.error("[FATAL]", e);
  process.exit(1);
});
