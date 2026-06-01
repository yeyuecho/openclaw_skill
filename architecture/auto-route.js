/**
 * auto-route.js — 强制消息路由脚本（含时间感知问候）
 *
 * 读取 data/classify-pending/ 中最新的未处理 .json 文件，
 * 根据 classify.type 输出路由指令 + 时间感知问候语。
 *
 * 用法: node auto-route.js "(用户消息原文)"
 * 输出: 两行纯文本
 *   GREETING:🌤️ 下午好！收到~     → 时间感知问候语
 *   ROUTE:SPAWN|消息原文            → 走子程序（一级云端 DeepSeek）
 *   ROUTE:DIRECT                    → 主会话直接回复
 */

const fs = require('fs');
const path = require('path');

const PENDING_DIR = path.join(__dirname, 'data', 'classify-pending');
const userMessage = process.argv[2] || '';

// ============================================================
// getGreeting() — 根据当前小时返回时间感知问候模板
// 模板与 AGENTS.md 保持一致
// ============================================================
function getGreeting() {
  const hour = new Date().getHours();

  if (hour >= 6 && hour < 9)  return '🌅 早啊~收到！';
  if (hour >= 9 && hour < 12) return '☀️ 早上好！收到~';
  if (hour >= 12 && hour < 14) return '🍚 中午好！收到~';
  if (hour >= 14 && hour < 18) return '🌤️ 下午好！收到~';
  if (hour >= 18 && hour < 21) return '🌆 晚上好！收到~';
  if (hour >= 21)              return '🌙 收到~';
  /* hour >= 0 && hour < 6 */   return '🌜 深夜了~收到！';
}

// ============================================================
// getVibeEmoji() — 从 vibe 字段获取情绪表情前缀
// ============================================================
function getVibeEmoji(vibe) {
  switch (vibe) {
    case 'urgent':    return '⚡';
    case 'gracious':  return '🙏';
    case 'tired':     return '😴';
    case 'farewell':  return '👋';
    case 'cheerful':  return '😊';
    default:          return '';
  }
}

// ============================================================
// 输出问候语
// ============================================================
const greetingText = getGreeting();
console.log('GREETING:' + greetingText);

// 获取待处理文件列表
let files = [];
try {
  files = fs.readdirSync(PENDING_DIR)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => {
      // 从文件名中提取数字时间戳（第一个纯数字段）
      const extractTs = (name) => {
        const match = name.match(/(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      };
      return extractTs(b) - extractTs(a); // 最新在前
    });
} catch {
  // 目录不存在或无权限
}

if (files.length === 0) {
  // 没有任何 pending 文件 → 直接跑 test-classify.js 实时分类
  try {
    const cp = require('child_process');
    const result = cp.execSync(
      'node "' + __dirname + '\\test-classify.js" --json "' + userMessage.replace(/"/g, '\\"') + '"',
      { timeout: 5000, encoding: 'utf8' }
    );
    const classify = JSON.parse(result.trim());
    const directType = classify.type || 'chat';
    const vibe = classify.vibe || 'neutral';
    if (['non-chat', 'simple', 'complex'].includes(directType)) {
      console.log('ROUTE:SPAWN|' + userMessage);
    } else {
      console.log('ROUTE:DIRECT');
    }
    process.exit(0);
  } catch {
    console.log('ROUTE:DIRECT');
    process.exit(0);
  }
}

// 读取最新的未处理文件
const latestFile = path.join(PENDING_DIR, files[0]);
let pending;
try {
  pending = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
} catch {
  console.log('ROUTE:DIRECT');
  process.exit(0);
}

// 根据 classify.type 决定路由
const classifyType = pending.classify && pending.classify.type;
const content = pending.content || userMessage;

// 如果有 vibe 字段，也写入
const vibe = pending.vibe || (pending.classify && pending.classify.vibe) || '';

// 所有需要走子程序的类型
const SPAWN_TYPES = ['non-chat', 'simple', 'complex'];

if (SPAWN_TYPES.includes(classifyType)) {
  // 非闲聊 → spawn 一级云端 DeepSeek
  console.log('ROUTE:SPAWN|' + content);
} else {
  // chat 或未知类型 → 直接回复
  console.log('ROUTE:DIRECT');
}

// 无论什么类型，处理完后删除这个 pending 文件
// 避免旧文件堆积导致下次读到脏数据
try { fs.unlinkSync(latestFile); } catch {}
