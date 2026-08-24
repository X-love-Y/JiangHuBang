// aiAssistant —— AI 助手：每日推荐可接委托 + 委托解决方案
// 模型：DeepSeek（api.deepseek.com），API Key 放云函数环境变量 DEEPSEEK_API_KEY
// 未配置 Key 时返回模拟结果（开发模式），不影响流程走通
const cloud = require('wx-server-sdk');
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, fail, biz, getConfig, requireUser } = require('./business');

exports.main = async (event) => {
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { action, commissionId } = event || {};
  if (action === 'recommend') return recommend(OPENID);
  if (action === 'solution') return solution(OPENID, commissionId);
  if (action === 'assess') return assess(OPENID, event);
  return fail('INVALID_ACTION', '未知操作');
};

// ===== 每日推荐：检索适合我的待接单委托 =====
async function recommend(OPENID) {
  const config = await getConfig(db);
  const uRes = await db.collection('users').doc(OPENID).get();
  const user = uRes.data;
  const hasPass = user.aiPassExpire && new Date(user.aiPassExpire).getTime() > Date.now();
  const quota = hasPass ? config.aiPassQuota.recommend : config.dailyRecommendLimit;

  // 今日已用次数
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const usedCnt = await db.collection('ai_records')
    .where({ userId: OPENID, type: 'recommend', createdAt: _.gte(todayStart) }).count();
  if (usedCnt.total >= quota) {
    return fail('QUOTA_EXCEEDED', hasPass
      ? `AI 月卡每日推荐 ${quota} 次已用完，明天再来`
      : '今日推荐次数已用完，可开通 AI 月卡提升次数');
  }

  // 扣费（非月卡：每次 5 银）
  if (!hasPass) {
    const cost = config.aiPrices.recommend;
    const t = await db.startTransaction();
    try {
      const cur = await t.collection('users').doc(OPENID).get();
      if ((cur.data.silver || 0) < cost) {
        throw Object.assign(new Error('白银不足，无法使用 AI 推荐'), { bizCode: 'INSUFFICIENT' });
      }
      await t.collection('users').doc(OPENID).update({
        data: { silver: _.inc(-cost), updatedAt: db.serverDate() }
      });
      await t.collection('transactions').add({
        data: {
          userId: OPENID, type: 'consume', currency: 'silver', amount: -cost,
          balanceAfter: cur.data.silver - cost, relatedId: '',
          remark: 'AI 助手·今日推荐', createdAt: db.serverDate()
        }
      });
      await t.commit();
    } catch (e) {
      try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
      if (e.bizCode) return fail(e.bizCode, e.message);
      return fail('TRANSACTION_FAIL', '扣费失败，请重试');
    }
  }

  // 候选委托池
  const pool = await db.collection('commissions')
    .where({ status: 'pending', deadline: _.gt(new Date()) })
    .orderBy('sortScore', 'desc').limit(50).get();

  let items;
  let mock = false;
  if (!pool.data.length) {
    items = [];
  } else {
    const brief = pool.data.map((c, i) => ({
      no: c.commissionNo,
      title: c.title,
      desc: (c.description || '').slice(0, 60),
      category: c.categoryId,
      star: c.star,
      amount: c.amount,
      currency: c.currency
    }));
    const sys = '你是江湖悬赏平台的智能助理，擅长为侠士匹配委托。';
    const prompt =
      '以下是当前可接的悬赏委托列表（JSON）。请从中挑选最适合新手的 5 条，' +
      '按 JSON 格式返回：{"items":[{"no":"委托编号","reason":"一句话推荐理由"}]}，只返回 JSON，不要其他文字。\n' +
      JSON.stringify(brief);
    const aiText = await callDeepSeek(sys, prompt);
    if (aiText) {
      items = parseRecommend(aiText, pool.data);
    } else {
      mock = true; // 未配置 Key / 调用失败 → 模拟推荐
      items = pool.data.slice(0, 5).map((c) => ({
        commissionId: c._id,
        commissionNo: c.commissionNo,
        title: c.title,
        star: c.star,
        amount: c.amount,
        currency: c.currency,
        reason: `该委托星级 ${c.star} 星、悬赏 ${c.amount}${c.currency === 'gold' ? '金' : '银'}，值得一试`
      }));
    }
  }

  // 落库记录
  await db.collection('ai_records').add({
    data: {
      userId: OPENID, type: 'recommend', commissionId: '',
      query: '每日推荐', result: JSON.stringify(items), model: 'deepseek-chat',
      tokens: 0, cost: hasPass ? 0 : config.aiPrices.recommend,
      status: 'success', mock, createdAt: db.serverDate()
    }
  });
  return ok({ items, mock, hasPass, remaining: quota - usedCnt.total - 1 });
}

// ===== 解决方案：为指定委托生成完成方案 =====
async function solution(OPENID, commissionId) {
  if (!commissionId) return fail('INVALID_PARAM', '请选择委托');
  const config = await getConfig(db);
  const uRes = await db.collection('users').doc(OPENID).get();
  const user = uRes.data;
  const hasPass = user.aiPassExpire && new Date(user.aiPassExpire).getTime() > Date.now();
  const quota = hasPass ? config.aiPassQuota.solution : config.solutionDailyLimit;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const usedCnt = await db.collection('ai_records')
    .where({ userId: OPENID, type: 'solution', createdAt: _.gte(todayStart) }).count();
  if (usedCnt.total >= quota) {
    return fail('QUOTA_EXCEEDED', hasPass
      ? `AI 月卡每日方案 ${quota} 次已用完`
      : `今日方案次数已用完（每日限 ${quota} 次）`);
  }

  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;

  // 扣费（非月卡：每次 20 银）
  if (!hasPass) {
    const cost = config.aiPrices.solution;
    const t = await db.startTransaction();
    try {
      const cur = await t.collection('users').doc(OPENID).get();
      if ((cur.data.silver || 0) < cost) {
        throw Object.assign(new Error('白银不足，无法生成方案'), { bizCode: 'INSUFFICIENT' });
      }
      await t.collection('users').doc(OPENID).update({
        data: { silver: _.inc(-cost), updatedAt: db.serverDate() }
      });
      await t.collection('transactions').add({
        data: {
          userId: OPENID, type: 'consume', currency: 'silver', amount: -cost,
          balanceAfter: cur.data.silver - cost, relatedId: commissionId,
          remark: 'AI 助手·委托方案', createdAt: db.serverDate()
        }
      });
      await t.commit();
    } catch (e) {
      try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
      if (e.bizCode) return fail(e.bizCode, e.message);
      return fail('TRANSACTION_FAIL', '扣费失败，请重试');
    }
  }

  const sys = '你是江湖悬赏平台的资深侠士，擅长拆解任务、制定执行方案。';
  const prompt =
    `请为下面这条悬赏委托制定完成方案，按以下四段输出：\n` +
    `【背景分析】简要分析委托需求\n【执行步骤】分步骤的行动计划\n【风险提示】需要注意的风险与合规提醒\n【成本预估】预计需要花费的时间与成本\n\n` +
    `委托标题：${c.title}\n委托描述：${c.description || '（无）'}\n` +
    `分类：${c.categoryId}，金额：${c.amount}${c.currency === 'gold' ? '金' : '银'}，地区：${JSON.stringify(c.region || {})}`;

  let text = await callDeepSeek(sys, prompt);
  let mock = false;
  if (!text) {
    mock = true;
    text = mockSolution(c);
  }

  await db.collection('ai_records').add({
    data: {
      userId: OPENID, type: 'solution', commissionId,
      query: c.title, result: text, model: 'deepseek-chat',
      tokens: 0, cost: hasPass ? 0 : config.aiPrices.solution,
      status: 'success', mock, createdAt: db.serverDate()
    }
  });
  return ok({ text, mock, hasPass, remaining: quota - usedCnt.total - 1 });
}

// ===== DeepSeek 调用（Node 原生 https，无第三方依赖） =====
function callDeepSeek(system, user) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  return new Promise((resolve) => {
    if (!apiKey) return resolve(null); // 未配置 Key → 降级模拟
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.7,
      max_tokens: 2048,
      response_format: { type: 'json_object' }
    });
    const req = https.request(
      {
        hostname: 'api.deepseek.com',
        path: '/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 25000
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            const msg = j.choices && j.choices[0] && j.choices[0].message;
            resolve(msg ? msg.content : null);
          } catch (e) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// 解析推荐 JSON（容错：剥离 code fence、按 commissionNo 反查委托）
function parseRecommend(aiText, pool) {
  try {
    const cleaned = aiText.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const j = JSON.parse(cleaned.slice(start, end + 1));
    const byNo = {};
    pool.forEach((c) => { byNo[c.commissionNo] = c; });
    return (Array.isArray(j.items) ? j.items : [])
      .filter((it) => byNo[it.no])
      .map((it) => {
        const c = byNo[it.no];
        return {
          commissionId: c._id,
          commissionNo: c.commissionNo,
          title: c.title,
          star: c.star,
          amount: c.amount,
          currency: c.currency,
          reason: it.reason || 'AI 推荐'
        };
      })
      .slice(0, 5);
  } catch (e) {
    // AI 返回格式异常：回退星级优先推荐
    return pool.slice(0, 5).map((c) => ({
      commissionId: c._id,
      commissionNo: c.commissionNo,
      title: c.title,
      star: c.star,
      amount: c.amount,
      currency: c.currency,
      reason: `星级 ${c.star} 星悬赏，性价比高`
    }));
  }
}

// 模拟方案（开发模式）
function mockSolution(c) {
  return (
    `【背景分析】\n该委托属于${c.categoryId}类悬赏，金额 ${c.amount}${c.currency === 'gold' ? '金' : '银'}，` +
    `难度预计与金额匹配。委托方明确提出了需求，完成关键在于沟通确认细节。\n\n` +
    `【执行步骤】\n1. 接单后第一时间联系发布者，确认交付标准与截止时间\n` +
    `2. 分解任务，制定 2-3 步执行计划并逐项完成\n3. 完成关键节点后拍照留证\n` +
    `4. 提交完成凭证（文字说明 + 图片），等待发布者确认\n\n` +
    `【风险提示】\n- 务必在平台内沟通交易，勿私下转账\n- 涉及隐私/人身安全的任务请谨慎核实\n` +
    `- 如遇发布者提出违规要求，保留证据并取消委托\n\n` +
    `【成本预估】\n按任务复杂度预计 1-4 小时，建议接单前评估自身时间余量。\n` +
    `（当前为模拟方案：未配置 DEEPSEEK_API_KEY，接入后返回真实 AI 分析）`
  );
}

// ===== AI 评定：对拟发布的委托给出难度与星级建议（仅建议，自主权在用户） =====
async function assess(OPENID, event) {
  const { title, description, categoryId, amount, currency } = event || {};
  if (!title || !categoryId) return fail('INVALID_PARAM', '请先填写标题与分类');
  const config = await getConfig(db);
  const uRes = await db.collection('users').doc(OPENID).get();
  const user = uRes.data;
  const hasPass = !!(user.aiPassExpire && new Date(user.aiPassExpire).getTime() > Date.now());

  // 限额：月卡每日免费 3 次；非月卡每日 3 次、每次扣 aiAssessPrice 银
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const cnt = await db.collection('ai_records')
    .where({ userId: OPENID, type: 'assess', createdAt: _.gte(dayStart) }).count();
  if (cnt.total >= config.aiAssessDailyFree) {
    return fail('QUOTA_EXCEEDED', '今日评定次数已用完（月卡用户更多免费次数）');
  }
  if (!hasPass) {
    const t = await db.startTransaction();
    try {
      const u = await t.collection('users').doc(OPENID).get();
      const balance = u.data.silver || 0;
      if (balance < config.aiAssessPrice) {
        throw biz('INSUFFICIENT', `余额不足（评定需 ${config.aiAssessPrice} 银）`);
      }
      await t.collection('users').doc(OPENID).update({
        data: { silver: balance - config.aiAssessPrice, updatedAt: db.serverDate() }
      });
      await t.collection('transactions').add({
        data: {
          userId: OPENID, type: 'consume', currency: 'silver',
          amount: -config.aiAssessPrice, balanceAfter: balance - config.aiAssessPrice,
          relatedId: '', remark: 'AI 委托评定', createdAt: db.serverDate()
        }
      });
      await t.commit();
    } catch (e) {
      try { await t.rollback(); } catch (e2) { /* 忽略 */ }
      if (e.bizCode) return fail(e.bizCode, e.message);
      return fail('TRANSACTION_FAIL', '扣费失败，请重试');
    }
  }

  // DeepSeek 调用（无 key 降级启发式评定）
  const apiKey = process.env.DEEPSEEK_API_KEY;
  let suggestStar = 0;
  let difficulty = '';
  let reason = '';
  let mock = false;
  if (apiKey) {
    try {
      const system = '你是悬赏任务平台的评定专家。根据委托标题、描述、分类、金额，给出难度评级（简单/中等/困难/极难）与建议星级（1-5，按等价白银：<100=1星 <1000=2星 <10000=3星 <100000=4星 否则5星，1金=100银）。只返回 JSON：{"suggestStar":数字,"difficulty":"难度","reason":"一句话理由"}';
      const userMsg = `标题：${title}\n描述：${description || '无'}\n分类：${categoryId}\n金额：${amount} ${currency === 'gold' ? '金' : '银'}`;
      const content = await callDeepSeek(system, userMsg, true);
      const parsed = safeJson(content);
      if (parsed && parsed.suggestStar) {
        suggestStar = Math.max(1, Math.min(5, Number(parsed.suggestStar)));
        difficulty = parsed.difficulty || '';
        reason = parsed.reason || '';
      }
    } catch (e) {
      console.warn('[aiAssistant] 评定调用失败，降级启发式:', e.message);
    }
  }
  if (!suggestStar) {
    mock = true;
    const amt = Number(amount) || 0;
    const equiv = currency === 'gold' ? amt * config.exchangeRate : amt;
    suggestStar = equiv < 100 ? 1 : equiv < 1000 ? 2 : equiv < 10000 ? 3 : equiv < 100000 ? 4 : 5;
    difficulty = suggestStar <= 1 ? '简单' : suggestStar === 2 ? '中等' : suggestStar === 3 ? '困难' : '极难';
    reason = '按金额梯度估算的星级建议（接入 DeepSeek 后为智能分析）';
  }

  await db.collection('ai_records').add({
    data: {
      userId: OPENID, type: 'assess', commissionId: '',
      query: `评定：${title}`,
      result: JSON.stringify({ suggestStar, difficulty, reason }),
      model: apiKey ? 'deepseek-chat' : 'mock',
      tokens: 0, cost: hasPass ? 0 : config.aiAssessPrice,
      status: 'success', createdAt: db.serverDate()
    }
  });
  return ok({ suggestStar, difficulty, reason, mock, cost: hasPass ? 0 : config.aiAssessPrice, free: hasPass });
}

// 宽松 JSON 解析（去掉代码块围栏后 parse）
function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (e2) { return null; }
    }
    return null;
  }
}
