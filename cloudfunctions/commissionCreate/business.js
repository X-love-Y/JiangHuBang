// business.js —— 共享业务逻辑（纯函数 + 结算事务 + 成就授予 + 身份中间层）
// ⚠️ 云函数目录相互独立，本文件是权威副本；部署前用 cp 复制进需要的函数目录
// 数值权威源为 config 集合「global」文档，DEFAULTS 仅作兜底
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const crypto = require('crypto');
const _ = cloud.database().command;

const DEFAULTS = {
  exchangeRate: 100,                          // 兑换倍率：1 金 = 100 银（不扣税）
  feeRate: 0.01,                              // 平台中介费 1%
  starThresholds: [100, 1000, 10000, 100000], // 星级梯度（等价白银）
  autoConfirmHours: 48,                       // 提交后超时自动确认结算
  expireHours: 168,                           // 无人接单 7 天过期
  acceptLimit: 3,                             // 同时接单上限
  publishLimit: 5,                            // 同时在挂委托上限
  aiPrices: { recommend: 5, solution: 20 },   // AI 单价（白银）
  dailyRecommendLimit: 1,                     // 非月卡每日推荐次数
  solutionDailyLimit: 3,                      // 非月卡每日方案次数
  aiPassQuota: { recommend: 3, solution: 3 }, // AI 月卡每日免费次数
  aiAssessPrice: 3,                           // AI 评定建议单价（白银）
  aiAssessDailyFree: 3,                       // AI 月卡每日免费评定次数
  giveUpStrikeMax: 3,                         // 24h 内放弃接单次数阈值
  giveUpBanHours: 24,                         // 触发后封接单权时长
  newbieSilver: 100,                          // 新手见面礼（白银）
  rechargePlans: { 6: 600, 18: 1800, 30: 3000, 68: 6800, 128: 12800 }, // 元 → 银
  // ---- 二期新增 ----
  maxRequests: 100,              // 公共模式单个委托最多申请人数
  maxAcceptors: 10,              // 公共模式最多合作人数
  chainMaxSteps: 100,            // 委托链最多步数
  userIdChangeCooldownDays: 30,  // 改 ID 冷却天数
  reviewEditLimit: 1,            // 评价可修改次数
  appealWindowDays: 7,           // 评价申诉窗口（天）
  boundOpenidLimit: 5,           // 账号最多绑定微信数
  chatVoiceMaxSec: 60,           // 语音消息最长秒数
  chatFileMaxMB: 10,             // 聊天文件上限 MB
  closedRetentionDays: 30,       // 已结束委托保留天数（超期由定时任务物理删除）
  chainHistoryRetentionDays: 30, // 解散的历史链保留天数（期内可恢复，超期清理）
  adminIds: ['XianZun', 'QingZhongSheng'], // 管理员账号 ID
  newUserRep: 500,               // 初始信誉值
  newUserSkill: 300,             // 初始能力值
  threeValueTitles: [            // 三值成就称号定义（titleId 前缀 tv_）
    { titleId: 'tv_rep_1', name: '一诺千金', kind: 'rep', value: 900, effect: { kind: 'show', value: null }, desc: '信誉值达到 900', icon: '🏅' },
    { titleId: 'tv_rep_2', name: '言出必行', kind: 'rep', value: 980, effect: { kind: 'acceptBoost', value: 1 }, desc: '信誉值达到 980 · 接单上限 +1', icon: '💎' },
    { titleId: 'tv_skill_1', name: '能工巧匠', kind: 'skill', value: 900, effect: { kind: 'show', value: null }, desc: '能力值达到 900', icon: '🛠' },
    { titleId: 'tv_skill_2', name: '炉火纯青', kind: 'skill', value: 980, effect: { kind: 'publishBoost', value: 1 }, desc: '能力值达到 980 · 发布上限 +1', icon: '🔥' },
    { titleId: 'tv_fame_1', name: '声名远播', kind: 'fame', value: 900, effect: { kind: 'show', value: null }, desc: '名望值达到 900', icon: '📯' },
    { titleId: 'tv_fame_2', name: '威震天下', kind: 'fame', value: 980, effect: { kind: 'priority', value: 10 }, desc: '名望值达到 980 · 委托权重 +10', icon: '🐯' },
    { titleId: 'tv_all', name: '三榜奇才', kind: 'all', value: 900, effect: { kind: 'feeDiscount', value: 0.9 }, desc: '三值均达 900 · 中介费 9 折', icon: '🌟' }
  ]
};

const ok = (data) => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, error: { code, message } });

// ===== 密码哈希（pbkdf2 10 万次迭代 + 随机盐） =====
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

// 常量时间比较，防时序攻击
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const h = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex');
  const a = Buffer.from(h);
  const b = Buffer.from(hash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ===== 身份中间层：所有写操作的统一入口 =====
// 取 openid → 查用户 → 影子文档跟随 accountOf → 封禁检查 → 返回主账号
// opts.needAccount: 需已注册 ID 账号；opts.needAdmin: 需管理员
async function requireUser(db, opts = {}) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, error: { code: 'NO_OPENID', message: '无法获取用户身份' } };
  let u;
  try {
    const q = await db.collection('users').where({ _id: OPENID }).limit(1).get();
    u = q.data[0];
  } catch (e) {
    return { ok: false, error: { code: 'NOT_READY', message: '云端初始化中，请稍后重试' } };
  }
  if (!u) return { ok: false, error: { code: 'NOT_REGISTERED', message: '请先登录' } };
  // 影子文档：资产已合并至主账号，请求解析到主账号
  if (u.accountOf) {
    const q2 = await db.collection('users').where({ _id: u.accountOf }).limit(1).get().catch(() => ({ data: [] }));
    if (q2.data[0]) u = q2.data[0];
  }
  if (u.status === -1) return { ok: false, error: { code: 'BANNED', message: '账号已被封禁' } };
  if (opts.needAccount && !u.userId) {
    return { ok: false, error: { code: 'NEED_REGISTER', message: '该操作需要注册账号' } };
  }
  if (opts.needAdmin && (u.adminLevel || 0) < 1) {
    return { ok: false, error: { code: 'FORBIDDEN', message: '无管理员权限' } };
  }
  return { ok: true, openid: OPENID, realId: u._id, user: u };
}

// ===== 用户文档脱敏（剔除密码/绑定等敏感字段再下发前端） =====
function sanitizeUser(u) {
  if (!u) return null;
  const { pwdHash, pwdSalt, boundOpenids, accountOf, ...safe } = u;
  return safe;
}

// ===== 站内通知工具 =====
async function notifyUser(db, userId, type, title, content, relatedId = '') {
  try {
    await db.collection('notifications').add({
      data: {
        userId, type, title, content, relatedId,
        read: false, createdAt: db.serverDate()
      }
    });
  } catch (e) {
    console.warn('[notify] 通知写入失败:', e.message);
  }
}

// 等价白银折算
function toSilverEquiv(amount, currency, rate = DEFAULTS.exchangeRate) {
  return currency === 'gold' ? amount * rate : amount;
}

// 星级：按等价白银落入梯度区间
function calcStar(amount, currency, thresholds = DEFAULTS.starThresholds, rate = DEFAULTS.exchangeRate) {
  const equiv = toSilverEquiv(amount, currency, rate);
  if (equiv < thresholds[0]) return 1;
  if (equiv < thresholds[1]) return 2;
  if (equiv < thresholds[2]) return 3;
  if (equiv < thresholds[3]) return 4;
  return 5;
}

// 中介费：金额 × 费率 × 称号折扣，最低 1 文
function calcFee(amount, feeRate = DEFAULTS.feeRate, discount = 1) {
  return Math.max(1, Math.floor(amount * feeRate * (discount || 1)));
}

// ===== 公共模式分账（守恒算法，纯函数可单测） =====
// 输入：总额、中介费、各人比例（equal 模式传 [] 自动均分）
// 输出：每人 { gross, fee, net }，Σgross=amount、Σfee=fee、Σnet=net-fee 严格守恒（末人取余）
function calcPublicSplits(amount, fee, splitMode, splits, n) {
  if (!n || n < 1) return [];
  // 归一化比例：custom 用给定比例（须和为 100），equal 均分
  let ratios;
  if (splitMode === 'custom') {
    ratios = splits.slice(0, n);
    const sum = ratios.reduce((a, b) => a + b, 0);
    if (sum !== 100) throw new Error('SPLIT_SUM_INVALID');
  } else {
    ratios = new Array(n).fill(100 / n);
  }
  // 每人毛额：前 n-1 人取整，末人取余数（守恒）
  const gross = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      gross.push(amount - used);
    } else {
      const g = Math.floor((amount * ratios[i]) / 100);
      gross.push(g);
      used += g;
    }
  }
  // 每人手续费：同样前 n-1 人取整，末人取余（守恒）
  const feeEach = [];
  let feeUsed = 0;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      feeEach.push(fee - feeUsed);
    } else {
      const f = Math.floor((fee * ratios[i]) / 100);
      feeEach.push(f);
      feeUsed += f;
    }
  }
  return gross.map((g, i) => ({ gross: g, fee: feeEach[i], net: g - feeEach[i] }));
}

// 读取平台配置（合并兜底默认值）
async function getConfig(db) {
  try {
    const res = await db.collection('config').doc('global').get();
    return Object.assign({}, DEFAULTS, res.data);
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

// 获取用户佩戴称号的指定效果值（effect 支持单对象或数组）
async function getEquippedEffect(db, userId, kind) {
  try {
    const u = await db.collection('users').doc(userId).get();
    const titleId = u.data.equippedTitleId;
    if (!titleId) return null;
    const t = await db.collection('titles').doc(titleId).get().catch(() => null);
    if (!t || !t.data || !t.data.effect) return null;
    const effects = Array.isArray(t.data.effect) ? t.data.effect : [t.data.effect];
    const hit = effects.find((e) => e.kind === kind);
    return hit ? hit.value : null;
  } catch (e) {
    return null;
  }
}

// 业务错误（携带 code 便于上层区分）
function biz(code, message) {
  return Object.assign(new Error(message), { bizCode: code });
}

// ===== 结算事务：submitted → settled =====
// 扣中介费（发布者佩戴称号可享折扣）→ 完成者入账 → 平台记中介费流水 → 订单落账
// 事务内只写顶层原始值（嵌套对象会 PathNotViable）；余额写计算后的绝对值（不用 inc 指令）
async function settleCommission(db, commissionId, config) {
  const cRes = await db.collection('commissions').doc(commissionId).get();
  const commission = cRes.data;
  const discount = (await getEquippedEffect(db, commission.publisherId, 'feeDiscount')) || 1;
  const fee = calcFee(commission.amount, config.feeRate, discount);
  const net = commission.amount - fee;
  const field = commission.currency === 'gold' ? 'gold' : 'silver';

  const t = await db.startTransaction();
  try {
    // 事务内复核状态，天然防并发双花
    const cur = await t.collection('commissions').doc(commissionId).get();
    if (cur.data.status !== 'submitted') throw biz('INVALID_STATUS', '当前状态不可结算');

    const acceptor = await t.collection('users').doc(commission.acceptorId).get();
    const balanceAfter = (acceptor.data[field] || 0) + net;

    // 事务 update 只写顶层原始值：结算信息扁平为 settle* 字段
    await t.collection('commissions').doc(commissionId).update({
      data: {
        status: 'settled',
        settledAt: db.serverDate(),
        settleAmount: commission.amount,
        settleFee: fee,
        settleNet: net,
        settleCurrency: commission.currency,
        settleFeeRate: config.feeRate,
        settleDiscount: discount,
        updatedAt: db.serverDate()
      }
    });
    // 完成者入账：写绝对值
    await t.collection('users').doc(commission.acceptorId).update({
      data: { [field]: balanceAfter, updatedAt: db.serverDate() }
    });
    // 完成者入账流水
    await t.collection('transactions').add({
      data: {
        userId: commission.acceptorId, type: 'release', currency: commission.currency,
        amount: net, balanceAfter, relatedId: commissionId,
        remark: `完成委托「${commission.title}」收入`, createdAt: db.serverDate()
      }
    });
    // 平台中介费流水（平台账户不落余额，仅记账）
    await t.collection('transactions').add({
      data: {
        userId: 'PLATFORM', type: 'fee', currency: commission.currency,
        amount: fee, balanceAfter: null, relatedId: commissionId,
        remark: `委托「${commission.title}」中介费`, createdAt: db.serverDate()
      }
    });
    // 关联订单落账
    const orderRes = await t.collection('orders').where({ commissionId }).get();
    if (orderRes.data.length) {
      await t.collection('orders').doc(orderRes.data[0]._id).update({
        data: { status: 'settled', fee, net, settledAt: db.serverDate() }
      });
    }
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
    throw e;
  }

  // 事务外：成就统计 + 称号授予 + 三值重算（非资金关键路径）
  const onTime = commission.submittedAt && commission.deadline
    ? new Date(commission.submittedAt).getTime() <= new Date(commission.deadline).getTime()
    : false;
  const statData = {
    'stats.completed': db.command.inc(1),
    [`stats.totalEarned${commission.currency === 'gold' ? 'Gold' : 'Silver'}`]: db.command.inc(net),
    fameScore: db.command.inc(calcFameGain(net, commission.star)),
    updatedAt: db.serverDate()
  };
  if (onTime) statData['stats.onTimeCount'] = db.command.inc(1);
  await db.collection('users').doc(commission.acceptorId).update({ data: statData });
  const newTitles = await grantAchievements(db, commission.acceptorId);
  const threeValues = await applyThreeValues(db, commission.acceptorId);
  return { fee, net, discount, newTitles, threeValues };
}

// ===== 公共模式结算事务：全员确认 → 按比例分账（事务内只写顶层原始值） =====
async function settlePublicCommission(db, commissionId, config) {
  const cRes = await db.collection('commissions').doc(commissionId).get();
  const commission = cRes.data;
  const acceptors = commission.acceptors || [];
  const n = acceptors.length;
  if (!n) throw biz('INVALID_STATUS', '无合作者，不可结算');
  const discount = (await getEquippedEffect(db, commission.publisherId, 'feeDiscount')) || 1;
  const fee = calcFee(commission.amount, config.feeRate, discount);
  const splitMode = commission.splitMode || 'equal';
  const splits = acceptors.map((a) => a.split || 0);
  // 自定义比例须合计 100%（均分模式不受此限），不符则给出人话报错
  if (splitMode === 'custom') {
    const splitSum = splits.reduce((a, b) => a + b, 0);
    if (splitSum !== 100) {
      throw biz('SPLIT_INVALID', `分账比例合计 ${splitSum}%，须为 100%（可在申请人管理处修改比例）`);
    }
  }
  const shares = calcPublicSplits(commission.amount, fee, splitMode, splits, n);
  const field = commission.currency === 'gold' ? 'gold' : 'silver';

  const t = await db.startTransaction();
  try {
    const cur = await t.collection('commissions').doc(commissionId).get();
    if (cur.data.status !== 'submitted') throw biz('INVALID_STATUS', '当前状态不可结算');
    const curAcceptors = cur.data.acceptors || [];
    // 全员确认校验（确认标记在事务外以普通更新写入，事务内复核）
    if (!curAcceptors.every((a) => a.confirmedByPublisher)) {
      throw biz('NOT_ALL_CONFIRMED', '尚有合作者未确认');
    }
    // 每人入账（先读后写绝对值，顶层原始值）
    for (let i = 0; i < curAcceptors.length; i++) {
      const ac = curAcceptors[i];
      const share = shares[i];
      const u = await t.collection('users').doc(ac.userId).get();
      const balanceAfter = (u.data[field] || 0) + share.net;
      await t.collection('users').doc(ac.userId).update({
        data: { [field]: balanceAfter, updatedAt: db.serverDate() }
      });
      await t.collection('transactions').add({
        data: {
          userId: ac.userId, type: 'release', currency: commission.currency,
          amount: share.net, balanceAfter, relatedId: commissionId,
          remark: `完成委托「${commission.title}」收入（${curAcceptors.length} 人合作）`,
          createdAt: db.serverDate()
        }
      });
      // 个人订单落账
      if (ac.orderId) {
        await t.collection('orders').doc(ac.orderId).update({
          data: { status: 'settled', fee: share.fee, net: share.net, settledAt: db.serverDate() }
        });
      }
    }
    // 平台中介费流水
    await t.collection('transactions').add({
      data: {
        userId: 'PLATFORM', type: 'fee', currency: commission.currency,
        amount: fee, balanceAfter: null, relatedId: commissionId,
        remark: `委托「${commission.title}」中介费`, createdAt: db.serverDate()
      }
    });
    // 委托落账（扁平字段）
    await t.collection('commissions').doc(commissionId).update({
      data: {
        status: 'settled',
        settledAt: db.serverDate(),
        settleAmount: commission.amount,
        settleFee: fee,
        settleNet: commission.amount - fee,
        settleCurrency: commission.currency,
        settleFeeRate: config.feeRate,
        settleDiscount: discount,
        updatedAt: db.serverDate()
      }
    });
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
    throw e;
  }

  // 事务外：每人成就统计 + 称号授予 + 三值重算
  const onTime = commission.submittedAt && commission.deadline
    ? new Date(commission.submittedAt).getTime() <= new Date(commission.deadline).getTime()
    : false;
  for (let i = 0; i < acceptors.length; i++) {
    const ac = acceptors[i];
    const statData = {
      'stats.completed': db.command.inc(1),
      [`stats.totalEarned${commission.currency === 'gold' ? 'Gold' : 'Silver'}`]: db.command.inc(shares[i].net),
      fameScore: db.command.inc(calcFameGain(shares[i].net, commission.star)),
      updatedAt: db.serverDate()
    };
    if (onTime) statData['stats.onTimeCount'] = db.command.inc(1);
    await db.collection('users').doc(ac.userId).update({ data: statData })
      .catch((e) => console.warn('[settlePublic] 统计更新失败:', e.message));
    await grantAchievements(db, ac.userId);
    await applyThreeValues(db, ac.userId);
  }
  return { fee, shares };
}

// ===== 三值体系：信誉值 rep / 名望值 fame / 能力值 skill（0-1000，纯函数可单测） =====
const STAR_WEIGHTS = [1, 1.2, 1.5, 2, 3]; // 星级 → 名望权重
const FAME_LADDER = [ // 名望分数分段映射
  { min: 0, value: 0 },
  { min: 500, value: 50 },
  { min: 2000, value: 100 },
  { min: 10000, value: 200 },
  { min: 50000, value: 350 },
  { min: 200000, value: 500 },
  { min: 1000000, value: 700 },
  { min: 5000000, value: 850 },
  { min: 20000000, value: 1000 }
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// stats: {completed, cancelled, onTimeCount, cancelAsPublisher, giveUpCount, banCount}
// reviewAgg: {count, avgStar}
// 返回 { rep, skill }
function calcThreeValues(stats = {}, reviewAgg = {}) {
  // 信誉值：评价分 + 按时分 - 违约分（初始 500）
  const count = reviewAgg.count || 0;
  const avgStar = reviewAgg.avgStar || 0;
  const E = count >= 3 ? (avgStar - 3) * 100 : 0; // 冷启动保护：<3 条不计
  const completed = stats.completed || 0;
  const onTime = stats.onTimeCount || 0;
  let T = 0;
  if (completed >= 5) {
    const r = onTime / completed;
    T = (r - 0.9) * 500;
  }
  const V = Math.min(
    300,
    (stats.cancelAsPublisher || 0) * 50 +
      (stats.giveUpCount || 0) * 30 +
      (stats.banCount || 0) * 100
  );
  const rep = clamp(500 + E + T - V, 0, 1000);

  // 能力值：数量分 + 成功率分 + 专精分（初始 300；专精分暂为 0，待分类统计接入）
  // 成功率分冷启动保护：无完成记录时不扣分
  const Q = Math.min(300, completed * 20);
  let S = 0;
  if (completed > 0) {
    const rate = completed / Math.max(1, completed + (stats.cancelled || 0));
    S = clamp((rate - 0.75) * 600, -150, 150);
  }
  const C = 0;
  const skill = clamp(300 + Q + S + C, 0, 1000);

  return { rep: Math.round(rep), skill: Math.round(skill) };
}

// 名望分数 → 名望值（分段映射，只增不减由调用方保证）
function calcFameFromScore(fameScore) {
  let v = 0;
  for (const seg of FAME_LADDER) {
    if (fameScore >= seg.min) v = seg.value;
  }
  return v;
}

// 结算时累计名望分数：net × 星级权重
function calcFameGain(net, star) {
  const w = STAR_WEIGHTS[Math.max(0, Math.min(4, (star || 1) - 1))];
  return Math.round(net * w);
}

// ===== 重算并写回三值 + 授予三值成就称号（结算/评价后调用） =====
async function applyThreeValues(db, userId) {
  let u;
  try {
    u = (await db.collection('users').doc(userId).get()).data;
  } catch (e) {
    return null;
  }
  const stats = u.stats || {};
  const reviews = await db.collection('reviews').where({ revieweeId: userId }).get().catch(() => ({ data: [] }));
  const cnt = reviews.data.length;
  const avgStar = cnt ? reviews.data.reduce((a, r) => a + (r.star || 0), 0) / cnt : 0;
  const vals = calcThreeValues(stats, { count: cnt, avgStar });
  // 名望只增不减（当前值与映射值取大）
  const fame = Math.max(u.fame || 0, calcFameFromScore(u.fameScore || 0));
  await db.collection('users').doc(userId).update({
    data: {
      rep: vals.rep,
      skill: vals.skill,
      fame,
      updatedAt: db.serverDate()
    }
  }).catch((e) => console.warn('[applyThreeValues] 写回失败:', e.message));
  await grantThreeValueTitles(db, userId);
  return Object.assign({}, vals, { fame });
}

// 三值成就称号授予（达标即 push titleIds）
async function grantThreeValueTitles(db, userId) {
  let u;
  try {
    u = (await db.collection('users').doc(userId).get()).data;
  } catch (e) {
    return [];
  }
  const rep = u.rep || 0;
  const fame = u.fame || 0;
  const skill = u.skill || 0;
  const owned = u.titleIds || [];
  const defs = DEFAULTS.threeValueTitles;
  const newTitles = defs
    .filter((t) => {
      if (t.kind === 'all') return rep >= t.value && fame >= t.value && skill >= t.value;
      if (t.kind === 'rep') return rep >= t.value;
      if (t.kind === 'fame') return fame >= t.value;
      if (t.kind === 'skill') return skill >= t.value;
      return false;
    })
    .filter((t) => !owned.includes(t.titleId))
    .map((t) => t.titleId);
  if (newTitles.length) {
    await db.collection('users').doc(userId).update({
      data: { titleIds: db.command.push(newTitles), updatedAt: db.serverDate() }
    }).catch((e) => console.warn('[grantThreeValueTitles] 授予失败:', e.message));
  }
  return newTitles;
}

// ===== 成就称号授予：累计完成单数达标即自动获得 =====
async function grantAchievements(db, userId) {
  const uRes = await db.collection('users').doc(userId).get();
  const user = uRes.data;
  const completed = (user.stats && user.stats.completed) || 0;
  const res = await db.collection('titles').where({ source: 'achievement' }).get();
  const owned = user.titleIds || [];
  const newTitles = res.data
    .filter((t) => t.condition && t.condition.metric === 'completedCount' && completed >= t.condition.value)
    .filter((t) => !owned.includes(t.titleId))
    .map((t) => t.titleId);
  if (newTitles.length) {
    await db.collection('users').doc(userId).update({
      data: { titleIds: db.command.push(newTitles), updatedAt: db.serverDate() }
    });
  }
  return newTitles;
}

// ===== 发布委托核心（commissionCreate 与 draft.publish 共用） =====
// params：{ title, description, categoryId, subCategory, region, amount, currency,
//   deadline, images, publishAt, mode, minAcceptors, maxAcceptors, splitMode, chain }
// extra：{ draftId }（草稿发布时回填来源）
const CATEGORY_CODES = ['run', 'study', 'ride', 'romance', 'search', 'life', 'skill', 'mystic', 'accompany', 'idea'];
const ACTIVE_STATUSES = ['pending', 'accepted', 'submitted'];

function genNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `JH${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${Math.floor(1000 + Math.random() * 9000)}`;
}

async function publishCommission(db, OPENID, params = {}, extra = {}) {
  const {
    title, description, categoryId, subCategory, region, amount, currency,
    deadline, images, publishAt, mode = 'private', minAcceptors, maxAcceptors,
    splitMode, chain = null
  } = params;

  // 公共模式参数校验
  let minA = 1;
  let maxA = 1;
  if (mode === 'public') {
    minA = Math.max(1, Math.min(Number(minAcceptors) || 1, 10));
    maxA = Math.max(1, Math.min(Number(maxAcceptors) || 1, 10));
    if (minA > maxA) return fail('INVALID_RANGE', '最少人数不能大于最多人数');
    if (splitMode && !['equal', 'custom'].includes(splitMode)) {
      return fail('INVALID_SPLIT', '分账方式不合法');
    }
  }

  // 内容校验
  if (!title || title.trim().length < 2 || title.trim().length > 30) {
    return fail('INVALID_TITLE', '标题需 2-30 字');
  }
  if (description && description.length > 1000) return fail('INVALID_DESC', '描述最多 1000 字');
  if (!CATEGORY_CODES.includes(categoryId)) return fail('INVALID_CATEGORY', '分类不合法');
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) return fail('INVALID_AMOUNT', '金额须为正整数');
  if (currency === 'gold' ? amt < 1 : amt < 10) {
    return fail('INVALID_AMOUNT', currency === 'gold' ? '黄金委托最低 1 金' : '白银委托最低 10 银');
  }
  const dl = deadline ? new Date(deadline) : null;
  if (dl && (isNaN(dl.getTime()) || dl.getTime() <= Date.now())) {
    return fail('INVALID_DEADLINE', '截止时间不合法');
  }
  if (dl && dl.getTime() > Date.now() + 30 * 24 * 3600 * 1000) {
    return fail('INVALID_DEADLINE', '截止时间最多 30 天');
  }
  let pa = null;
  let isScheduled = false;
  if (publishAt) {
    pa = new Date(publishAt);
    if (isNaN(pa.getTime())) return fail('INVALID_PUBLISH_AT', '发布时间不合法');
    if (pa.getTime() > Date.now() + 30 * 24 * 3600 * 1000) {
      return fail('INVALID_PUBLISH_AT', '发布时间最多 30 天');
    }
    isScheduled = pa.getTime() > Date.now();
  }

  const config = await getConfig(db);

  // 内容安全检测（未开通权限时静默跳过）
  try {
    await cloud.openapi.security.msgSecCheck({
      version: 2, openid: OPENID, scene: 2,
      content: `${title}\n${description || ''}`
    });
  } catch (e) {
    console.log('[msgSecCheck] 跳过（未开通权限或调用失败）:', (e && e.errMsg) || e);
  }

  // 在挂委托上限（称号可加成）
  const uRes = await db.collection('users').doc(OPENID).get();
  const user = uRes.data;
  if (user.status === -1) return fail('BANNED', '账号已被封禁');
  if (user.publishBanUntil && new Date(user.publishBanUntil).getTime() > Date.now()) {
    return fail('PUBLISH_BANNED', '发布权已被暂停，请稍后再试');
  }
  const publishBonus = (await getEquippedEffect(db, OPENID, 'publishBoost')) || 0;
  const publishLimit = config.publishLimit + publishBonus;
  const activeCnt = await db.collection('commissions')
    .where({ publisherId: OPENID, status: _.in(ACTIVE_STATUSES) }).count();
  if (activeCnt.total >= publishLimit) {
    return fail('PUBLISH_LIMIT', `同时在挂委托不能超过 ${publishLimit} 个`);
  }

  // 星级与列表权重
  const star = calcStar(amt, currency, config.starThresholds, config.exchangeRate);
  const titlePriority = (await getEquippedEffect(db, OPENID, 'priority')) || 0;
  let sortScore = titlePriority;
  if (user.priorityBoostUntil && new Date(user.priorityBoostUntil).getTime() > Date.now()) {
    sortScore += 5000;
  }

  const field = currency === 'gold' ? 'gold' : 'silver';
  const t = await db.startTransaction();
  let commissionId = null;
  try {
    const cur = await t.collection('users').doc(OPENID).get();
    const balance = cur.data[field] || 0;
    if (balance < amt) {
      throw biz('INSUFFICIENT', `余额不足，当前${currency === 'gold' ? '黄金' : '白银'}余额 ${balance}`);
    }
    await t.collection('users').doc(OPENID).update({
      data: {
        [field]: _.inc(-amt),
        'stats.published': _.inc(1),
        updatedAt: db.serverDate()
      }
    });
    const addRes = await t.collection('commissions').add({
      data: {
        commissionNo: genNo(),
        publisherId: OPENID,
        title: title.trim(),
        description: description || '',
        categoryId,
        subCategory: subCategory || '',
        region: region || {},
        images: Array.isArray(images) ? images.slice(0, 9) : [],
        currency,
        amount: amt,
        star,
        mode,
        minAcceptors: mode === 'public' ? minA : null,
        maxAcceptors: mode === 'public' ? maxA : null,
        splitMode: mode === 'public' ? (splitMode || 'equal') : null,
        requests: [],
        acceptors: [],
        chain: chain || null,
        draftId: extra.draftId || null,
        status: isScheduled ? 'scheduled' : 'pending',
        publishAt: isScheduled ? pa : null,
        acceptorId: null,
        acceptedAt: null,
        deadline: dl || new Date(Date.now() + config.expireHours * 3600 * 1000),
        solution: null,
        publisherConfirmed: false,
        acceptorConfirmed: false,
        submittedAt: null,
        settledAt: null,
        boostUntil: null,
        sortScore,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    commissionId = addRes._id;
    await t.collection('transactions').add({
      data: {
        userId: OPENID, type: 'escrow', currency,
        amount: -amt, balanceAfter: balance - amt, relatedId: commissionId,
        remark: `发布委托「${title.trim()}」托管`, createdAt: db.serverDate()
      }
    });
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
    if (e.bizCode === 'INSUFFICIENT') return fail(e.bizCode, e.message);
    console.error('[publishCommission] 事务失败:', e);
    return fail('TRANSACTION_FAIL', '发布失败，请重试');
  }
  return ok({ commissionId, star });
}

module.exports = {
  DEFAULTS, ok, fail, biz,
  toSilverEquiv, calcStar, calcFee, calcPublicSplits,
  getConfig, getEquippedEffect,
  settleCommission, settlePublicCommission, grantAchievements,
  calcThreeValues, calcFameFromScore, calcFameGain,
  applyThreeValues, grantThreeValueTitles,
  publishCommission,
  hashPassword, verifyPassword,
  requireUser, sanitizeUser, notifyUser
};
