// review —— 评价体系：结算后发布者可对完成者评价（可选）
// actions: submit 提交 / edit 修改（限 1 次）/ listMine 我收到的 / appeal 申诉
// 评价写入后重算被评者三值 + 检查三值称号
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const {
  ok, fail, biz, getConfig, requireUser, applyThreeValues, notifyUser
} = require('./business');

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[review] 未捕获异常:', e);
    return fail('INTERNAL', '系统异常，请稍后重试');
  }
};

async function handle(event) {
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { action } = event || {};
  if (action === 'submit') return submit(OPENID, event);
  if (action === 'edit') return edit(OPENID, event);
  if (action === 'listMine') return listMine(OPENID, event);
  if (action === 'appeal') return appeal(OPENID, event);
  if (action === 'getByCommission') return getByCommission(OPENID, event);
  return fail('INVALID_ACTION', '未知操作');
}

// ===== 查询我对某委托某完成者的既有评价（评价页预填/修改用） =====
async function getByCommission(OPENID, event) {
  const { commissionId, revieweeId } = event || {};
  if (!commissionId || !revieweeId) return fail('INVALID_PARAM', '缺少参数');
  const q = await db.collection('reviews')
    .where({ commissionId, reviewerId: OPENID, revieweeId })
    .orderBy('createdAt', 'desc').limit(1).get();
  return ok({ review: q.data[0] || null });
}

// ===== 提交评价（仅结算后、仅发布者评完成者、每人每单一条） =====
async function submit(OPENID, event) {
  const { commissionId, revieweeId, star, dims, comment } = event || {};
  if (!commissionId || !revieweeId) return fail('INVALID_PARAM', '缺少参数');
  const st = Number(star);
  if (!Number.isInteger(st) || st < 1 || st > 5) return fail('INVALID_STAR', '评分需为 1-5 星');
  const text = String(comment || '').slice(0, 300);
  const dm = {};
  if (dims) {
    ['onTime', 'quality', 'attitude'].forEach((k) => {
      const v = Number(dims[k]);
      if (Number.isInteger(v) && v >= 1 && v <= 5) dm[k] = v;
    });
  }

  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  if (c.publisherId !== OPENID) return fail('FORBIDDEN', '只有发布者可以评价');
  if (c.status !== 'settled') return fail('INVALID_STATUS', '结算完成后才能评价');

  // 被评者校验
  const acceptors = c.acceptors || [];
  const isAcceptor = acceptors.some((a) => a.userId === revieweeId);
  if (!isAcceptor && c.acceptorId !== revieweeId) return fail('INVALID_TARGET', '被评者不是该委托的完成者');

  // 每人每单一条
  const dup = await db.collection('reviews')
    .where({ commissionId, reviewerId: OPENID, revieweeId }).count();
  if (dup.total > 0) return fail('ALREADY_REVIEWED', '你已评价过该完成者');

  await db.collection('reviews').add({
    data: {
      commissionId,
      reviewerId: OPENID,
      revieweeId,
      star: st,
      dims: dm,
      comment: text,
      editCount: 0,
      appeal: null,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  // 标记已评（公共模式 acceptors[i].rated；私人模式 ratedByPublisher）
  const idx = acceptors.findIndex((a) => a.userId === revieweeId);
  if (idx >= 0) {
    await db.collection('commissions').doc(commissionId).update({
      data: { [`acceptors.${idx}.rated`]: true }
    }).catch(() => {});
  } else if (c.acceptorId === revieweeId) {
    await db.collection('commissions').doc(commissionId).update({
      data: { ratedByPublisher: true }
    }).catch(() => {});
  }
  // 重算三值 + 称号
  await applyThreeValues(db, revieweeId);
  return ok({ submitted: true });
}

// ===== 修改评价（限 reviewEditLimit 次） =====
async function edit(OPENID, event) {
  const { reviewId, star, dims, comment } = event || {};
  if (!reviewId) return fail('INVALID_PARAM', '缺少评价 ID');
  const config = await getConfig(db);
  const rRes = await db.collection('reviews').doc(reviewId).get().catch(() => null);
  if (!rRes || !rRes.data) return fail('NOT_FOUND', '评价不存在');
  const r = rRes.data;
  if (r.reviewerId !== OPENID) return fail('FORBIDDEN', '只能修改自己的评价');
  if ((r.editCount || 0) >= config.reviewEditLimit) {
    return fail('EDIT_LIMIT', `评价最多修改 ${config.reviewEditLimit} 次`);
  }
  const data = { editCount: _.inc(1), updatedAt: db.serverDate() };
  if (Number.isInteger(Number(star)) && Number(star) >= 1 && Number(star) <= 5) data.star = Number(star);
  if (comment !== undefined) data.comment = String(comment).slice(0, 300);
  // 维度也允许修改
  if (dims) {
    const dm = {};
    ['onTime', 'quality', 'attitude'].forEach((k) => {
      const v = Number(dims[k]);
      if (Number.isInteger(v) && v >= 1 && v <= 5) dm[k] = v;
    });
    data.dims = dm;
  }
  await db.collection('reviews').doc(reviewId).update({ data });
  await applyThreeValues(db, r.revieweeId);
  return ok({ edited: true });
}

// ===== 我收到的评价列表 + 聚合 =====
async function listMine(OPENID, event) {
  const { page = 1, pageSize = 20 } = event || {};
  const size = Math.min(Number(pageSize) || 20, 50);
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;
  const [listRes, totalRes] = await Promise.all([
    db.collection('reviews').where({ revieweeId: OPENID })
      .orderBy('createdAt', 'desc').skip(skip).limit(size).get(),
    db.collection('reviews').where({ revieweeId: OPENID }).count()
  ]);
  // 补评价者昵称
  const ids = [...new Set(listRes.data.map((r) => r.reviewerId))];
  const usersMap = {};
  if (ids.length) {
    const uRes = await db.collection('users').where({ _id: _.in(ids) }).get();
    uRes.data.forEach((u) => { usersMap[u._id] = u; });
  }
  const list = listRes.data.map((r) => Object.assign({}, r, {
    reviewerName: (usersMap[r.reviewerId] && usersMap[r.reviewerId].nickname) || '江湖路人'
  }));
  return ok({ list, total: totalRes.total, hasMore: skip + list.length < totalRes.total });
}

// ===== 申诉（被评者，评价后 appealWindowDays 天内） =====
async function appeal(OPENID, event) {
  const { reviewId, reason } = event || {};
  if (!reviewId) return fail('INVALID_PARAM', '缺少评价 ID');
  const text = String(reason || '').trim();
  if (!text) return fail('INVALID_PARAM', '请填写申诉理由');
  const config = await getConfig(db);
  const rRes = await db.collection('reviews').doc(reviewId).get().catch(() => null);
  if (!rRes || !rRes.data) return fail('NOT_FOUND', '评价不存在');
  const r = rRes.data;
  if (r.revieweeId !== OPENID) return fail('FORBIDDEN', '只能申诉对自己的评价');
  if (r.appeal && r.appeal.status === 'open') return fail('ALREADY_APPEALED', '申诉处理中');
  const created = new Date(r.createdAt).getTime();
  if (Date.now() - created > config.appealWindowDays * 24 * 3600 * 1000) {
    return fail('APPEAL_EXPIRED', `评价超过 ${config.appealWindowDays} 天，无法申诉`);
  }
  await db.collection('reviews').doc(reviewId).update({
    data: {
      appeal: { status: 'open', reason: text.slice(0, 300), at: Date.now(), handledBy: null },
      updatedAt: db.serverDate()
    }
  });
  return ok({ appealed: true });
}
