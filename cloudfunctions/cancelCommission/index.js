// cancelCommission —— 取消/放弃：按状态机退款 + 信用计数（防恶意锁单）
// action=cancel（发布者取消，全额退回） / action=giveUp（接单者放弃，退回待接单）
// ⚠️ 云开发事务 update 不支持嵌套对象（PathNotViable），取消信息用扁平字段：
//    cancelBy / cancelReason / cancelAt（毫秒时间戳），全部纯原始值
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, fail, biz, getConfig, requireUser, notifyUser, applyThreeValues } = require('./business');

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[cancelCommission] 未捕获异常:', e);
    return fail('INTERNAL', '系统异常，请稍后重试');
  }
};

async function handle(event) {
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { commissionId, reason, action = 'cancel' } = event || {};
  if (!commissionId) return fail('INVALID_PARAM', '缺少委托 ID');
  const note = String(reason || '').slice(0,100);

  const config = await getConfig(db);
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;

  if (action === 'cancel') {
    if (c.publisherId !== OPENID) return fail('FORBIDDEN', '只有发布者才能取消委托');
    // scheduled（定时待发）也可取消
    if (!['pending', 'accepted', 'scheduled'].includes(c.status)) {
      return fail('INVALID_STATUS', '当前状态不可取消');
    }
    const r = await cancelByPublisher(commissionId, c, note);
    // 公共模式：通知所有申请人/合作者
    if (r.ok && c.mode === 'public') {
      const ids = [
        ...(c.acceptors || []).map((a) => a.userId),
        ...(c.requests || []).filter((x) => x.status === 'pending').map((x) => x.userId)
      ];
      for (const id of [...new Set(ids)]) {
        await notifyUser(db, id, 'cancelled', '委托取消',
          `「${c.title}」已被发布者取消`, commissionId);
      }
    }
    return r;
  }

  if (action === 'giveUp') {
    if (c.acceptorId !== OPENID) return fail('FORBIDDEN', '只有接单者才能放弃');
    if (c.status !== 'accepted') return fail('INVALID_STATUS', '当前状态不可放弃');
    return giveUp(commissionId, note, config, OPENID);
  }
  return fail('INVALID_ACTION', '未知操作');
}

// 发布者取消：全额退回托管金额（pending 或 accepted 阶段均可）
async function cancelByPublisher(commissionId, c, note) {
  const field = c.currency === 'gold' ? 'gold' : 'silver';
  let t = null;
  try {
    t = await db.startTransaction();
    const cur = await t.collection('commissions').doc(commissionId).get();
    if (!['pending', 'accepted', 'scheduled'].includes(cur.data.status)) {
      throw biz('INVALID_STATUS', '当前状态不可取消');
    }
    const pub = await t.collection('users').doc(c.publisherId).get();
    const balanceAfter = (pub.data[field] || 0) + c.amount;

    // 1. 委托置为取消（全部顶层原始值）
    await t.collection('commissions').doc(commissionId).update({
      data: {
        status: 'cancelled',
        cancelBy: 'publisher',
        cancelReason: note,
        cancelAt: Date.now(),
        updatedAt: db.serverDate()
      }
    });
    // 2. 发布者余额退回（写计算后的绝对值）
    await t.collection('users').doc(c.publisherId).update({
      data: { [field]: balanceAfter, updatedAt: db.serverDate() }
    });
    // 3. 退款流水
    await t.collection('transactions').add({
      data: {
        userId: c.publisherId, type: 'refund', currency: c.currency,
        amount: c.amount, balanceAfter, relatedId: commissionId,
        remark: `委托「${c.title}」取消退款`, createdAt: db.serverDate()
      }
    });
    await t.commit();
  } catch (e) {
    if (t) { try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ } }
    if (e.bizCode) return fail(e.bizCode, e.message);
    console.error('[cancelCommission] 取消事务失败:', e);
    return fail('TRANSACTION_FAIL', '取消失败：' + errText(e));
  }

  // 事务外：关联订单置为取消（记录性数据，非资金关键路径）
  try {
    const orderRes = await db.collection('orders').where({ commissionId }).get();
    if (orderRes.data.length) {
      await db.collection('orders').doc(orderRes.data[0]._id).update({
        data: {
          status: 'cancelled',
          cancelBy: 'publisher',
          cancelReason: note,
          cancelAt: Date.now()
        }
      });
    }
  } catch (e) {
    console.warn('[cancelCommission] 订单状态同步失败（不影响退款）:', e.message);
  }
  // 违约计数 + 三值重算（非资金路径）
  await db.collection('users').doc(c.publisherId).update({
    data: { 'stats.cancelAsPublisher': _.inc(1), updatedAt: db.serverDate() }
  }).catch(() => {});
  await applyThreeValues(db, c.publisherId);
  return ok({ cancelled: true });
}

// 接单者放弃：退回待接单状态 + 24h 内放弃 3 次封接单权
async function giveUp(commissionId, note, config, OPENID) {
  let t = null;
  try {
    t = await db.startTransaction();
    const cur = await t.collection('commissions').doc(commissionId).get();
    if (cur.data.status !== 'accepted') throw biz('INVALID_STATUS', '当前状态不可放弃');
    await t.collection('commissions').doc(commissionId).update({
      data: {
        status: 'pending',
        acceptorId: null,
        acceptedAt: null,
        updatedAt: db.serverDate()
      }
    });
    await t.commit();
  } catch (e) {
    if (t) { try { await t.rollback(); } catch (e2) { /* 忽略 */ } }
    if (e.bizCode) return fail(e.bizCode, e.message);
    console.error('[cancelCommission] 放弃事务失败:', e);
    return fail('TRANSACTION_FAIL', '操作失败：' + errText(e));
  }

  // 事务外：订单取消标记
  try {
    const orderRes = await db.collection('orders').where({ commissionId }).get();
    if (orderRes.data.length) {
      await db.collection('orders').doc(orderRes.data[0]._id).update({
        data: {
          status: 'cancelled',
          cancelBy: 'acceptor',
          cancelReason: note,
          cancelAt: Date.now()
        }
      });
    }
  } catch (e) {
    console.warn('[cancelCommission] 订单状态同步失败:', e.message);
  }

  // 事务外：信用计数 + 三值重算
  await db.collection('users').doc(OPENID).update({
    data: {
      'stats.cancelled': _.inc(1),
      'stats.giveUpCount': _.inc(1),
      updatedAt: db.serverDate()
    }
  });
  await applyThreeValues(db, OPENID);
  const windowStart = Date.now() - 24 * 3600 * 1000;
  const strikes = await db.collection('orders')
    .where({
      acceptorId: OPENID,
      status: 'cancelled',
      cancelBy: 'acceptor',
      cancelAt: _.gte(windowStart)
    }).count();
  let banned = false;
  if (strikes.total >= config.giveUpStrikeMax) {
    await db.collection('users').doc(OPENID).update({
      data: {
        acceptBanUntil: new Date(Date.now() + config.giveUpBanHours * 3600 * 1000),
        updatedAt: db.serverDate()
      }
    });
    banned = true;
  }
  return ok({
    givenUp: true,
    banned,
    message: banned ? `24 小时内放弃 ${strikes.total} 次，接单权封禁 ${config.giveUpBanHours} 小时` : ''
  });
}

// 提取可读错误文案
function errText(e) {
  if (!e) return '未知错误';
  if (e.errMsg) return String(e.errMsg).slice(0, 120);
  if (e.message) return String(e.message).slice(0, 120);
  return String(e).slice(0, 120);
}
