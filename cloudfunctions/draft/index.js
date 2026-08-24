// draft —— 委托草稿：
//   save 新建/编辑草稿（可选定时发布 scheduledAt）；chainSet 设为多节点链的某一步
//   publish 立即/手动发布（复用 publishCommission 共享核心）；list/delete
// 草稿状态：draft 草稿 / scheduled 定时中 / waiting 链中等待上一步 / ready 链中待发布者确认
//           published 已发布 / skipped 自动发布跳过 / failed 发布失败 / cancelled 已作废
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, fail, biz, getConfig, requireUser, publishCommission, notifyUser } = require('./business');

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[draft] 未捕获异常:', e);
    return fail('INTERNAL', '系统异常，请稍后重试');
  }
};

async function handle(event) {
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { action } = event || {};
  if (action === 'save') return save(OPENID, event);
  if (action === 'list') return list(OPENID, event);
  if (action === 'delete') return remove(OPENID, event);
  if (action === 'publish') return publish(OPENID, event);
  if (action === 'chainSet') return chainSet(OPENID, event);
  if (action === 'chainUpdate') return chainUpdate(OPENID, event);
  if (action === 'chainSwap') return chainSwap(OPENID, event);
  if (action === 'chainUpdateTotal') return chainUpdateTotal(OPENID, event);
  if (action === 'chainDisband') return chainDisband(OPENID, event);
  if (action === 'chainHistory') return chainHistory(OPENID, event);
  if (action === 'chainRestore') return chainRestore(OPENID, event);
  return fail('INVALID_ACTION', '未知操作');
}

// ===== 链管理：两步草稿交换序号（重排） =====
async function chainSwap(OPENID, event) {
  const { draftId, withSeq } = event || {};
  if (!draftId) return fail('INVALID_PARAM', '缺少草稿 ID');
  const dRes = await db.collection('drafts').doc(draftId).get().catch(() => null);
  if (!dRes || !dRes.data) return fail('NOT_FOUND', '草稿不存在');
  const d = dRes.data;
  if (d.ownerId !== OPENID) return fail('FORBIDDEN', '只能操作自己的草稿');
  if (!d.chain || !d.chain.chainId) return fail('NOT_IN_CHAIN', '该草稿不在委托链中');
  if (d.status === 'published') return fail('INVALID_STATUS', '已发布的步骤不可交换');
  const otherSeq = Number(withSeq);
  if (!Number.isInteger(otherSeq) || otherSeq < 1) return fail('INVALID_SEQ', '目标序号不合法');
  if (otherSeq === d.chain.seq) return fail('SAME_SEQ', '与当前序号相同');
  const otherRes = await db.collection('drafts')
    .where({
      ownerId: OPENID,
      'chain.chainId': d.chain.chainId,
      'chain.seq': otherSeq,
      status: _.neq('cancelled')
    }).limit(1).get();
  if (!otherRes.data.length) {
    return fail('NOT_FOUND', `第 ${otherSeq} 步没有可交换的草稿（可能已发布或不存在）`);
  }
  const other = otherRes.data[0];
  if (other.status === 'published') return fail('INVALID_STATUS', '已发布的步骤不可交换');
  // 交换双方序号（点路径写入，chain 已存在为对象）
  await db.collection('drafts').doc(d._id).update({
    data: { 'chain.seq': otherSeq, updatedAt: db.serverDate() }
  });
  await db.collection('drafts').doc(other._id).update({
    data: { 'chain.seq': d.chain.seq, updatedAt: db.serverDate() }
  });
  return ok({ swapped: true });
}

// 确保 chain_history 集合存在（幂等；新集合可能在 initData 之前使用）
async function ensureChainHistory() {
  try {
    await db.createCollection('chain_history');
  } catch (e) {
    // 已存在则忽略
  }
}

// ===== 链管理：历史链列表（解散记录，保留期内可恢复） =====
async function chainHistory(OPENID) {
  await ensureChainHistory();
  const res = await db.collection('chain_history')
    .where({ ownerId: OPENID, restored: false })
    .orderBy('disbandedAt', 'desc').limit(50).get();
  return ok({ list: res.data });
}

// ===== 链管理：恢复解散的链（保留期内） =====
async function chainRestore(OPENID, event) {
  await ensureChainHistory();
  const { chainId } = event || {};
  if (!chainId) return fail('INVALID_PARAM', '缺少链编号');
  const config = await getConfig(db);
  const hRes = await db.collection('chain_history').doc(String(chainId)).get().catch(() => null);
  if (!hRes || !hRes.data) return fail('NOT_FOUND', '历史链不存在');
  const h = hRes.data;
  if (h.ownerId !== OPENID) return fail('FORBIDDEN', '只能恢复自己的链');
  if (h.restored) return fail('ALREADY_RESTORED', '该链已恢复');
  const t = new Date(h.disbandedAt).getTime();
  if (Date.now() - t > config.chainHistoryRetentionDays * 24 * 3600 * 1000) {
    return fail('EXPIRED', `超过 ${config.chainHistoryRetentionDays} 天保留期，无法恢复`);
  }
  let restored = 0;
  const skipped = [];
  for (const s of h.steps || []) {
    const dRes = await db.collection('drafts').doc(s.draftId).get().catch(() => null);
    if (!dRes || !dRes.data) { skipped.push(`${s.title}（草稿已删除）`); continue; }
    const d = dRes.data;
    if (d.status === 'cancelled') { skipped.push(`${s.title}（已作废）`); continue; }
    if (d.chain && d.chain.chainId) { skipped.push(`${s.title}（已加入其他链）`); continue; }
    await db.collection('drafts').doc(s.draftId).update({
      data: {
        chain: _.set({ chainId: s.chainId, seq: s.seq, total: s.total, trigger: s.trigger }),
        status: d.scheduledAt ? 'scheduled' : (s.seq > 1 ? 'waiting' : 'draft'),
        updatedAt: db.serverDate()
      }
    });
    restored += 1;
  }
  await db.collection('chain_history').doc(String(chainId)).update({
    data: { restored: true, restoredAt: db.serverDate() }
  });
  return ok({ restored, skipped });
}

// ===== 链管理：修改某一步（序号重排 / 触发方式 / 定时时间 / 移出链） =====
async function chainUpdate(OPENID, event) {
  const { draftId, patch } = event || {};
  if (!draftId || !patch) return fail('INVALID_PARAM', '缺少参数');
  const dRes = await db.collection('drafts').doc(draftId).get().catch(() => null);
  if (!dRes || !dRes.data) return fail('NOT_FOUND', '草稿不存在');
  const d = dRes.data;
  if (d.ownerId !== OPENID) return fail('FORBIDDEN', '只能操作自己的草稿');
  if (!d.chain || !d.chain.chainId) return fail('NOT_IN_CHAIN', '该草稿不在委托链中');
  if (d.status === 'published') return fail('INVALID_STATUS', '已发布的步骤不可修改');

  const data = { updatedAt: db.serverDate() };

  // 移出链
  if (patch.clearChain) {
    data.chain = _.set(null);
    data.status = d.scheduledAt ? 'scheduled' : 'draft';
    await db.collection('drafts').doc(draftId).update({ data });
    return ok({ done: true });
  }

  // 序号重排：同链内草稿序号不可重复（已发布的委托序号同样占用）
  if (patch.seq !== undefined) {
    const seq = Number(patch.seq);
    if (!Number.isInteger(seq) || seq < 1 || seq > (patch.total || d.chain.total || 100)) {
      return fail('INVALID_SEQ', '序号需在 1 到总步数之间');
    }
    const dupDraft = await db.collection('drafts')
      .where({
        ownerId: OPENID,
        'chain.chainId': d.chain.chainId,
        'chain.seq': seq,
        status: _.neq('cancelled'),
        _id: _.neq(draftId)
      }).count();
    if (dupDraft.total > 0) return fail('SEQ_TAKEN', `第 ${seq} 步已被其他草稿占用`);
    const dupComm = await db.collection('commissions')
      .where({ publisherId: OPENID, 'chain.chainId': d.chain.chainId, 'chain.seq': seq })
      .count();
    if (dupComm.total > 0) return fail('SEQ_TAKEN', `第 ${seq} 步已被已发布的委托占用`);
    data['chain.seq'] = seq;
    if (patch.total) data['chain.total'] = Number(patch.total);
  }

  // 触发方式
  if (patch.trigger && ['auto', 'manual', 'pause'].includes(patch.trigger)) {
    data['chain.trigger'] = patch.trigger;
  }

  // 定时发布时间（留空 = 取消定时）
  if (patch.scheduledAt !== undefined) {
    if (patch.scheduledAt === null || patch.scheduledAt === '') {
      data.scheduledAt = _.set(null);
      if (d.status === 'scheduled') data.status = 'draft';
    } else {
      const t = new Date(patch.scheduledAt);
      if (isNaN(t.getTime())) return fail('INVALID_SCHEDULE', '定时时间不合法');
      if (t.getTime() <= Date.now()) return fail('INVALID_SCHEDULE', '定时时间需晚于当前');
      data.scheduledAt = t;
      data.status = 'scheduled';
    }
  }

  await db.collection('drafts').doc(draftId).update({ data });
  return ok({ done: true });
}

// ===== 链管理：修改整条链的总步数（同步到链内所有未发布草稿） =====
async function chainUpdateTotal(OPENID, event) {
  const { chainId, total } = event || {};
  if (!chainId) return fail('INVALID_PARAM', '缺少链编号');
  const t = Number(total);
  if (!Number.isInteger(t) || t < 1 || t > 100) return fail('INVALID_TOTAL', '总步数需为 1-100 的整数');
  const chainRes = await db.collection('drafts')
    .where({ ownerId: OPENID, 'chain.chainId': String(chainId), status: _.neq('cancelled') })
    .limit(100).get();
  if (!chainRes.data.length) return fail('NOT_FOUND', '链不存在或已无草稿');
  // 校验：已有草稿的序号不能超过新总步数
  const over = chainRes.data.find((x) => x.chain && x.chain.seq > t);
  if (over) return fail('INVALID_TOTAL', `第 ${over.chain.seq} 步序号超过新总步数，请先重排`);
  for (const x of chainRes.data) {
    if (x.status === 'published') continue; // 已发布委托的 chain 快照不随改
    await db.collection('drafts').doc(x._id).update({
      data: { 'chain.total': t, updatedAt: db.serverDate() }
    });
  }
  return ok({ total: t, updated: chainRes.data.length });
}

// ===== 链管理：解散整条链（含已作废草稿一并清理；记录历史链，保留期内可恢复） =====
async function chainDisband(OPENID, event) {
  await ensureChainHistory();
  const { chainId } = event || {};
  if (!chainId) return fail('INVALID_PARAM', '缺少链编号');
  // 不按状态过滤：已作废的草稿也要一并清理出链
  const chainRes = await db.collection('drafts')
    .where({ ownerId: OPENID, 'chain.chainId': String(chainId) })
    .limit(100).get();
  if (!chainRes.data.length) return fail('NOT_FOUND', '链不存在或已无草稿');
  // 写入历史链（快照，供保留期内恢复）
  await db.collection('chain_history').doc(String(chainId)).set({
    data: {
      ownerId: OPENID,
      chainId: String(chainId),
      total: chainRes.data[0].chain ? chainRes.data[0].chain.total : 0,
      steps: chainRes.data.map((x) => ({
        draftId: x._id,
        title: x.title,
        chainId: String(chainId),
        seq: (x.chain && x.chain.seq) || 0,
        total: (x.chain && x.chain.total) || 0,
        trigger: (x.chain && x.chain.trigger) || 'auto'
      })),
      restored: false,
      disbandedAt: db.serverDate()
    }
  });
  let n = 0;
  for (const x of chainRes.data) {
    if (x.status === 'published') continue;
    await db.collection('drafts').doc(x._id).update({
      data: {
        chain: _.set(null),
        status: x.scheduledAt ? 'scheduled' : 'draft',
        updatedAt: db.serverDate()
      }
    });
    n += 1;
  }
  return ok({ disbanded: n });
}

// ===== 新建/编辑草稿 =====
async function save(OPENID, event) {
  const {
    draftId, title, description, categoryId, subCategory, region, amount, currency,
    deadline, images, mode, minAcceptors, maxAcceptors, splitMode, scheduledAt, chain
  } = event || {};

  // 轻校验（发布时 publishCommission 会做完整校验）
  if (!title || title.trim().length < 2 || title.trim().length > 30) {
    return fail('INVALID_TITLE', '标题需 2-30 字');
  }
  if (description && description.length > 1000) return fail('INVALID_DESC', '描述最多 1000 字');
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) return fail('INVALID_AMOUNT', '金额须为正整数');

  // 定时发布时间校验（可选）
  let sched = null;
  if (scheduledAt) {
    sched = new Date(scheduledAt);
    if (isNaN(sched.getTime())) return fail('INVALID_SCHEDULE', '定时发布时间不合法');
    if (sched.getTime() <= Date.now()) return fail('INVALID_SCHEDULE', '定时发布时间需晚于当前时间');
  }

  const data = {
    ownerId: OPENID,
    title: title.trim(),
    description: description || '',
    categoryId: categoryId || '',
    subCategory: subCategory || '',
    region: region || {},
    images: Array.isArray(images) ? images.slice(0, 9) : [],
    amount: amt,
    currency: currency === 'gold' ? 'gold' : 'silver',
    deadline: deadline || null,
    mode: mode === 'public' ? 'public' : 'private',
    minAcceptors: mode === 'public' ? Number(minAcceptors) || 1 : null,
    maxAcceptors: mode === 'public' ? Number(maxAcceptors) || 1 : null,
    splitMode: mode === 'public' ? (splitMode || 'equal') : null,
    scheduledAt: sched,
    chain: chain || null,
    status: sched ? 'scheduled' : (chain && chain.seq > 1 ? 'waiting' : 'draft'),
    commissionId: null,
    failReason: '',
    updatedAt: db.serverDate()
  };

  if (draftId) {
    const old = await db.collection('drafts').doc(draftId).get().catch(() => null);
    if (!old || !old.data) return fail('NOT_FOUND', '草稿不存在');
    if (old.data.ownerId !== OPENID) return fail('FORBIDDEN', '只能编辑自己的草稿');
    if (!['draft', 'scheduled', 'failed'].includes(old.data.status)) {
      return fail('INVALID_STATUS', '该草稿当前状态不可编辑');
    }
    // 嵌套对象/数组字段用 _.set 显式写入（普通嵌套写入会触发 PathNotViable）
    await db.collection('drafts').doc(draftId).update({
      data: Object.assign({}, data, {
        region: _.set(data.region || {}),
        images: _.set(data.images || []),
        chain: _.set(data.chain || null)
      })
    });
    return ok({ draftId });
  }
  const addRes = await db.collection('drafts').add({ data: Object.assign({}, data, { createdAt: db.serverDate() }) });
  return ok({ draftId: addRes._id });
}

// ===== 我的草稿列表 =====
async function list(OPENID) {
  const res = await db.collection('drafts')
    .where({ ownerId: OPENID })
    .orderBy('createdAt', 'desc').limit(100).get();
  return ok({ list: res.data });
}

// ===== 删除草稿 =====
async function remove(OPENID, event) {
  const { draftId } = event || {};
  if (!draftId) return fail('INVALID_PARAM', '缺少草稿 ID');
  const old = await db.collection('drafts').doc(draftId).get().catch(() => null);
  if (!old || !old.data) return fail('NOT_FOUND', '草稿不存在');
  if (old.data.ownerId !== OPENID) return fail('FORBIDDEN', '只能删除自己的草稿');
  await db.collection('drafts').doc(draftId).update({
    data: { status: 'cancelled', updatedAt: db.serverDate() }
  });
  return ok({ deleted: true });
}

// ===== 立即发布草稿（也用于链的 manual 触发） =====
async function publish(OPENID, event) {
  const { draftId } = event || {};
  if (!draftId) return fail('INVALID_PARAM', '缺少草稿 ID');
  const dRes = await db.collection('drafts').doc(draftId).get().catch(() => null);
  if (!dRes || !dRes.data) return fail('NOT_FOUND', '草稿不存在');
  const d = dRes.data;
  if (d.ownerId !== OPENID) return fail('FORBIDDEN', '只能发布自己的草稿');
  if (!['draft', 'ready', 'failed', 'skipped', 'waiting'].includes(d.status)) {
    return fail('INVALID_STATUS', '该草稿当前状态不可发布');
  }
  // 复用发布核心：托管扣款/星级/上限/校验全部一致
  const r = await publishCommission(db, OPENID, {
    title: d.title, description: d.description, categoryId: d.categoryId,
    subCategory: d.subCategory, region: d.region, amount: d.amount,
    currency: d.currency, deadline: d.deadline, images: d.images,
    mode: d.mode, minAcceptors: d.minAcceptors, maxAcceptors: d.maxAcceptors,
    splitMode: d.splitMode, chain: d.chain
  }, { draftId });
  if (!r.ok) {
    await db.collection('drafts').doc(draftId).update({
      data: {
        status: 'failed',
        failReason: (r.error && r.error.message) || '发布失败',
        updatedAt: db.serverDate()
      }
    });
    return r;
  }
  await db.collection('drafts').doc(draftId).update({
    data: {
      status: 'published',
      commissionId: r.data.commissionId,
      updatedAt: db.serverDate()
    }
  });
  return ok({ draftId, commissionId: r.data.commissionId, star: r.data.star });
}

// ===== 设置为委托链节点 =====
// chain: { chainId?, seq, total, trigger }；seq=1 无 chainId 时自动生成新链编号
async function chainSet(OPENID, event) {
  const { draftId, chain } = event || {};
  if (!draftId || !chain) return fail('INVALID_PARAM', '缺少参数');
  const seq = Number(chain.seq);
  const total = Number(chain.total);
  if (!Number.isInteger(seq) || !Number.isInteger(total) || seq < 1 || total < 1 || total > 100) {
    return fail('INVALID_CHAIN', '序号与总步数需为 1-100 的整数');
  }
  if (seq > total) return fail('INVALID_CHAIN', '序号不能大于总步数');
  // 触发方式：auto 跟随自动发布 / manual 需确认 / pause 停留（不自动触发，手动发布）
  if (!['auto', 'manual', 'pause'].includes(chain.trigger)) return fail('INVALID_CHAIN', '触发方式不合法');
  const dRes = await db.collection('drafts').doc(draftId).get().catch(() => null);
  if (!dRes || !dRes.data) return fail('NOT_FOUND', '草稿不存在');
  const d = dRes.data;
  if (d.ownerId !== OPENID) return fail('FORBIDDEN', '只能操作自己的草稿');

  let chainId = String(chain.chainId || '').trim();
  if (seq === 1 && !chainId) {
    chainId = 'CH' + Date.now() + Math.floor(1000 + Math.random() * 9000);
  }
  if (!chainId) return fail('INVALID_CHAIN', '加入已有链需填写链编号');

  // 嵌套对象用 _.set 显式写入（chain 初始为 null，普通嵌套写入会 PathNotViable）
  await db.collection('drafts').doc(draftId).update({
    data: {
      chain: _.set({ chainId, seq, total, trigger: chain.trigger }),
      status: seq === 1 ? (d.status === 'scheduled' ? 'scheduled' : 'draft') : 'waiting',
      updatedAt: db.serverDate()
    }
  });
  return ok({ chainId });
}
