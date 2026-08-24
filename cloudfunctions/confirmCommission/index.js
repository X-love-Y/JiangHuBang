// confirmCommission —— 完成确认：
//   私人模式：双方确认（顺序任意）→ 结算事务
//   公共模式：发布者逐人确认（userId）或一键全部确认（all:true），全员确认后 → 公共结算事务
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { ok, fail, biz, getConfig, settleCommission, settlePublicCommission, requireUser } = require('./business');

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[confirmCommission] 未捕获异常:', e);
    return fail('INTERNAL', '系统异常，请稍后重试');
  }
};

async function handle(event) {
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { commissionId } = event || {};
  if (!commissionId) return fail('INVALID_PARAM', '缺少委托 ID');

  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  const config = await getConfig(db);

  if (c.mode === 'public') return confirmPublic(OPENID, c, event, config);

  // ---- 私人模式（原逻辑） ----
  if (c.status !== 'submitted') return fail('INVALID_STATUS', '当前状态不可确认');
  const isPublisher = c.publisherId === OPENID;
  const isAcceptor = c.acceptorId === OPENID;
  if (!isPublisher && !isAcceptor) return fail('FORBIDDEN', '只有委托双方才能确认');

  const flagField = isPublisher ? 'publisherConfirmed' : 'acceptorConfirmed';
  if (!c[flagField]) {
    await db.collection('commissions').doc(commissionId).update({
      data: { [flagField]: true, updatedAt: db.serverDate() }
    });
  }
  const cur = await db.collection('commissions').doc(commissionId).get();
  if (cur.data.publisherConfirmed && cur.data.acceptorConfirmed) {
    try {
      const r = await settleCommission(db, commissionId, config);
      return ok({ settled: true, ...r });
    } catch (e) {
      if (e.bizCode === 'INVALID_STATUS') return ok({ settled: false, reason: '对方已同步确认，正在结算' });
      console.error('[confirmCommission] 结算失败:', e);
      return fail('SETTLE_FAIL', '结算失败：' + String(e.message || '').slice(0, 100));
    }
  }
  return ok({ settled: false, waiting: isPublisher ? 'acceptor' : 'publisher' });
}

// ---- 公共模式：发布者确认合作者完成 ----
async function confirmPublic(OPENID, c, event, config) {
  if (c.publisherId !== OPENID) return fail('FORBIDDEN', '公共模式由发布者确认完成');
  if (c.status !== 'submitted') return fail('INVALID_STATUS', '当前状态不可确认');
  const { userId, all } = event || {};
  const acceptors = c.acceptors || [];

  if (all) {
    const updates = {};
    acceptors.forEach((a, i) => { updates[`acceptors.${i}.confirmedByPublisher`] = true; });
    await db.collection('commissions').doc(c._id).update({ data: updates });
  } else if (userId) {
    const idx = acceptors.findIndex((a) => a.userId === userId);
    if (idx < 0) return fail('NOT_FOUND', '合作者不存在');
    await db.collection('commissions').doc(c._id).update({
      data: { [`acceptors.${idx}.confirmedByPublisher`]: true }
    });
  } else {
    return fail('INVALID_PARAM', '缺少合作者');
  }

  // 全员确认 → 公共结算
  const fresh = await db.collection('commissions').doc(c._id).get();
  const allConfirmed = (fresh.data.acceptors || []).every((a) => a.confirmedByPublisher);
  if (allConfirmed) {
    try {
      const r = await settlePublicCommission(db, c._id, config);
      return ok({ settled: true, ...r });
    } catch (e) {
      if (e.bizCode === 'INVALID_STATUS') return ok({ settled: false, reason: '已同步结算中' });
      console.error('[confirmCommission] 公共结算失败:', e);
      return fail('SETTLE_FAIL', '结算失败：' + String(e.message || '').slice(0, 100));
    }
  }
  return ok({ settled: false });
}
