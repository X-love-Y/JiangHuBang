// useItem —— 道具使用 / 称号佩戴 / 卡面佩戴 / 资料更新
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, fail, biz, requireUser } = require('./business');

exports.main = async (event) => {
  const auth = await requireUser(db);
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { action, itemId, commissionId, titleId, cardId, profile } = event || {};

  // 背包读取游客可用（「我的」页依赖）；个人主页游客可看；其余动作需注册账号
  if (action === 'myBag') return myBag(OPENID);
  if (action === 'userProfile') return userProfile(OPENID, event);
  if (!auth.user.userId) return fail('NEED_REGISTER', '该操作需要注册账号');

  if (action === 'use') return useItem(OPENID, itemId, commissionId);
  if (action === 'equipTitle') return equipTitle(OPENID, titleId);
  if (action === 'equipCard') return equipCard(OPENID, cardId);
  if (action === 'updateProfile') return updateProfile(OPENID, profile);
  if (action === 'updatePrivacy') return updatePrivacy(OPENID, event);
  return fail('INVALID_ACTION', '未知操作');
}

// ===== 个人主页数据（他人视角尊重隐私开关；本人全可见） =====
async function userProfile(OPENID, event) {
  const { userId } = event || {};
  const targetId = userId || OPENID;
  const uRes = await db.collection('users').doc(targetId).get().catch(() => null);
  if (!uRes || !uRes.data) return fail('NOT_FOUND', '用户不存在');
  const u = uRes.data;
  const isSelf = targetId === OPENID;
  const privacy = u.privacy || {};

  const profile = {
    nickname: u.nickname || '江湖路人',
    avatarUrl: u.avatarUrl || '',
    bio: u.bio || '',
    cardId: u.cardId || '',
    userId: u.userId || '',
    registeredAt: u.registeredAt || null,
    isSelf
  };

  // 三值（隐私：本人全可见；他人按开关）
  const showThree = isSelf || privacy.showThree !== false;
  const showStats = isSelf || privacy.showStats !== false;
  const showTitles = isSelf || privacy.showTitles !== false;
  const showCompleted = isSelf || privacy.showCompleted !== false;
  profile.rep = showThree ? (u.rep == null ? 500 : u.rep) : null;
  profile.fame = showThree ? (u.fame || 0) : null;
  profile.skill = showThree ? (u.skill == null ? 300 : u.skill) : null;
  profile.stats = showStats ? (u.stats || {}) : null;

  // 佩戴称号（隐私）
  profile.titleName = '';
  profile.titleIcon = '';
  if (showTitles && u.equippedTitleId) {
    const t = await db.collection('titles').doc(u.equippedTitleId).get().catch(() => null);
    if (t && t.data) {
      profile.titleName = t.data.name;
      profile.titleIcon = t.data.icon || '';
    }
  }

  // 评价聚合（公开）
  const reviews = await db.collection('reviews').where({ revieweeId: targetId }).get().catch(() => ({ data: [] }));
  const cnt = reviews.data.length;
  profile.reviewCount = cnt;
  profile.avgStar = cnt
    ? Math.round((reviews.data.reduce((a, r) => a + (r.star || 0), 0) / cnt) * 10) / 10
    : 0;

  // 最近完成记录（隐私）
  profile.completedList = [];
  if (showCompleted) {
    const [donePrivate, donePublic] = await Promise.all([
      db.collection('commissions')
        .where({ status: 'settled', acceptorId: targetId })
        .orderBy('settledAt', 'desc').limit(10).get().catch(() => ({ data: [] })),
      db.collection('commissions')
        .where({ status: 'settled', mode: 'public', 'acceptors.userId': targetId })
        .orderBy('settledAt', 'desc').limit(10).get().catch(() => ({ data: [] }))
    ]);
    profile.completedList = donePrivate.data.concat(donePublic.data)
      .sort((a, b) => new Date(b.settledAt).getTime() - new Date(a.settledAt).getTime())
      .slice(0, 10)
      .map((c) => ({
        _id: c._id, title: c.title, star: c.star,
        amount: c.amount, currency: c.currency, settledAt: c.settledAt
      }));
  }

  profile.privacy = isSelf ? Object.assign({}, privacy) : null;
  return ok({ profile });
}

// ===== 隐私开关更新 =====
async function updatePrivacy(OPENID, event) {
  const { privacy } = event || {};
  if (!privacy || typeof privacy !== 'object') return fail('INVALID_PARAM', '缺少隐私配置');
  const p = {};
  ['showThree', 'showStats', 'showTitles', 'showCompleted'].forEach((k) => {
    if (typeof privacy[k] === 'boolean') p[`privacy.${k}`] = privacy[k];
  });
  if (!Object.keys(p).length) return fail('INVALID_PARAM', '无可更新项');
  p.updatedAt = db.serverDate();
  await db.collection('users').doc(OPENID).update({ data: p });
  return ok({ privacy: Object.assign({}, ((await db.collection('users').doc(OPENID).get()).data.privacy || {})) });
}

// ===== 我的背包 + 称号 + 用户信息（详情页/商城/称号页共用） =====
async function myBag(OPENID) {
  const [uRes, bagRes, titleRes] = await Promise.all([
    db.collection('users').doc(OPENID).get().catch(() => null),
    db.collection('user_items').where({ userId: OPENID }).get(),
    db.collection('titles').get()
  ]);
  const user = uRes && uRes.data ? uRes.data : null;
  const titlesMap = {};
  titleRes.data.forEach((t) => { titlesMap[t.titleId] = t; });
  const ownedIds = user ? user.titleIds || [] : [];
  const ownedTitles = ownedIds.map((id) => titlesMap[id]).filter(Boolean);
  // 全称号目录（按 sort 排序），附拥有状态，供称号页展示成就进度
  const allTitles = titleRes.data
    .slice()
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .map((t) => Object.assign({}, t, { owned: ownedIds.includes(t.titleId) }));
  return ok({
    user,
    bag: bagRes.data.map((b) => Object.assign({}, b, { remaining: b.total - b.used })),
    ownedTitles,
    allTitles
  });
}

// ===== 使用消耗型道具 =====
async function useItem(OPENID, itemId, commissionId) {
  if (!itemId) return fail('INVALID_PARAM', '缺少道具 ID');

  const bagRes = await db.collection('user_items')
    .where({ userId: OPENID, itemId }).limit(1).get();
  if (!bagRes.data.length) return fail('NOT_OWNED', '未拥有该道具');
  const bag = bagRes.data[0];
  if (bag.total - bag.used < 1) return fail('NOT_ENOUGH', '道具已用完');
  if (bag.expireAt && new Date(bag.expireAt).getTime() < Date.now()) {
    return fail('EXPIRED', '道具已过期');
  }

  // 喇叭/置顶符：需指定委托且为本人发布、未结算
  if ((itemId === 'trumpet' || itemId === 'boost24') && !commissionId) {
    return fail('INVALID_PARAM', '请选择要使用的委托');
  }

  let boostCommission = null;
  if (commissionId) {
    const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
    if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
    if (cRes.data.publisherId !== OPENID) return fail('FORBIDDEN', '只能对自己的委托使用道具');
    if (!['pending', 'accepted'].includes(cRes.data.status)) {
      return fail('INVALID_STATUS', '该委托状态不可使用此道具');
    }
    boostCommission = cRes.data;
  }

  const t = await db.startTransaction();
  try {
    const curBag = await t.collection('user_items').doc(bag._id).get();
    if (curBag.data.total - curBag.data.used < 1) throw biz('NOT_ENOUGH', '道具已用完');
    await t.collection('user_items').doc(bag._id).update({
      data: { used: _.inc(1), updatedAt: db.serverDate() }
    });

    if (itemId === 'trumpet' || itemId === 'boost24') {
      // 喇叭/置顶符：委托占据广播位+大厅置顶 24h
      const boostUntil = new Date(Date.now() + 24 * 3600 * 1000);
      await t.collection('commissions').doc(commissionId).update({
        data: {
          boostUntil,
          sortScore: 1e12 + boostUntil.getTime(),
          updatedAt: db.serverDate()
        }
      });
    }
    if (itemId === 'priority') {
      // 先声夺人：24h 内发布的委托权重 +50%
      await t.collection('users').doc(OPENID).update({
        data: {
          priorityBoostUntil: new Date(Date.now() + 24 * 3600 * 1000),
          updatedAt: db.serverDate()
        }
      });
    }
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
    if (e.bizCode) return fail(e.bizCode, e.message);
    console.error('[useItem] 事务失败:', e);
    return fail('TRANSACTION_FAIL', '使用失败，请重试');
  }

  if (itemId === 'push') {
    // 委托推送：v1 为模拟推送（真实实现需接入订阅消息服务）
    return ok({ used: true, message: '已向 100 名匹配侠士推送该委托（模拟）' });
  }
  const names = { trumpet: '传音喇叭', boost24: '置顶符', priority: '先声夺人', push: '委托推送' };
  return ok({ used: true, message: `${names[itemId] || '道具'}使用成功` });
}

// ===== 佩戴称号 =====
async function equipTitle(OPENID, titleId) {
  if (!titleId) return fail('INVALID_PARAM', '缺少称号 ID');
  const uRes = await db.collection('users').doc(OPENID).get();
  if (!(uRes.data.titleIds || []).includes(titleId)) return fail('NOT_OWNED', '未拥有该称号');
  await db.collection('users').doc(OPENID).update({
    data: { equippedTitleId: titleId, updatedAt: db.serverDate() }
  });
  return ok({ equippedTitleId: titleId });
}

// ===== 佩戴卡面 =====
async function equipCard(OPENID, cardId) {
  const uRes = await db.collection('users').doc(OPENID).get();
  const owned = cardId
    ? (uRes.data.titleIds || []).includes(cardId) ||
      (await db.collection('user_items').where({ userId: OPENID, itemId: cardId, type: 'card' }).limit(1).get()).data.length > 0
    : true; // 空值=卸下卡面
  if (!owned) return fail('NOT_OWNED', '未拥有该卡面');
  await db.collection('users').doc(OPENID).update({
    data: { cardId: cardId || '', updatedAt: db.serverDate() }
  });
  return ok({ cardId: cardId || '' });
}

// ===== 资料更新 =====
async function updateProfile(OPENID, profile) {
  const data = {};
  if (profile && profile.nickname !== undefined) {
    const nick = String(profile.nickname).trim();
    if (nick.length < 1 || nick.length > 16) return fail('INVALID_NICKNAME', '昵称需 1-16 字');
    data.nickname = nick;
  }
  if (profile && profile.avatarUrl !== undefined) {
    data.avatarUrl = String(profile.avatarUrl).slice(0, 500);
  }
  if (profile && profile.bio !== undefined) {
    data.bio = String(profile.bio).slice(0, 100);
  }
  if (!Object.keys(data).length) return fail('INVALID_PARAM', '无可更新内容');
  data.updatedAt = db.serverDate();
  await db.collection('users').doc(OPENID).update({ data });
  const u = await db.collection('users').doc(OPENID).get();
  return ok({ user: u.data });
}
