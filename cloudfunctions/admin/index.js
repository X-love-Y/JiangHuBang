// admin —— 管理员面板：
//   委托管理（删除三选一资金处理/置顶/改金额星级）、用户管理（禁发/封禁/解封）、
//   聊天查阅、草稿查阅、流水查阅、公告广播、操作日志
// 所有资金类操作走事务 + 写 admin_logs 审计；身份校验 requireUser({needAdmin:true})
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const {
  ok, fail, biz, getConfig, requireUser, notifyUser,
  calcStar, settleCommission, settlePublicCommission
} = require('./business');

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[admin] 未捕获异常:', e);
    return fail('INTERNAL', '系统异常，请稍后重试');
  }
};

async function handle(event) {
  const auth = await requireUser(db, { needAccount: true, needAdmin: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { action } = event || {};
  if (action === 'commissionList') return commissionList(event);
  if (action === 'commissionDelete') return commissionDelete(OPENID, event);
  if (action === 'forcePin') return forcePin(OPENID, event);
  if (action === 'changeAmount') return changeAmount(OPENID, event);
  if (action === 'userSearch') return userSearch(event);
  if (action === 'userBan') return userBan(OPENID, event);
  if (action === 'userUnban') return userUnban(OPENID, event);
  if (action === 'listDrafts') return listDrafts(event);
  if (action === 'listChats') return listChats(event);
  if (action === 'chatMessages') return chatMessages(event);
  if (action === 'listTransactions') return listTransactions(event);
  if (action === 'announcementCreate') return announcementCreate(OPENID, event);
  if (action === 'announcementList') return announcementList(event);
  if (action === 'logList') return logList(event);
  if (action === 'dashboard') return dashboard();
  return fail('INVALID_ACTION', '未知操作');
}

// ===== 财务看板（老板视角）：平台收入/充值/托管/用户资产/趋势/分类占比/头部用户 =====
async function dashboard() {
  const $ = db.command.aggregate;
  const now = new Date();
  const days = 14;
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  const dayKey = (d) => {
    const x = new Date(d);
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  };

  const [feeRes, confRes, recRes, comRes, escrowRes, silverTopRes, goldTopRes] = await Promise.all([
    db.collection('transactions').where({ type: 'fee', createdAt: _.gte(dayStart) }).limit(1000).get(),
    db.collection('transactions').where({ type: 'confiscate' }).limit(200).get(),
    db.collection('transactions').where({ type: 'recharge', createdAt: _.gte(dayStart) }).limit(1000).get(),
    db.collection('commissions').where({ createdAt: _.gte(dayStart) }).limit(1000).get(),
    db.collection('commissions').where({ status: _.in(['pending', 'accepted', 'submitted']) }).limit(1000).get(),
    db.collection('users').orderBy('silver', 'desc').limit(30).get(),
    db.collection('users').orderBy('gold', 'desc').limit(10).get()
  ]);
  // 头部用户：白银榜与黄金榜合并，按总资产（银 + 金×100）综合排序
  const silverTop = (silverTopRes && silverTopRes.data) || [];
  const goldTop = (goldTopRes && goldTopRes.data) || [];
  const merged = {};
  silverTop.forEach((u) => { merged[u._id] = u; });
  goldTop.forEach((u) => { if (!merged[u._id]) merged[u._id] = u; });
  const topUsers = Object.values(merged)
    .map((u) => Object.assign({}, u, {
      totalEquiv: (u.silver || 0) + (u.gold || 0) * 100
    }))
    .sort((a, b) => b.totalEquiv - a.totalEquiv)
    .slice(0, 10)
    .map((u) => ({
      userId: u.userId || String(u._id).slice(-6),
      nickname: u.nickname || '江湖路人',
      silver: u.silver || 0,
      gold: u.gold || 0,
      completed: (u.stats && u.stats.completed) || 0,
      totalEquiv: u.totalEquiv
    }));

  const [catAgg, balAgg] = await Promise.all([
    db.collection('commissions').aggregate()
      .group({ _id: '$categoryId', count: $.sum(1) }).end().catch(() => ({ list: [] })),
    db.collection('users').aggregate()
      .group({ _id: null, silver: $.sum('$silver'), gold: $.sum('$gold') }).end().catch(() => ({ list: [] }))
  ]);

  // 日序列
  const daily = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(dayStart.getTime() + i * 86400000);
    daily[dayKey(d)] = { date: dayKey(d).slice(5), fee: 0, recharge: 0, commissions: 0 };
  }
  let feeSilver = 0;
  let feeGold = 0;
  feeRes.data.forEach((t) => {
    const k = dayKey(t.createdAt);
    const v = t.currency === 'gold' ? t.amount * 100 : t.amount; // 折线统一折算白银
    if (daily[k]) daily[k].fee += v;
    if (t.currency === 'gold') feeGold += t.amount;
    else feeSilver += t.amount;
  });
  confRes.data.forEach((t) => {
    if (t.currency === 'gold') feeGold += t.amount;
    else feeSilver += t.amount;
  });
  let rechargeTotal = 0;
  recRes.data.forEach((t) => {
    const k = dayKey(t.createdAt);
    if (!daily[k]) return;
    rechargeTotal += t.amount;
    daily[k].recharge += t.amount;
  });
  comRes.data.forEach((c) => {
    const k = dayKey(c.createdAt);
    if (daily[k]) daily[k].commissions += 1;
  });

  const escrowSilver = escrowRes.data.filter((c) => c.currency === 'silver').reduce((a, c) => a + c.amount, 0);
  const escrowGold = escrowRes.data.filter((c) => c.currency === 'gold').reduce((a, c) => a + c.amount, 0);
  const bal = balAgg.list[0] || { silver: 0, gold: 0 };

  const catDist = (catAgg.list || [])
    .map((x) => ({ categoryId: x._id, count: x.count }))
    .sort((a, b) => b.count - a.count);

  return ok({
    feeSilver, feeGold,
    rechargeTotal, rechargeGold: 0, // 充值仅购白银，黄金充值为 0（结构预留）
    escrowSilver, escrowGold,
    balSilver: bal.silver || 0, balGold: bal.gold || 0,
    daily: Object.values(daily),
    catDist,
    topUsers
  });
}

async function audit(adminId, action, targetType, targetId, detail) {
  try {
    await db.collection('admin_logs').add({
      data: {
        adminId, action, targetType, targetId,
        detail: detail || null,
        createdAt: db.serverDate()
      }
    });
  } catch (e) {
    console.warn('[admin] 审计日志写入失败:', e.message);
  }
}

// ===== 委托列表（管理员视图，按编号或标题搜索） =====
async function commissionList(event) {
  const { keyword, page = 1, pageSize = 10 } = event || {};
  const size = Math.min(Number(pageSize) || 10, 20);
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;
  const kw = String(keyword || '').trim().slice(0, 20);

  let all = [];
  if (!kw) {
    // 留空：查询全部
    const [listRes, totalRes] = await Promise.all([
      db.collection('commissions').orderBy('createdAt', 'desc').skip(skip).limit(size).get(),
      db.collection('commissions').count()
    ]);
    return ok({ list: listRes.data, total: totalRes.total, hasMore: skip + listRes.data.length < totalRes.total });
  }
  // 编号精确 + 标题模糊：两次查询合并去重（避免 _.or 兼容问题）
  const [byNo, byTitle] = await Promise.all([
    db.collection('commissions').where({ commissionNo: kw }).limit(20).get(),
    db.collection('commissions').where({ title: db.RegExp({ regexp: kw, options: 'i' }) })
      .orderBy('createdAt', 'desc').limit(50).get()
  ]);
  const seen = {};
  byNo.data.concat(byTitle.data).forEach((c) => { seen[c._id] = c; });
  all = Object.values(seen).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return ok({ list: all.slice(skip, skip + size), total: all.length, hasMore: skip + size < all.length });
}

// ===== 删除委托（三选一资金处理，必须显式选择） =====
async function commissionDelete(OPENID, event) {
  const { commissionId, mode, note } = event || {};
  if (!commissionId || !['refund', 'settle', 'confiscate'].includes(mode)) {
    return fail('INVALID_PARAM', '缺少委托 ID 或资金处理方式');
  }
  const reason = String(note || '').slice(0, 100);
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;

  if (mode === 'settle') {
    // 结算给接单者（submitted 状态）
    if (c.mode === 'public') {
      if (c.status !== 'submitted') return fail('INVALID_STATUS', '该委托当前不可结算');
      await settlePublicCommission(db, commissionId, await getConfig(db));
    } else {
      if (c.status !== 'submitted') return fail('INVALID_STATUS', '该委托当前不可结算');
      await settleCommission(db, commissionId, await getConfig(db));
    }
    await audit(OPENID, 'commissionDelete', 'commission', commissionId, { mode: 'settle', reason });
    await notifyUser(db, c.publisherId, 'admin', '委托已由管理员结算', `「${c.title}」已按管理员操作结算`, commissionId);
    return ok({ done: true, mode: 'settle' });
  }

  // refund / confiscate：事务处理（顶层原始值）
  if (!['pending', 'accepted', 'scheduled'].includes(c.status)) {
    return fail('INVALID_STATUS', '该委托当前不可删除（资金已处理）');
  }
  const field = c.currency === 'gold' ? 'gold' : 'silver';
  const t = await db.startTransaction();
  try {
    const cur = await t.collection('commissions').doc(commissionId).get();
    if (!['pending', 'accepted', 'scheduled'].includes(cur.data.status)) {
      throw biz('INVALID_STATUS', '该委托当前不可删除');
    }
    const now = db.serverDate();
    await t.collection('commissions').doc(commissionId).update({
      data: {
        status: 'cancelled',
        cancelBy: 'admin',
        cancelReason: reason || '管理员删除',
        cancelAt: Date.now(),
        updatedAt: now
      }
    });
    if (mode === 'refund') {
      // 全额退发布者
      const pub = await t.collection('users').doc(c.publisherId).get();
      const balanceAfter = (pub.data[field] || 0) + c.amount;
      await t.collection('users').doc(c.publisherId).update({
        data: { [field]: balanceAfter, updatedAt: now }
      });
      await t.collection('transactions').add({
        data: {
          userId: c.publisherId, type: 'refund', currency: c.currency,
          amount: c.amount, balanceAfter, relatedId: commissionId,
          remark: `委托「${c.title}」被管理员删除，全额退款`, createdAt: now
        }
      });
    } else {
      // 没收至平台
      await t.collection('transactions').add({
        data: {
          userId: 'PLATFORM', type: 'confiscate', currency: c.currency,
          amount: c.amount, balanceAfter: null, relatedId: commissionId,
          remark: `委托「${c.title}」被管理员删除，金额没收`, createdAt: now
        }
      });
    }
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 忽略 */ }
    if (e.bizCode) return fail(e.bizCode, e.message);
    console.error('[admin] 删除事务失败:', e);
    return fail('TRANSACTION_FAIL', '操作失败：' + String(e.message || '').slice(0, 100));
  }
  await audit(OPENID, 'commissionDelete', 'commission', commissionId, { mode, reason });
  await notifyUser(db, c.publisherId, 'admin', '委托已被管理员删除',
    `「${c.title}」已删除：${mode === 'refund' ? '金额已退回' : '金额已没收'}`, commissionId);
  return ok({ done: true, mode });
}

// ===== 强制置顶 24 小时 =====
async function forcePin(OPENID, event) {
  const { commissionId } = event || {};
  if (!commissionId) return fail('INVALID_PARAM', '缺少委托 ID');
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  await db.collection('commissions').doc(commissionId).update({
    data: {
      boostUntil: new Date(Date.now() + 24 * 3600 * 1000),
      sortScore: (c.sortScore || 0) + 1e12,
      updatedAt: db.serverDate()
    }
  });
  await audit(OPENID, 'forcePin', 'commission', commissionId, {});
  return ok({ done: true });
}

// ===== 强制改金额/星级（差额处理：增→发布者补扣；减→退差额） =====
async function changeAmount(OPENID, event) {
  const { commissionId, amount, star, note } = event || {};
  if (!commissionId) return fail('INVALID_PARAM', '缺少委托 ID');
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt < 1) return fail('INVALID_AMOUNT', '金额须为正整数');
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  if (!['pending', 'accepted'].includes(c.status)) return fail('INVALID_STATUS', '仅待接单/进行中的委托可改金额');
  const config = await getConfig(db);
  const field = c.currency === 'gold' ? 'gold' : 'silver';
  const diff = amt - c.amount;
  let newStar = calcStar(amt, c.currency, config.starThresholds, config.exchangeRate);

  const t = await db.startTransaction();
  try {
    const cur = await t.collection('commissions').doc(commissionId).get();
    if (!['pending', 'accepted'].includes(cur.data.status)) {
      throw biz('INVALID_STATUS', '仅待接单/进行中的委托可改金额');
    }
    const now = db.serverDate();
    if (diff !== 0) {
      const pub = await t.collection('users').doc(c.publisherId).get();
      const balance = pub.data[field] || 0;
      if (diff > 0) {
        if (balance < diff) throw biz('INSUFFICIENT', `发布者余额不足，需补扣 ${diff} ${field === 'gold' ? '金' : '银'}`);
        const balanceAfter = balance - diff;
        await t.collection('users').doc(c.publisherId).update({
          data: { [field]: balanceAfter, updatedAt: now }
        });
        await t.collection('transactions').add({
          data: {
            userId: c.publisherId, type: 'escrow', currency: c.currency,
            amount: -diff, balanceAfter, relatedId: commissionId,
            remark: `委托「${c.title}」金额由管理员调增`, createdAt: now
          }
        });
      } else {
        const balanceAfter = balance - diff;
        await t.collection('users').doc(c.publisherId).update({
          data: { [field]: balanceAfter, updatedAt: now }
        });
        await t.collection('transactions').add({
          data: {
            userId: c.publisherId, type: 'refund', currency: c.currency,
            amount: -diff, balanceAfter, relatedId: commissionId,
            remark: `委托「${c.title}」金额由管理员调减`, createdAt: now
          }
        });
      }
    }
    if (Number.isInteger(Number(star)) && Number(star) >= 1 && Number(star) <= 5) {
      newStar = Number(star);
    }
    await t.collection('commissions').doc(commissionId).update({
      data: { amount: amt, star: newStar, updatedAt: now }
    });
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 忽略 */ }
    if (e.bizCode) return fail(e.bizCode, e.message);
    console.error('[admin] 改金额事务失败:', e);
    return fail('TRANSACTION_FAIL', '操作失败：' + String(e.message || '').slice(0, 100));
  }
  await audit(OPENID, 'changeAmount', 'commission', commissionId, {
    before: { amount: c.amount, star: c.star }, after: { amount: amt, star: newStar }, note: note || ''
  });
  await notifyUser(db, c.publisherId, 'admin', '委托金额已调整',
    `「${c.title}」金额由 ${c.amount} 调整为 ${amt} ${c.currency === 'gold' ? '金' : '银'}`, commissionId);
  return ok({ done: true });
}

// ===== 用户搜索 =====
function pickUser(u) {
  return {
    _id: u._id,
    userId: u.userId || '',
    nickname: u.nickname || '江湖路人',
    silver: u.silver || 0,
    gold: u.gold || 0,
    adminLevel: u.adminLevel || 0,
    status: u.status || 1,
    publishBanUntil: u.publishBanUntil || null,
    chatBanUntil: u.chatBanUntil || null,
    stats: u.stats || {},
    rep: u.rep == null ? 500 : u.rep,
    fame: u.fame || 0,
    skill: u.skill == null ? 300 : u.skill
  };
}

async function userSearch(event) {
  const { keyword, page = 1, pageSize = 10 } = event || {};
  const kw = String(keyword || '').trim().slice(0, 20);
  const size = Math.min(Number(pageSize) || 10, 20);
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;

  let all = [];
  if (!kw) {
    const [listRes, totalRes] = await Promise.all([
      db.collection('users').orderBy('silver', 'desc').skip(skip).limit(size).get(),
      db.collection('users').count()
    ]);
    return ok({ list: listRes.data.map(pickUser), total: totalRes.total });
  }
  const [byId, byOpenid, byNick] = await Promise.all([
    db.collection('users').where({ userId: kw }).limit(10).get(),
    db.collection('users').where({ _id: kw }).limit(1).get(),
    db.collection('users').where({ nickname: db.RegExp({ regexp: kw, options: 'i' }) }).limit(30).get()
  ]);
  const seen = {};
  byId.data.concat(byOpenid.data).concat(byNick.data).forEach((u) => { seen[u._id] = u; });
  all = Object.values(seen);
  return ok({ list: all.slice(skip, skip + size).map(pickUser), total: all.length });
}

// ===== 禁发/禁言/封禁（可设期限） =====
async function userBan(OPENID, event) {
  const { userId, type, days, reason } = event || {};
  if (!userId || !['publish', 'chat', 'account'].includes(type)) return fail('INVALID_PARAM', '缺少用户或封禁类型');
  const uRes = await db.collection('users').doc(String(userId)).get().catch(() => null);
  if (!uRes || !uRes.data) return fail('NOT_FOUND', '用户不存在');
  const u = uRes.data;
  if (u._id === OPENID) return fail('SELF_BAN', '不能封禁自己');
  const d = type === 'account' ? 0 : (Number(days) || 7);
  const until = type === 'account' ? null : new Date(Date.now() + d * 24 * 3600 * 1000);
  const data = { updatedAt: db.serverDate() };
  if (type === 'publish') data.publishBanUntil = until;
  if (type === 'chat') data.chatBanUntil = until;
  if (type === 'account') data.status = -1;
  await db.collection('users').doc(u._id).update({ data });
  await audit(OPENID, 'userBan', 'user', u._id, { type, days: d, reason: reason || '' });
  await notifyUser(db, u._id, 'admin', '账号处罚通知',
    type === 'account' ? '你的账号已被封禁' : `你被${type === 'publish' ? '暂停发布' : '禁言'} ${d} 天：${reason || ''}`, '');
  return ok({ done: true });
}

// ===== 解封 =====
async function userUnban(OPENID, event) {
  const { userId } = event || {};
  if (!userId) return fail('INVALID_PARAM', '缺少用户');
  const uRes = await db.collection('users').doc(String(userId)).get().catch(() => null);
  if (!uRes || !uRes.data) return fail('NOT_FOUND', '用户不存在');
  await db.collection('users').doc(uRes.data._id).update({
    data: {
      status: 1,
      publishBanUntil: null,
      chatBanUntil: null,
      updatedAt: db.serverDate()
    }
  });
  await audit(OPENID, 'userUnban', 'user', uRes.data._id, {});
  return ok({ done: true });
}

// ===== 查看任意用户草稿 =====
async function listDrafts(event) {
  const { userId, page = 1, pageSize = 10 } = event || {};
  const kw = String(userId || '').trim().slice(0, 20);
  const size = Math.min(Number(pageSize) || 10, 20);
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;
  // 留空：查询全部草稿
  if (!kw) {
    const [listRes, totalRes] = await Promise.all([
      db.collection('drafts').orderBy('createdAt', 'desc').skip(skip).limit(size).get(),
      db.collection('drafts').count()
    ]);
    return ok({ list: listRes.data, total: totalRes.total });
  }
  // 支持 账号ID / openid / 昵称 → 解析出 openid 列表
  const [uById, uByOpenid, uByNick] = await Promise.all([
    db.collection('users').where({ userId: kw }).limit(10).get(),
    db.collection('users').where({ _id: kw }).limit(1).get(),
    db.collection('users').where({ nickname: db.RegExp({ regexp: kw.slice(0, 20), options: 'i' }) }).limit(20).get()
  ]);
  const seen = {};
  uById.data.concat(uByOpenid.data).concat(uByNick.data).forEach((u) => { seen[u._id] = u; });
  const matched = Object.values(seen);
  if (!matched.length) return fail('USER_NOT_FOUND', '未找到该用户（可输账号 ID、昵称或 openid）');
  const ownerIds = matched.map((u) => u._id);
  const [listRes, totalRes] = await Promise.all([
    db.collection('drafts').where({ ownerId: _.in(ownerIds) })
      .orderBy('createdAt', 'desc').skip(skip).limit(size).get(),
    db.collection('drafts').where({ ownerId: _.in(ownerIds) }).count()
  ]);
  return ok({ list: listRes.data, total: totalRes.total });
}

// ===== 查看所有会话/聊天 =====
async function listChats(event) {
  const { keyword } = event || {};
  const kw = String(keyword || '').trim().slice(0, 20);
  let convs = [];
  if (!kw) {
    const res = await db.collection('conversations').orderBy('lastAt', 'desc').limit(50).get();
    convs = res.data;
  } else {
    const [byId, byTitle] = await Promise.all([
      db.collection('conversations').where({ commissionId: kw }).limit(10).get(),
      db.collection('conversations').where({ commissionTitle: db.RegExp({ regexp: kw, options: 'i' }) }).limit(50).get()
    ]);
    const seen = {};
    byId.data.concat(byTitle.data).forEach((c) => { seen[c._id] = c; });
    convs = Object.values(seen).sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
  }
  const res = { data: convs };
  return ok({ list: res.data.map((c) => ({
    conversationId: c._id,
    commissionId: c.commissionId,
    commissionTitle: c.commissionTitle || '',
    memberNames: (c.members || []).map((m) => ((c.memberSnapshots || {})[m] || {}).nickname || m).join('、'),
    lastPreview: c.lastPreview || '',
    lastAt: c.lastAt
  })) });
}

// ===== 查看指定会话的完整消息（管理员查阅） =====
async function chatMessages(event) {
  const { conversationId } = event || {};
  if (!conversationId) return fail('INVALID_PARAM', '缺少会话 ID');
  const cRes = await db.collection('conversations').doc(conversationId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '会话不存在');
  const conv = cRes.data;
  const res = await db.collection('messages')
    .where({ conversationId })
    .orderBy('createdAt', 'desc').limit(100).get();
  const snap = conv.memberSnapshots || {};
  return ok({
    conversation: {
      commissionTitle: conv.commissionTitle || '',
      memberNames: (conv.members || []).map((m) => (snap[m] || {}).nickname || m).join('、')
    },
    messages: res.data.reverse().map((m) => ({
      _id: m._id,
      senderName: (snap[m.senderId] || {}).nickname || m.senderId,
      type: m.type,
      text: m.text || '',
      fileId: m.fileId || '',
      duration: m.duration || 0,
      createdAt: m.createdAt
    }))
  });
}

// ===== 查看流水 =====
async function listTransactions(event) {
  const { userId, page = 1, pageSize = 20 } = event || {};
  const size = Math.min(Number(pageSize) || 20, 50);
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;
  let q = db.collection('transactions');
  let qc = db.collection('transactions');
  if (userId) {
    q = q.where({ userId: String(userId) });
    qc = qc.where({ userId: String(userId) });
  }
  const [listRes, totalRes] = await Promise.all([
    q.orderBy('createdAt', 'desc').skip(skip).limit(size).get(),
    qc.count()
  ]);
  // 补用户身份（昵称/账号ID）
  const ids = [...new Set(listRes.data.map((t) => t.userId).filter((x) => x && x !== 'PLATFORM'))];
  const usersMap = {};
  if (ids.length) {
    const uRes = await db.collection('users').where({ _id: _.in(ids) }).limit(50).get();
    uRes.data.forEach((u) => {
      usersMap[u._id] = { nickname: u.nickname || '江湖路人', accountId: u.userId || '' };
    });
  }
  const list = listRes.data.map((t) => Object.assign({}, t, {
    userName: t.userId === 'PLATFORM'
      ? '平台'
      : ((usersMap[t.userId] && (usersMap[t.userId].accountId || usersMap[t.userId].nickname)) || String(t.userId).slice(-8)),
    userNickname: t.userId === 'PLATFORM' ? '' : ((usersMap[t.userId] && usersMap[t.userId].nickname) || '')
  }));
  return ok({ list, total: totalRes.total });
}

// ===== 公告广播 =====
async function announcementCreate(OPENID, event) {
  const { content, expireHours } = event || {};
  const text = String(content || '').trim();
  if (!text) return fail('INVALID_PARAM', '公告内容不能为空');
  if (text.length > 200) return fail('INVALID_PARAM', '公告最多 200 字');
  const hours = Math.min(Math.max(Number(expireHours) || 24, 1), 24 * 30);
  await db.collection('announcements').add({
    data: {
      content: text,
      byAdminId: OPENID,
      expireAt: new Date(Date.now() + hours * 3600 * 1000),
      createdAt: db.serverDate()
    }
  });
  await audit(OPENID, 'announcementCreate', 'announcement', '', { content: text });
  return ok({ done: true });
}

async function announcementList() {
  // 历史公告：最近 30 条（含已过期），附状态标记
  const res = await db.collection('announcements')
    .orderBy('createdAt', 'desc').limit(30).get();
  const now = Date.now();
  const list = res.data.map((a) => Object.assign({}, a, {
    expired: !a.expireAt || new Date(a.expireAt).getTime() <= now
  }));
  return ok({ list });
}

// ===== 操作日志 =====
async function logList(event) {
  const { page = 1, pageSize = 20 } = event || {};
  const size = Math.min(Number(pageSize) || 20, 50);
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;
  const [listRes, totalRes] = await Promise.all([
    db.collection('admin_logs').orderBy('createdAt', 'desc').skip(skip).limit(size).get(),
    db.collection('admin_logs').count()
  ]);
  return ok({ list: listRes.data, total: totalRes.total });
}
