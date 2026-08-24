// shopPurchase —— 商城购买：校验黄金余额 + 解锁条件 → 扣款 → 发货（称号/背包/AI月卡）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, fail, biz, requireUser } = require('./business');

exports.main = async (event) => {
  const auth = await requireUser(db);
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { itemId, action } = event || {};
  // 商城目录游客可浏览；购买需注册账号
  if (action === 'catalog') return catalog(OPENID);
  if (!auth.user.userId) return fail('NEED_REGISTER', '该操作需要注册账号');
  if (!itemId) return fail('INVALID_PARAM', '缺少商品 ID');

  const itemRes = await db.collection('shop_items').doc(itemId).get().catch(() => null);
  if (!itemRes || !itemRes.data || itemRes.data.status !== 1) return fail('NOT_FOUND', '商品不存在或已下架');
  const item = itemRes.data;

  const uRes = await db.collection('users').doc(OPENID).get();
  const user = uRes.data;

  // ---- 解锁条件：completedCount 达标 ----
  if (item.unlock && item.unlock.metric === 'completedCount') {
    const done = (user.stats && user.stats.completed) || 0;
    if (done < item.unlock.value) {
      return fail('UNLOCK_REQUIRED', `需累计完成 ${item.unlock.value} 单委托才能购买`);
    }
  }

  // ---- 重复购买检查 ----
  if (item.type === 'title' && (user.titleIds || []).includes(itemId)) {
    return fail('ALREADY_OWNED', '已拥有该称号');
  }

  // ---- AI 月卡：未过期则续期 ----
  if (item.type === 'aiPass' && user.aiPassExpire && new Date(user.aiPassExpire).getTime() > Date.now()) {
    // 允许续期（到期时间叠加）
  }

  const t = await db.startTransaction();
  try {
    const cur = await t.collection('users').doc(OPENID).get();
    if ((cur.data.gold || 0) < item.price) {
      throw biz('INSUFFICIENT', `黄金不足，当前余额 ${cur.data.gold || 0} 金`);
    }
    const goldAfter = (cur.data.gold || 0) - item.price;
    const now = db.serverDate();

    await t.collection('users').doc(OPENID).update({
      data: { gold: _.inc(-item.price), updatedAt: now }
    });
    await t.collection('transactions').add({
      data: {
        userId: OPENID, type: 'consume', currency: 'gold', amount: -item.price,
        balanceAfter: goldAfter, relatedId: itemId,
        remark: `商城购买·${item.name}`, createdAt: now
      }
    });

    // ---- 按类型发货 ----
    if (item.type === 'title') {
      await t.collection('users').doc(OPENID).update({
        data: { titleIds: _.push([itemId]), updatedAt: now }
      });
    } else if (item.type === 'aiPass') {
      const base = user.aiPassExpire && new Date(user.aiPassExpire).getTime() > Date.now()
        ? new Date(user.aiPassExpire)
        : new Date();
      await t.collection('users').doc(OPENID).update({
        data: { aiPassExpire: new Date(base.getTime() + 30 * 24 * 3600 * 1000), updatedAt: now }
      });
    } else {
      // 卡面/喇叭/推送/置顶/优先等 → 背包
      const bagRes = await t.collection('user_items')
        .where({ userId: OPENID, itemId }).limit(1).get();
      if (bagRes.data.length) {
        await t.collection('user_items').doc(bagRes.data[0]._id).update({
          data: { total: _.inc(1), updatedAt: now }
        });
      } else {
        await t.collection('user_items').add({
          data: {
            userId: OPENID, itemId,
            name: item.name, type: item.type, effect: item.effect || null,
            total: 1, used: 0,
            expireAt: item.durationDays ? new Date(Date.now() + item.durationDays * 24 * 3600 * 1000) : null,
            createdAt: now, updatedAt: now
          }
        });
      }
    }
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
    if (e.bizCode) return fail(e.bizCode, e.message);
    console.error('[shopPurchase] 事务失败:', e);
    return fail('TRANSACTION_FAIL', '购买失败，请重试');
  }
  return ok({ purchased: true, item: { itemId, name: item.name, price: item.price } });
};

// 商城目录：商品列表 + 拥有状态 + 解锁状态 + 我的余额
async function catalog(OPENID) {
  const [itemsRes, uRes, bagRes] = await Promise.all([
    db.collection('shop_items').where({ status: 1 }).orderBy('sort', 'asc').get(),
    db.collection('users').doc(OPENID).get().catch(() => null),
    db.collection('user_items').where({ userId: OPENID }).get()
  ]);
  const user = uRes && uRes.data ? uRes.data : { titleIds: [], stats: {}, gold: 0, silver: 0 };
  const bagMap = {};
  bagRes.data.forEach((b) => { bagMap[b.itemId] = b; });
  const items = itemsRes.data.map((it) => {
    const bag = bagMap[it.itemId];
    const remaining = bag ? bag.total - bag.used : 0;
    return Object.assign({}, it, {
      owned: it.type === 'title'
        ? (user.titleIds || []).includes(it.itemId)
        : (it.type === 'card' ? !!bag : remaining > 0),
      bagCount: remaining,
      unlocked: !it.unlock || !it.unlock.value || ((user.stats || {}).completed || 0) >= it.unlock.value
    });
  });
  return ok({
    items,
    user: {
      gold: user.gold || 0,
      silver: user.silver || 0,
      completed: (user.stats || {}).completed || 0
    }
  });
}
