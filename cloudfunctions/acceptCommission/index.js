// acceptCommission —— 接单域：
//   私人模式（action=accept，默认）：直接接单，先到先得
//   公共模式：apply 申请 / approve 批准 / reject 拒绝 / withdraw 撤销申请 / commitAcceptors 开始合作
// ⚠️ 数组元素写（requests/acceptor 字段）用普通更新（点路径/_.push）；资金事务只写顶层原始值
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, fail, biz, getConfig, getEquippedEffect, requireUser, notifyUser } = require('./business');

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[acceptCommission] 未捕获异常:', e);
    return fail('INTERNAL', '系统异常，请稍后重试');
  }
};

async function handle(event) {
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { commissionId, action = 'accept' } = event || {};
  if (!commissionId) return fail('INVALID_PARAM', '缺少委托 ID');

  if (action === 'apply') return applyCommission(OPENID, event);
  if (action === 'approve') return approveRequest(OPENID, event);
  if (action === 'reject') return rejectRequest(OPENID, event);
  if (action === 'withdraw') return withdrawRequest(OPENID, event);
  if (action === 'commitAcceptors') return commitAcceptors(OPENID, event);
  if (action === 'updateSplit') return updateSplit(OPENID, event);

  return acceptPrivate(OPENID, event);
}

// ===== 私人模式直接接单（原逻辑，事务前预检 + 事务内复核） =====
async function acceptPrivate(OPENID, event) {
  const { commissionId } = event;
  const config = await getConfig(db);
  const acceptBonus = (await getEquippedEffect(db, OPENID, 'acceptBoost')) || 0;
  const acceptLimit = config.acceptLimit + acceptBonus;

  // 事务前预检（友好报错）
  const pre = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!pre || !pre.data) return fail('NOT_FOUND', '委托不存在');
  const pc = pre.data;
  if (pc.mode === 'public') return fail('NOT_PRIVATE', '该委托为公共模式，请先申请');
  if (pc.status !== 'pending') return fail('INVALID_STATUS', '该委托已被接下');
  if (pc.publisherId === OPENID) return fail('SELF_ACCEPT', '不能接自己发布的委托');
  if (pc.deadline && new Date(pc.deadline).getTime() < Date.now()) return fail('EXPIRED', '委托已截止');
  const activeCnt = await db.collection('orders')
    .where({ acceptorId: OPENID, status: 'active' }).count();
  if (activeCnt.total >= acceptLimit) {
    return fail('ACCEPT_LIMIT', `同时最多接 ${acceptLimit} 单，先完成手上的委托吧`);
  }
  const preU = await db.collection('users').doc(OPENID).get();
  if (preU.data.acceptBanUntil && new Date(preU.data.acceptBanUntil).getTime() > Date.now()) {
    return fail('BANNED', '接单权暂被封禁，请稍后再试');
  }

  let t = null;
  try {
    t = await db.startTransaction();
    const cur = await t.collection('commissions').doc(commissionId).get();
    if (cur.data.status !== 'pending') throw biz('INVALID_STATUS', '该委托已被接下');
    if (cur.data.publisherId === OPENID) throw biz('SELF_ACCEPT', '不能接自己发布的委托');
    await t.collection('commissions').doc(commissionId).update({
      data: {
        status: 'accepted',
        acceptorId: OPENID,
        acceptedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    const orderRes = await t.collection('orders').add({
      data: {
        orderNo: genNo(),
        commissionId,
        publisherId: cur.data.publisherId,
        acceptorId: OPENID,
        mode: 'private',
        currency: cur.data.currency,
        amount: cur.data.amount,
        fee: null,
        net: null,
        status: 'active',
        cancelBy: null,
        cancelReason: '',
        cancelAt: null,
        createdAt: db.serverDate(),
        settledAt: null
      }
    });
    await t.commit();
    // 事务外累计接单统计
    await db.collection('users').doc(OPENID).update({
      data: { 'stats.accepted': _.inc(1), updatedAt: db.serverDate() }
    });
    return ok({ orderId: orderRes._id });
  } catch (e) {
    if (t) { try { await t.rollback(); } catch (e2) { /* 忽略 */ } }
    if (e.bizCode) return fail(e.bizCode, e.message);
    console.error('[acceptCommission] 接单事务失败:', e);
    return fail('TRANSACTION_FAIL', '接单失败：' + String(e.message || '').slice(0, 100));
  }
}

// ===== 公共模式：申请接取 =====
async function applyCommission(OPENID, event) {
  const { commissionId, message } = event;
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  if (c.mode !== 'public') return fail('NOT_PUBLIC', '该委托不支持申请');
  if (c.status !== 'pending') return fail('INVALID_STATUS', '该委托已不在招募中');
  if (c.publisherId === OPENID) return fail('SELF_APPLY', '不能申请自己发布的委托');
  const requests = c.requests || [];
  if (requests.some((r) => r.userId === OPENID && r.status === 'pending')) {
    return fail('ALREADY_APPLIED', '已申请，等待发布者审核');
  }
  const config = await getConfig(db);
  if (requests.filter((r) => r.status === 'pending').length >= config.maxRequests) {
    return fail('REQUEST_LIMIT', '申请人数已达上限');
  }
  const u = await db.collection('users').doc(OPENID).get();
  // 读-改-写：整数组替换写入（规避 _.push 在部分环境下的兼容问题）
  const fresh = await db.collection('commissions').doc(commissionId).get();
  const curRequests = fresh.data.requests || [];
  const newRequests = curRequests.concat([{
    userId: OPENID,
    nickname: u.data.nickname || '江湖路人',
    avatarUrl: u.data.avatarUrl || '',
    message: String(message || '').slice(0, 100),
    at: Date.now(),
    status: 'pending'
  }]);
  await db.collection('commissions').doc(commissionId).update({
    data: { requests: newRequests, updatedAt: db.serverDate() }
  });
  // 回读验证写入结果，返回实际申请人数（申请人可当场核对同步）
  const verify = await db.collection('commissions').doc(commissionId).get();
  const pendingCount = (verify.data.requests || []).filter((r) => r.status === 'pending').length;
  await notifyUser(db, c.publisherId, 'apply', '新的申请',
    `${u.data.nickname || '江湖路人'} 申请合作「${c.title}」`, commissionId);
  return ok({ applied: true, requestCount: pendingCount });
}

// ===== 公共模式：批准申请（成为合作者） =====
async function approveRequest(OPENID, event) {
  const { commissionId, userId, split } = event;
  if (!userId) return fail('INVALID_PARAM', '缺少申请人');
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  if (c.publisherId !== OPENID) return fail('FORBIDDEN', '只有发布者可以批准');
  if (c.status !== 'pending') return fail('INVALID_STATUS', '当前不可批准');
  const requests = c.requests || [];
  const idx = requests.findIndex((r) => r.userId === userId && r.status === 'pending');
  if (idx < 0) return fail('NOT_FOUND', '申请不存在或已处理');
  const acceptors = c.acceptors || [];
  if (acceptors.length >= (c.maxAcceptors || 1)) {
    return fail('ACCEPTOR_LIMIT', `最多选定 ${c.maxAcceptors} 人`);
  }
  let sp = 0;
  if (c.splitMode === 'custom') {
    sp = Number(split);
    if (!Number.isInteger(sp) || sp < 1 || sp > 100) {
      return fail('INVALID_SPLIT', '分账比例需为 1-100 的整数');
    }
  }
  // 读-改-写整数组替换（规避 _.push / 点路径写入兼容问题）
  const fresh = await db.collection('commissions').doc(commissionId).get();
  const fc = fresh.data;
  const fIdx = (fc.requests || []).findIndex((r) => r.userId === userId && r.status === 'pending');
  if (fIdx < 0) return fail('NOT_FOUND', '申请不存在或已处理');
  const newRequests = (fc.requests || []).map((r, i) =>
    i === fIdx ? Object.assign({}, r, { status: 'approved' }) : r
  );
  const newAcceptors = (fc.acceptors || []).concat([{
    userId,
    nickname: (fc.requests[fIdx] && fc.requests[fIdx].nickname) || '江湖路人',
    avatarUrl: (fc.requests[fIdx] && fc.requests[fIdx].avatarUrl) || '',
    split: sp,
    proofText: '',
    proofImages: [],
    submittedAt: null,
    confirmedByPublisher: false,
    orderId: null,
    rated: false
  }]);
  await db.collection('commissions').doc(commissionId).update({
    data: { requests: newRequests, acceptors: newAcceptors, updatedAt: db.serverDate() }
  });
  await notifyUser(db, userId, 'approved', '申请通过',
    `你已被发布者选定合作「${c.title}」，待全部选定后开始合作`, commissionId);
  return ok({ approved: true });
}

// ===== 公共模式：拒绝申请 =====
async function rejectRequest(OPENID, event) {
  const { commissionId, userId } = event;
  if (!userId) return fail('INVALID_PARAM', '缺少申请人');
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  if (c.publisherId !== OPENID) return fail('FORBIDDEN', '只有发布者可以拒绝');
  if (c.status !== 'pending') return fail('INVALID_STATUS', '当前不可拒绝');
  const requests = c.requests || [];
  const idx = requests.findIndex((r) => r.userId === userId && r.status === 'pending');
  if (idx < 0) return fail('NOT_FOUND', '申请不存在或已处理');
  await db.collection('commissions').doc(commissionId).update({
    data: { [`requests.${idx}.status`]: 'rejected' }
  });
  await notifyUser(db, userId, 'rejected', '申请未通过', `「${c.title}」的发布者婉拒了你的申请`, commissionId);
  return ok({ rejected: true });
}

// ===== 公共模式：撤销自己的申请 =====
async function withdrawRequest(OPENID, event) {
  const { commissionId } = event;
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  if (c.status !== 'pending') return fail('INVALID_STATUS', '当前不可撤销');
  const requests = c.requests || [];
  const idx = requests.findIndex((r) => r.userId === OPENID && r.status === 'pending');
  if (idx < 0) return fail('NOT_FOUND', '未找到待审核的申请');
  await db.collection('commissions').doc(commissionId).update({
    data: { [`requests.${idx}.status`]: 'withdrawn' }
  });
  return ok({ withdrawn: true });
}

// ===== 公共模式：修改已选定合作者的分账比例（开始合作前，自定义比例模式） =====
async function updateSplit(OPENID, event) {
  const { commissionId, userId, split } = event;
  if (!commissionId || !userId) return fail('INVALID_PARAM', '缺少参数');
  const sp = Number(split);
  if (!Number.isInteger(sp) || sp < 1 || sp > 100) {
    return fail('INVALID_SPLIT', '比例需为 1-100 的整数（单位：%）');
  }
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  if (c.publisherId !== OPENID) return fail('FORBIDDEN', '只有发布者可以修改比例');
  // 结算前（pending/accepted/submitted）均可修改
  if (!['pending', 'accepted', 'submitted'].includes(c.status)) {
    return fail('INVALID_STATUS', '当前不可修改比例');
  }
  if (c.splitMode !== 'custom') return fail('NOT_CUSTOM', '该委托为均分模式，无需设置比例');
  const acceptors = c.acceptors || [];
  const idx = acceptors.findIndex((a) => a.userId === userId);
  if (idx < 0) return fail('NOT_FOUND', '合作者不存在');
  // 读-改-写整数组替换
  const newAcceptors = acceptors.map((a, i) =>
    i === idx ? Object.assign({}, a, { split: sp }) : a
  );
  const sum = newAcceptors.reduce((a, x) => a + (x.split || 0), 0);
  if (sum > 100) return fail('SPLIT_SUM', `比例总和已达 ${sum}%，超过 100%`);
  await db.collection('commissions').doc(commissionId).update({
    data: { acceptors: newAcceptors, updatedAt: db.serverDate() }
  });
  return ok({ split: sp, sum });
}

// ===== 公共模式：发布者确认合作名单，开始合作 =====
async function commitAcceptors(OPENID, event) {
  const { commissionId } = event;
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  if (c.publisherId !== OPENID) return fail('FORBIDDEN', '只有发布者可以开始合作');
  if (c.status !== 'pending') return fail('INVALID_STATUS', '当前不可开始合作');
  const acceptors = c.acceptors || [];
  if (acceptors.length < (c.minAcceptors || 1)) {
    return fail('NOT_ENOUGH', `至少选定 ${c.minAcceptors} 人才能开始合作`);
  }
  const n = acceptors.length;

  // 剩余待审核申请全部置为拒绝
  const newRequests = (c.requests || []).map((r) =>
    r.status === 'pending' ? Object.assign({}, r, { status: 'rejected' }) : r
  );
  await db.collection('commissions').doc(commissionId).update({
    data: {
      status: 'accepted',
      acceptedAt: db.serverDate(),
      requests: newRequests,
      updatedAt: db.serverDate()
    }
  });

  // 为每个合作者建订单（份额为信息展示，结算以 settle 分账为准）
  for (let i = 0; i < n; i++) {
    const ac = acceptors[i];
    const gross = c.splitMode === 'custom'
      ? Math.floor(c.amount * (ac.split || 0) / 100)
      : Math.floor(c.amount / n);
    const addRes = await db.collection('orders').add({
      data: {
        orderNo: genNo(),
        commissionId,
        publisherId: c.publisherId,
        acceptorId: ac.userId,
        mode: 'public',
        split: ac.split || 0,
        acceptorIndex: i,
        currency: c.currency,
        amount: gross,
        fee: null,
        net: null,
        status: 'active',
        cancelBy: null,
        cancelReason: '',
        cancelAt: null,
        createdAt: db.serverDate(),
        settledAt: null
      }
    });
    await db.collection('commissions').doc(commissionId).update({
      data: { [`acceptors.${i}.orderId`]: addRes._id }
    });
  }

  // 通知所有合作者
  for (const ac of acceptors) {
    await notifyUser(db, ac.userId, 'accepted', '合作开始',
      `你参与的「${c.title}」已开始合作（共 ${n} 人），请尽快完成并提交凭证`, commissionId);
  }
  return ok({ committed: true, acceptors: n });
}

function genNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `JH${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${Math.floor(1000 + Math.random() * 9000)}`;
}
