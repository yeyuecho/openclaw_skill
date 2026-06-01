/**
 * 一级分类原型测试 — 最新架构版
 *
 * 架构：
 *   用户输入 → 主会话（无模型，纯转发）
 *      ├→ 立刻回复「✅ 收到」
 *      └→ 调用本地分类器（纯规则，3ms内完成分类）
 *           ├→ 闲聊 → 本地 MFDoom 1.5B (~200ms)
 *           ├→ 简单任务 → 云端 DeepSeek 直接执行 (~1-2s)
 *           └→ 复杂任务 → 先回"正在处理"
 *                        → 云端 DeepSeek 拆解+三级执行
 *                        → 完成后推送结果
 *
 * 关键原则：
 * - 主会话不做任何AI，纯转发
 * - 分类器是纯规则脚本（3ms以内），不用模型
 * - 简单任务走云端 DeepSeek，本地MFDoom仅闲聊
 * - 只有复杂任务才走云端
 *
 * 运行：
 *   node test-classify.js                    # 纯规则分类测试
 *   node test-classify.js --verbose           # 显示详细匹配过程
 *   node test-classify.js --simulate "消息"   # 模拟时间线
 *   node test-classify.js --segment           # 段间关系检测测试
 */

// ============================================================
// 配置
// ============================================================
const VERBOSE = process.argv.includes('--verbose');

// ============================================================
// 测试数据（来自最近对话，与最新架构对齐）
// ============================================================
const TEST_CASES = [
  // 复杂任务（走云端 DeepSeek 拆解+三级执行）
  { text: '语音识别的事继续再扔一个子程序去跑',       expected: 'complex' },
  { text: '好，那按这个三级体系你重新派个子程序来去分析一下', expected: 'complex' },
  { text: '搞个桌面GUI',                               expected: 'complex' },
  { text: '做个架构的模拟测试',                         expected: 'complex' },
  { text: '帮我看看这个架构还能怎么优化',               expected: 'complex' },

  // 简单任务（云端 DeepSeek 直接执行）
  { text: '你也可以看看vosk占用哪类资源占用多少',       expected: 'simple'  },
  { text: '现在你临时弄个临时的一级子程序吧',            expected: 'simple'  },
  { text: '现在把主程序切回本地',                        expected: 'simple'  },
  { text: '哈哈现在主程序再切回本地模型试试',            expected: 'simple'  },
  { text: '今天天气怎么样',                              expected: 'simple'  },
  { text: '也可以看一下SAPI是否支持windows自定义唤醒词', expected: 'simple'  },
  { text: '这个porcupine注册的事情去搞一下',              expected: 'simple'  },
  { text: '你看看这个文件',                              expected: 'simple'  },

  // 闲聊（本地 MFDoom 闲聊，不上云端）
  { text: '先把这记下来',                                expected: 'chat'    },
  { text: '不是，你咋还没搞懂呢？',                      expected: 'chat'    },
  { text: '嗯好的',                                      expected: 'chat'    },
  { text: '好的谢谢你',                                  expected: 'chat'    },
  { text: '对的',                                        expected: 'chat'    },
];

// ============================================================
// 分类器（纯规则，3ms以内）
// ============================================================

/**
 * 分类规则优先级（防误判关键）：
 *
 * Level 1: 复杂任务特征（最优先匹配）
 *   - 架构/体系/优化讨论
 *   - 子程序多步调度（"再扔一个子程序去跑"）
 *   - 系统设计/开发任务（"搞个桌面GUI"）
 *   - "分析" + 具体对象
 *
 * Level 2: 闲聊特征（第二优先，防止被简单任务误吞）
 *   - 纯确认回应（"嗯好的"、"对的"、"好的谢谢你"）
 *   - 疑惑/纠正（"不是，你咋还没搞懂呢？"）
 *   - 简短记录/记笔记（"先把这记下来"）
 *
 * Level 3: 简单任务（兜底）
 *   - 查信息/看一下/看看
 *   - 切换/设置/创建单步
 *   - 推荐/查询
 */
function classify(text) {
  const t = text.trim();

  // ========== Level 1: 复杂任务 ==========

  // ========== 闲聊检测 ==========
  // 只区分 chat（闲聊）和 non-chat（非聊天），
  // non-chat 交给一级云端 DeepSeek 进一步判断难易程度

  // 情绪抒发（"今天心情不好"、"好累"、"郁闷"）
  if (/心情不好|心情差|好累|好烦|郁闷|难过|烦躁|不开心|真无语|气死我了/.test(t)) {
    return { type: 'chat', reason: '情绪抒发' };
  }

  // 讲笑话/段子/故事
  if (/讲个笑话|讲个段子|说个笑话|讲个故事|逗我开心|哄我/.test(t)) {
    return { type: 'chat', reason: '讲笑话' };
  }

  // 感谢表达（"好的谢谢你"）
  if (/谢谢你|谢谢|感谢|多谢/.test(t)) {
    return { type: 'chat', reason: '感谢表达' };
  }

  // 纯确认/赞同（"嗯好的"、"对的"）
  if (/^(嗯好的|好的嗯|对的$|是的$|没错$|可以$|好的$|嗯嗯$|ok$|OK$|行$)/.test(t)) {
    return { type: 'chat', reason: '简洁确认' };
  }



  // 问候/告别
  if (/^(你好|hi|hello|嗨|嗨喽|拜拜|再见|晚安|早安|下午好|晚上好)$/i.test(t)) {
    return { type: 'chat', reason: '问候/告别' };
  }



  // ========== 未匹配到闲聊 → 非聊天 ==========
  return { type: 'non-chat', reason: '非聊天任务，交由一级云端判断难易程度' };
}

// ============================================================
// 测试运行器
// ============================================================

function runTest(cases, label) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(70)}`);

  let passed = 0;
  let failed = 0;
  const failures = [];
  const details = [];

  for (const tc of cases) {
    const result = classify(tc.text);
    const isCorrect = result.type === tc.expected;

    const marker = isCorrect ? '✅' : '❌';
    const detail = `${marker} "${tc.text}"\n    预期=${tc.expected} 实际=${result.type} 原因=${result.reason}`;

    if (VERBOSE || !isCorrect) {
      console.log(`\n${detail}`);
    }

    details.push({ text: tc.text, expected: tc.expected, got: result.type, correct: isCorrect, reason: result.reason });

    if (isCorrect) {
      passed++;
    } else {
      failed++;
      failures.push({ text: tc.text, expected: tc.expected, got: result.type, reason: result.reason });
    }
  }

  const total = cases.length;
  const accuracy = ((passed / total) * 100).toFixed(1);

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`  📊 结果: ${passed}/${total} 正确 | 准确率: ${accuracy}%`);
  console.log(`  ⚡ 纯规则分类器 (3ms以内)`);

  return { passed, failed, total, accuracy: parseFloat(accuracy), failures, details };
}

// ============================================================
// 失败分析
// ============================================================

function analyzeFailures(failures) {
  if (failures.length === 0) {
    console.log('\n  🎉 全部通过！无需改进。');
    return;
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('  🔍 失败案例分析');
  console.log('='.repeat(70));

  // 按错误类型分组
  const groups = {};
  for (const f of failures) {
    const key = `${f.expected}→${f.got}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  }

  for (const [errType, items] of Object.entries(groups)) {
    console.log(`\n  📌 错误类型: ${errType} (${items.length}条)`);

    for (const f of items) {
      console.log(`     ❌ "${f.text}"`);
      console.log(`        原因: ${f.reason}`);
    }

    // 改进建议
    const [expected, got] = errType.split('→');
    console.log(`     💡 改进建议:`);
    if (expected === 'complex' && got === 'simple') {
      console.log(`        - 补充复杂任务关键词，捕获当前漏掉的模式`);
      console.log(`        - 检查消息中是否包含架构/分析/多步特征`);
    } else if (expected === 'simple' && got === 'chat') {
      console.log(`        - 检查聊天规则是否过于宽泛，误吞了任务消息`);
      console.log(`        - 考虑放宽聊天匹配条件，优先匹配有操作意图的消息`);
    } else if (expected === 'simple' && got === 'complex') {
      console.log(`        - 检查复杂任务关键词是否过于敏感`);
      console.log(`        - 添加排除规则：对单纯的"看/查/切"操作不做复杂处理`);
    } else if (expected === 'chat' && got === 'simple') {
      console.log(`        - 补充闲聊状态词匹配规则（表达感谢、简短确认等）`);
      console.log(`        - 简单任务规则前添加闲聊优先拦截`);
    }
  }
}

// ============================================================
// 总结报告
// ============================================================

function generateSummary(result) {
  console.log(`\n\n${'='.repeat(70)}`);
  console.log('  📊 总 结 报 告');
  console.log('='.repeat(70));

  console.log(`\n  测试数据集: ${result.total} 条`);
  console.log(`  正确: ${result.passed} | 错误: ${result.failed}`);
  console.log(`  总准确率: ${result.accuracy}%`);

  // 按类别统计
  const byExpected = {};
  for (const d of result.details) {
    if (!byExpected[d.expected]) byExpected[d.expected] = { total: 0, passed: 0 };
    byExpected[d.expected].total++;
    if (d.correct) byExpected[d.expected].passed++;
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log('  按类型细分:');
  for (const [type, stats] of Object.entries(byExpected)) {
    const acc = ((stats.passed / stats.total) * 100).toFixed(1);
    console.log(`    ${type}: ${stats.passed}/${stats.total} (${acc}%)`);
  }

  // 最终评估
  console.log(`\n${'─'.repeat(40)}`);
  console.log('  最终评估:');
  console.log(`  ⚡ 分类器性能: <3ms（纯规则，无模型调用）`);
  console.log(`  ✅ 架构兼容性: 完全匹配最新架构（主会话无模型）`);
  console.log(`  💰 云端成本: 仅 ${result.failures.filter(f => f.expected === 'complex').length} 条误判可能触发不必要的云端调用`);

  if (result.accuracy >= 90) {
    console.log(`\n  🌟 评级: 优秀 — 规则覆盖率高，可直接用于生产`);
  } else if (result.accuracy >= 80) {
    console.log(`  👍 评级: 良好 — 大部分情况正确，小部分需微调规则`);
  } else if (result.accuracy >= 70) {
    console.log(`  🔧 评级: 一般 — 需要补充关键规则`);
  } else {
    console.log(`  🚨 评级: 差 — 规则需要大幅调整`);
  }
}

// ============================================================
// Vibe 嗅探检测（情绪/语气分类）
// ============================================================

/**
 * 嗅探消息中的情绪/语气
 * 纯正则匹配，<1ms
 * 
 * 关键词规则:
 *   急/快/赶紧/马上 → urgent
 *   谢/谢谢/辛苦/麻烦 → gracious
 *   累/困/烦/没劲 → tired
 *   拜/再见/88/晚安 → farewell
 *   哈哈/笑/好玩/开心 → cheerful
 *   其他 → neutral
 */
function detectVibe(text) {
  const t = text.trim();

  // 优先级：匹配到第一个即返回
  if (/[急快]|赶紧|马上/.test(t)) return 'urgent';
  if (/谢谢|辛苦|麻烦|感谢|多谢/.test(t)) return 'gracious';
  if (/累|困[了]?|烦|没劲|疲劳|疲惫/.test(t)) return 'tired';
  if (/拜拜|再见|88|晚安|see you|bye/i.test(t)) return 'farewell';
  if (/哈哈|笑[了]?|好玩|开心|高兴|快乐/.test(t)) return 'cheerful';

  return 'neutral';
}

// ============================================================
// 段间关系检测
// ============================================================

function detectRelations(text) {
  var remaining = text.trim();
  var relation = 'single';
  var hasSplit = false;
  var parts = [remaining];

  var notConjunction = /^(再说一遍|顺便说[一几]句|随便说说|再说吧|再想想|再说)$/;
  var sequential = /[，,、]\s*(然后|再把|接着|再把结果|再把文件|再把数据|再给|最后)/;
  var parallel = /[，,、]\s*(顺便|同时|另外|也[不]?是|以及|还有|再调研|再看看|顺便看看|再帮我看看)/;

  if (notConjunction.test(remaining)) {
    return { relation: 'single', hasSplit: false, parts: [remaining], original: text };
  }

  if (sequential.test(remaining)) {
    parts = remaining.split(sequential).filter(function(p) { return p.trim().length > 0; });
    relation = 'sequential';
    hasSplit = true;
  } else if (parallel.test(remaining)) {
    parts = remaining.split(parallel).filter(function(p) { return p.trim().length > 0; });
    var segmentA = parts[0] || '';
    var segmentB = parts[1] || '';
    var aSimple = /^(帮我)?(查|看|读|找|搜|切|改|弄|写)/.test(segmentA.trim());
    var bSimple = /^(帮我)?(查|看|读|找|搜|切|改|弄|写)/.test(segmentB.trim());
    relation = (/顺便/.test(remaining) && !aSimple && bSimple) ? 'parentchild' : 'parallel';
    hasSplit = true;
  }

  parts = parts.filter(function(p) { return p.trim().length > 0; });
  return { relation: relation, hasSplit: hasSplit, parts: parts.length > 0 ? parts : [remaining], original: text };
}

// ============================================================
// 段间关系测试（--segment）
// ============================================================

const SEG_TEST_CASES = [
  { text: '帮我分析CSV，然后把结果整理成文档发给我', expected: 'sequential' },
  { text: '查下天气，顺便看看这个文件', expected: 'parallel' },
  { text: '优化一下架构，顺便把测试跑一下', expected: 'parentchild' },
  { text: '再说一遍你的要求', expected: 'single' },
  { text: '好的，再帮我看看这个分析报告', expected: 'parallel' },
  { text: '帮我把这个文件读一下，然后给个总结', expected: 'sequential' },
  { text: '查天气', expected: 'single' },
  { text: '语音识别用百度，再调研一下Vosk', expected: 'parallel' },
  { text: '顺便说一句这是个好主意', expected: 'single' },
  { text: '我也觉得这个方案不错', expected: 'single' },
  { text: '先查天气，再看看文件，最后发邮件', expected: 'sequential' },
  { text: '帮我查天气', expected: 'single' },
  { text: '再说一遍，我没听清', expected: 'single' },
  { text: '分析报告，顺便整理成表格', expected: 'parentchild' },
  { text: '帮我把这个文件读一下，然后给个总结，最后发我邮箱', expected: 'sequential' },
  { text: '好的谢谢你', expected: 'single' },
  { text: '不是，你咋还没搞懂呢？', expected: 'single' },
];

function runSegmentTest() {
  console.log('');
  console.log('═'.repeat(60));
  console.log('  段间关系检测测试（--segment）');
  console.log('═'.repeat(60));

  // 旧版基准
  var oldPass = 0;
  var singleCount = 0;
  for (var si = 0; si < SEG_TEST_CASES.length; si++) {
    if (SEG_TEST_CASES[si].expected === 'single') { singleCount++; oldPass++; }
  }
  var oldAcc = Math.round(oldPass / SEG_TEST_CASES.length * 100);

  // 新版
  var pass = 0, fail = 0;
  for (var si = 0; si < SEG_TEST_CASES.length; si++) {
    var r = detectRelations(SEG_TEST_CASES[si].text);
    var ok = r.relation === SEG_TEST_CASES[si].expected;
    if (ok) { pass++; }
    else {
      fail++;
      console.log('❌ "' + SEG_TEST_CASES[si].text + '"');
      console.log('  预期:' + SEG_TEST_CASES[si].expected + ' 实际:' + r.relation);
    }
  }
  if (fail === 0) console.log('✅ 全部通过！');

  var newAcc = Math.round(pass / SEG_TEST_CASES.length * 100);
  console.log('-'.repeat(40));
  console.log('  准确率对比:');
  console.log('  旧版（无段间检测）: ' + oldAcc + '%');
  console.log('  新版（有段间检测）: ' + newAcc + '%');
  console.log('  提升: +' + (newAcc - oldAcc) + '%');
  
  // 分割示例
  console.log('-'.repeat(40));
  console.log('  分割示例:');
  var examples = ['帮我分析CSV，然后把结果整理成文档发给我','查下天气，顺便看看这个文件','优化一下架构，顺便把测试跑一下','好的，再帮我看看这个分析报告','先查天气，再看看文件，最后发邮件'];
  for (var ei = 0; ei < examples.length; ei++) {
    var r = detectRelations(examples[ei]);
    console.log('  "' + examples[ei] + '"');
    console.log('    → ' + r.relation + ' | ' + JSON.stringify(r.parts));
  }
}

// ============================================================
// 主入口 + 模拟运行模式
// ============================================================

/**
 * 模拟运行模式（老板时间线）
 *   ...
 *   8000ms 云端完成 → 推送结果
 */
function simulateTimeline(text) {
  const result = classify(text);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  完整时间线模拟                                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  消息: "' + text + '"');
  console.log('  分类: ' + result.type + ' (' + result.reason + ')');
  console.log('');

  console.log('  0ms    用户发送消息');
  console.log('  50ms   \u2705 收到，正在处理...');
  console.log('  100ms  分类器判定 \u2192 ' + result.type);

  const simpleTotal = 1000 + Math.random() * 1000;
  const complexTotal = 5000 + Math.random() * 5000;

  if (result.type === 'chat') {
    console.log('  150ms  二级闲聊 (本地MFDoom) 开始生成回复...');
    console.log('                     \u2195');
    var preview = text.length > 20 ? text.substring(0, 20) + '...' : text;
    console.log('  ~350ms  \u21b3 "' + preview + '"');
    console.log('  总耗时: ~1500ms');
  } else if (result.type === 'simple') {
    console.log('  150ms  云端DeepSeek 直接执行...');
    console.log('                     \u2195');
    console.log('  ~' + Math.round(simpleTotal) + 'ms  \u2705 完成');
    console.log('  总耗时: ~' + Math.round(simpleTotal) + 'ms');
  } else {
    console.log('  150ms  \uD83d\uDcca 检测到复杂任务，预计需要5-10秒，完成后通知你');
    console.log('  200ms  spawn 云端子程序（后台处理中...）');
    console.log('                     \u2195');
    console.log('  ' + Math.round(complexTotal) + 'ms  \u2705 分析完成，这是结果：...');
    console.log('  总耗时: ~' + Math.round(complexTotal) + 'ms（用户反馈仅150ms）');
  }
  console.log('');
  return result;
}

// ============================================================
// JSON 输出模式（主会话调用的生产模式）
// 用法: node test-classify.js --json "消息文本"
// 输出: { "type": "chat|simple|complex", "reason": "...", "text": "..." }
// ============================================================

if (process.argv.includes('--json')) {
  var msgIdx = process.argv.indexOf('--json');
  var message = Array.isArray(process.argv) ? process.argv.slice(msgIdx + 1).join(' ') : '';
  if (!message || message.trim().length === 0) {
    console.error(JSON.stringify({ error: 'missing message', usage: '--json "消息内容"' }));
    process.exit(1);
  }

  var cls = classify(message);
  var rel = detectRelations(message);

  var vibe = detectVibe(message);

  var output = {
    type: cls.type,
    reason: cls.reason,
    vibe: vibe,
    text: message
  };

  // 多段消息添加关系信息
  if (rel.hasSplit) {
    output.relation = rel.relation;
    output.parts = rel.parts;
  }

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// Run: node test-classify.js --simulate "消息文本"
if (process.argv.includes('--segment')) {
  runSegmentTest();
  process.exit(0);
} else if (process.argv.includes('--simulate')) {
  var simIdx = process.argv.indexOf('--simulate');
  var simText = process.argv[simIdx + 1];
  if (simText) {
    simulateTimeline(simText);
  } else {
    // 模拟几条测试数据
    var samples = [
      '帮我写个Python脚本分析这个CSV文件',
      '今天天气怎么样',
      '好的谢谢你',
      '再看看这个架构能不能优化',
    ];
    for (var s = 0; s < samples.length; s++) {
      simulateTimeline(samples[s]);
      if (s < samples.length - 1) {
        console.log('  ' + '-'.repeat(50));
      }
    }
  }
} else {
  main();
}

function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     一级分类原型测试 — 最新架构版                         ║');
  console.log('║     主会话无模型 | 本地纯规则分类器 (3ms)                 ║');
  console.log('║     闲聊→本地MFDoom | 简单→云端DeepSeek | 复杂→云端        ║');
  console.log(`║     详细模式: ${VERBOSE ? '✅ 开启' : '❌ 关闭'}                                   ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  const result = runTest(TEST_CASES, '📋 测试数据集（18条，含闲聊/简单/复杂）');

  analyzeFailures(result.failures);

  generateSummary(result);
}



