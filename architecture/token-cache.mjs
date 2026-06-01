#!/usr/bin/env node
/**
 * token-cache.mjs — DeepSeek Token 本地缓存方案
 * ==============================================
 *
 * 实时缓存每次 API 调用的 token 消耗到本地文件，
 * Gateway 崩溃恢复后自动读取，避免上下文重建浪费 token。
 *
 * 使用方式：
 *   node token-cache.mjs --save <sessionKey> <inputTokens> <outputTokens> <model> [messageSummary]
 *   node token-cache.mjs --load <sessionKey>
 *   node token-cache.mjs --clean [days=7]
 *   node token-cache.mjs --stats
 *   node token-cache.mjs --list
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';

const CACHE_DIR = join(import.meta.dirname, 'data', 'cache');
const CACHE_FILE_PREFIX = 'token-cache-';

// ============================================================
// 确保缓存目录存在
// ============================================================
function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    console.error(`[token-cache] 创建缓存目录: ${CACHE_DIR}`);
  }
}

// ============================================================
// 辅助：生成缓存文件名（sessionKey 的 hash + 时间戳）
// ============================================================
function cacheFilename(sessionKey) {
  const hash = createHash('sha256').update(sessionKey).digest('hex').slice(0, 16);
  const ts = Date.now();
  return `${CACHE_FILE_PREFIX}${hash}-${ts}.json`;
}

// ============================================================
// 辅助：解析缓存文件名获取时间戳
// ============================================================
function parseCacheTimestamp(filename) {
  const match = filename.match(/^token-cache-[a-f0-9]{16}-(\d+)\.json$/);
  return match ? parseInt(match[1], 10) : null;
}

// ============================================================
// saveCache(sessionKey, data)
// 写入一条缓存记录。
// data: { inputTokens, outputTokens, model, messageSummary?, timestamp? }
// ============================================================
export function saveCache(sessionKey, data) {
  ensureCacheDir();
  const record = {
    sessionKey,
    timestamp: data.timestamp || Date.now(),
    date: new Date(data.timestamp || Date.now()).toISOString(),
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    totalTokens: (data.inputTokens || 0) + (data.outputTokens || 0),
    model: data.model || 'unknown',
    messageSummary: data.messageSummary || '',
  };
  const filePath = join(CACHE_DIR, cacheFilename(sessionKey));
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
  console.error(`[token-cache] ✅ 已缓存: ${filePath}`);
  return record;
}

// ============================================================
// loadCache(sessionKey)
// 读取该会话的所有缓存（可能有多个文件，按时间排序）。
// 返回最新一条缓存记录，或者该会话的总计数据。
// ============================================================
export function loadCache(sessionKey, options = {}) {
  ensureCacheDir();
  const { mode = 'latest' } = options; // 'latest' | 'sum'
  const files = readdirSync(CACHE_DIR).filter(f => f.startsWith(CACHE_FILE_PREFIX) && f.endsWith('.json'));
  const records = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(CACHE_DIR, file), 'utf-8');
      const record = JSON.parse(content);
      if (record.sessionKey === sessionKey) {
        records.push(record);
      }
    } catch (err) {
      console.error(`[token-cache] ⚠️ 读取失败: ${file}`, err.message);
    }
  }

  // 按时间排序
  records.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  if (records.length === 0) {
    console.error(`[token-cache] ℹ️ 无缓存记录: ${sessionKey}`);
    return null;
  }

  if (mode === 'latest') {
    const latest = records[records.length - 1];
    console.error(`[token-cache] 📖 加载最新缓存: ${sessionKey} (${records.length}条记录)`);
    return latest;
  }

  // mode === 'sum'
  const sum = {
    sessionKey,
    records: records.length,
    totalInputTokens: records.reduce((s, r) => s + (r.inputTokens || 0), 0),
    totalOutputTokens: records.reduce((s, r) => s + (r.outputTokens || 0), 0),
    totalTokens: records.reduce((s, r) => s + (r.totalTokens || r.inputTokens + r.outputTokens || 0), 0),
    firstCache: records[0].date,
    lastCache: records[records.length - 1].date,
    models: [...new Set(records.map(r => r.model))],
  };
  console.error(`[token-cache] 📊 缓存统计: ${sessionKey} = ${sum.totalTokens} tokens (${sum.records}条)`);
  return sum;
}

// ============================================================
// cleanOldCache(days=7)
// 删除超过指定天数的缓存文件。
// ============================================================
export function cleanOldCache(days = 7) {
  ensureCacheDir();
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const files = readdirSync(CACHE_DIR).filter(f => f.startsWith(CACHE_FILE_PREFIX) && f.endsWith('.json'));
  let deleted = 0;
  let kept = 0;
  let expiredTokens = 0;

  for (const file of files) {
    const filePath = join(CACHE_DIR, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const record = JSON.parse(content);
      const recordTs = record.timestamp || parseCacheTimestamp(file) || 0;

      if (recordTs > 0 && recordTs < cutoff) {
        expiredTokens += (record.totalTokens || record.inputTokens + record.outputTokens || 0);
        unlinkSync(filePath);
        deleted++;
        console.error(`[token-cache] 🗑️ 已删除过期缓存: ${file} (${new Date(recordTs).toISOString()})`);
      } else {
        kept++;
      }
    } catch {
      // 如果文件读不了或损坏，也删除
      try { unlinkSync(filePath); deleted++; } catch {}
    }
  }

  console.error(`[token-cache] 🧹 清理完成: 删除 ${deleted} 个, 保留 ${kept} 个, 过期 tokens: ${expiredTokens}`);
  return { deleted, kept, expiredTokens };
}

// ============================================================
// getStats()
// 获取缓存统计
// ============================================================
export function getStats() {
  ensureCacheDir();
  const files = readdirSync(CACHE_DIR).filter(f => f.startsWith(CACHE_FILE_PREFIX) && f.endsWith('.json'));
  let totalInput = 0;
  let totalOutput = 0;
  let totalTokens = 0;
  let entryCount = 0;
  let sessionKeys = new Set();
  let oldestTs = Infinity;
  let newestTs = 0;
  let totalSize = 0;
  let staleFiles = 0;
  const now = Date.now();
  const cutoff7days = now - 7 * 24 * 60 * 60 * 1000;

  for (const file of files) {
    const filePath = join(CACHE_DIR, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const record = JSON.parse(content);
      totalInput += record.inputTokens || 0;
      totalOutput += record.outputTokens || 0;
      totalTokens += record.totalTokens || record.inputTokens + record.outputTokens || 0;
      entryCount++;
      sessionKeys.add(record.sessionKey || 'unknown');
      const ts = record.timestamp || 0;
      if (ts > 0) {
        if (ts < oldestTs) oldestTs = ts;
        if (ts > newestTs) newestTs = ts;
        if (ts < cutoff7days) staleFiles++;
      }
      totalSize += statSync(filePath).size;
    } catch {
      // 跳过损坏文件
    }
  }

  const stats = {
    totalFiles: files.length,
    validEntries: entryCount,
    uniqueSessions: sessionKeys.size,
    totalTokens,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    cacheSizeBytes: totalSize,
    cacheSizeMB: (totalSize / 1024 / 1024).toFixed(2),
    staleEntries: staleFiles,
    dateRange: oldestTs < Infinity
      ? `${new Date(oldestTs).toISOString()} ~ ${new Date(newestTs).toISOString()}`
      : '无数据',
  };

  console.error(`[token-cache] 📊 缓存总览:
  - 文件数:       ${stats.totalFiles}
  - 有效条目:     ${stats.validEntries}
  - 唯一会话:     ${stats.uniqueSessions}
  - 总 Tokens:    ${stats.totalTokens.toLocaleString()}
  - 存储大小:     ${stats.cacheSizeMB} MB
  - 过期条目:     ${stats.staleEntries}（>7天）
  - 日期范围:     ${stats.dateRange}`);

  return stats;
}

// ============================================================
// CLI 入口
// ============================================================
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(`
用法:
  node token-cache.mjs --save <sessionKey> <inputTokens> <outputTokens> <model> [messageSummary]
  node token-cache.mjs --load <sessionKey> [--sum]
  node token-cache.mjs --clean [days=7]
  node token-cache.mjs --stats
  node token-cache.mjs --list

示例:
  node token-cache.mjs --save "dingtalk:user123" 1500 320 "deepseek-v4-flash" "用户询问天气"
  node token-cache.mjs --load "dingtalk:user123"
  node token-cache.mjs --clean 7
  node token-cache.mjs --stats
`);
    return;
  }

  const cmd = args[0];

  switch (cmd) {
    case '--save': {
      if (args.length < 5) {
        console.error('❌ 参数不足: --save <sessionKey> <inputTokens> <outputTokens> <model> [messageSummary]');
        process.exit(1);
      }
      const result = saveCache(args[1], {
        inputTokens: parseInt(args[2], 10),
        outputTokens: parseInt(args[3], 10),
        model: args[4],
        messageSummary: args.slice(5).join(' ') || '',
      });
      console.log(JSON.stringify(result));
      break;
    }

    case '--load': {
      if (args.length < 2) {
        console.error('❌ 参数不足: --load <sessionKey> [--sum]');
        process.exit(1);
      }
      const mode = args.includes('--sum') ? 'sum' : 'latest';
      const result = loadCache(args[1], { mode });
      if (result) {
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    case '--clean': {
      const days = parseInt(args[1], 10) || 7;
      const result = cleanOldCache(days);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case '--stats': {
      const stats = getStats();
      console.log(JSON.stringify(stats, null, 2));
      break;
    }

    case '--list': {
      ensureCacheDir();
      const files = readdirSync(CACHE_DIR)
        .filter(f => f.startsWith(CACHE_FILE_PREFIX) && f.endsWith('.json'))
        .sort()
        .map(f => {
          const fp = join(CACHE_DIR, f);
          try {
            const content = readFileSync(fp, 'utf-8');
            const r = JSON.parse(content);
            return {
              file: f,
              size: statSync(fp).size,
              sessionKey: r.sessionKey,
              date: r.date,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              model: r.model,
              summary: (r.messageSummary || '').slice(0, 40),
            };
          } catch {
            return { file: f, size: statSync(fp).size, error: '损坏' };
          }
        });
      console.log(JSON.stringify(files, null, 2));
      break;
    }

    default:
      console.error(`❌ 未知命令: ${cmd}`);
      process.exit(1);
  }
}

// ============================================================
// 作为脚本直接运行
// ============================================================
if (process.argv[1] && (process.argv[1].endsWith('token-cache.mjs') || process.argv[1].endsWith('token-cache'))) {
  main();
}
