// cronSettle —— 定时任务（每 60 分钟触发）：
// 1. submitted 超 48h 未双确认 → 自动确认结算
// 2. pending 超过截止时间 → 过期全额退款
// 3. 清理已过期的置顶权重
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, getConfig, settleCommission, settlePublicCommission, notifyUser, publishCommission, biz } = require('./business');

exports.main = async () => {
  const config = await getConfig(db);
  const summary = {
    settled: 0, publicSettled: 0, expired: 0, boostCleared: 0,
    publishedScheduled: 0, draftPublished: 0, chainTriggered: 0, errors: []
  };

  // ---- 1. 超时自动结算 ----
  const autoAt = new Date(Date.now() - config.autoConfirmHours * 3600 * 1000);
  const subRes = await db.collection('commissions')
    .where({ status: 'submitted', submittedAt: _.lte(autoAt) }).limit(50).get();
  for (const c of subRes.data) {
    try {
      await settleCommission(db, c._id, config);
      summary.settled += 1;
    } catch (e) {
      if (e.bizCode === 'INVALID_STATUS') continue; // 已被并发处理
      summary.errors.push(`settle ${c._id}: ${e.message}`);
    }
  }

  // ---- 1.5 公共模式：提交超 48h 未全员确认 → 自动全员确认并结算 ----
  const subPub = await db.collection('commissions')
    .where({ status: 'submitted', mode: 'public', submittedAt: _.lte(autoAt) }).limit(20).get();
  for (const c of subPub.data) {
    try {
      const updates = {};
      (c.acceptors || []).forEach((a, i) => { updates[`acceptors.${i}.confirmedByPublisher`] = true; });
      await db.collection('commissions').doc(c._id).update({ data: updates });
      await settlePublicCommission(db, c._id, config);
      summary.publicSettled += 1;
    } catch (e) {
      if (e.bizCode === 'INVALID_STATUS') continue; // 已被并发处理
      summary.errors.push(`publicSettle ${c._id}: ${e.message}`);
    }
  }

  // ---- 1.6 公共模式：accepted 超截止时间 → 通知发布者（不动资金） ----
  const overduePub = await db.collection('commissions')
    .where({ status: 'accepted', mode: 'public', deadline: _.lt(new Date()) }).limit(20).get();
  for (const c of overduePub.data) {
    await notifyUser(db, c.publisherId, 'overdue', '合作超期',
      `「${c.title}」已过截止时间但仍有合作者未提交，可在委托详情选择取消退款或继续等待`, c._id);
  }

  // ---- 2. 过期退款 ----
  const expRes = await db.collection('commissions')
    .where({ status: 'pending', deadline: _.lt(new Date()) }).limit(50).get();
  for (const c of expRes.data) {
    try {
      await expireRefund(c);
      summary.expired += 1;
      // 公共模式：通知申请人
      if (c.mode === 'public') {
        const ids = (c.requests || []).filter((x) => x.status === 'pending').map((x) => x.userId);
        for (const id of [...new Set(ids)]) {
          await notifyUser(db, id, 'expired', '委托已截止',
            `你申请的「${c.title}」已截止，托管金额已退回发布者`, c._id);
        }
      }
    } catch (e) {
      summary.errors.push(`expire ${c._id}: ${e.message}`);
    }
  }

  // ---- 3. 清理过期置顶权重 ----
  const boostRes = await db.collection('commissions')
    .where({ boostUntil: _.lt(new Date()), sortScore: _.gte(1e12) }).limit(50).get();
  for (const c of boostRes.data) {
    try {
      await db.collection('commissions').doc(c._id).update({
        data: { sortScore: c.sortScore % 1e12, boostUntil: null, updatedAt: db.serverDate() }
      });
      summary.boostCleared += 1;
    } catch (e) {
      summary.errors.push(`boost ${c._id}: ${e.message}`);
    }
  }

  // ---- 3.5 定时发布：scheduled 到期 → 转为待接单 ----
  const duePub = await db.collection('commissions')
    .where({ status: 'scheduled', publishAt: _.lte(new Date()) }).limit(50).get();
  for (const c of duePub.data) {
    try {
      // 更新时间戳为发布时间，保证大厅列表按真实上架时间排序
      await db.collection('commissions').doc(c._id).update({
        data: {
          status: 'pending',
          publishAt: null,
          createdAt: new Date(c.publishAt),
          updatedAt: db.serverDate()
        }
      });
      summary.publishedScheduled += 1;
    } catch (e) {
      summary.errors.push(`publish ${c._id}: ${e.message}`);
    }
  }

  // ---- 3.7 草稿定时发布：scheduledAt 到期 → 执行发布（复用发布核心） ----
  const dueDrafts = await db.collection('drafts')
    .where({ status: 'scheduled', scheduledAt: _.lte(new Date()) }).limit(20).get();
  for (const d of dueDrafts.data) {
    try {
      const r = await publishCommission(db, d.ownerId, {
        title: d.title, description: d.description, categoryId: d.categoryId,
        subCategory: d.subCategory, region: d.region, amount: d.amount,
        currency: d.currency, deadline: d.deadline, images: d.images,
        mode: d.mode, minAcceptors: d.minAcceptors, maxAcceptors: d.maxAcceptors,
        splitMode: d.splitMode, chain: d.chain
      }, { draftId: d._id });
      if (r.ok) {
        await db.collection('drafts').doc(d._id).update({
          data: { status: 'published', commissionId: r.data.commissionId, updatedAt: db.serverDate() }
        });
        await notifyUser(db, d.ownerId, 'draft_published', '定时发布成功',
          `草稿「${d.title}」已按计划发布`, d._id);
        summary.draftPublished += 1;
      } else {
        await db.collection('drafts').doc(d._id).update({
          data: {
            status: 'failed',
            failReason: (r.error && r.error.message) || '发布失败',
            updatedAt: db.serverDate()
          }
        });
        await notifyUser(db, d.ownerId, 'publish_failed', '定时发布失败',
          `草稿「${d.title}」发布失败：${(r.error && r.error.message) || '未知原因'}（可到草稿箱重试）`, d._id);
      }
    } catch (e) {
      summary.errors.push(`draftPublish ${d._id}: ${e.message}`);
    }
  }

  // ---- 3.8 委托链触发：上一步已结算 → 触发链中下一步草稿 ----
  const chained = await db.collection('commissions')
    .where({ status: 'settled', 'chain.chainId': _.exists(true) }).limit(50).get();
  for (const c of chained.data) {
    const ch = c.chain || {};
    const nextRes = await db.collection('drafts')
      .where({ 'chain.chainId': ch.chainId, 'chain.seq': (ch.seq || 0) + 1, status: 'waiting' })
      .limit(1).get();
    if (!nextRes.data.length) continue;
    const d = nextRes.data[0];
    const step = `${d.chain.seq}/${d.chain.total}`;
    if (d.chain.trigger === 'auto') {
      try {
        const r = await publishCommission(db, d.ownerId, {
          title: d.title, description: d.description, categoryId: d.categoryId,
          subCategory: d.subCategory, region: d.region, amount: d.amount,
          currency: d.currency, deadline: d.deadline, images: d.images,
          mode: d.mode, minAcceptors: d.minAcceptors, maxAcceptors: d.maxAcceptors,
          splitMode: d.splitMode, chain: d.chain
        }, { draftId: d._id });
        if (r.ok) {
          await db.collection('drafts').doc(d._id).update({
            data: { status: 'published', commissionId: r.data.commissionId, updatedAt: db.serverDate() }
          });
          await notifyUser(db, d.ownerId, 'chain_auto', '委托链自动发布',
            `「${d.title}」（第 ${step} 步）已自动发布`, d._id);
        } else {
          await db.collection('drafts').doc(d._id).update({
            data: {
              status: 'skipped',
              failReason: (r.error && r.error.message) || '发布失败',
              updatedAt: db.serverDate()
            }
          });
          await notifyUser(db, d.ownerId, 'chain_skip', '委托链步骤跳过',
            `「${d.title}」（第 ${step} 步）自动发布失败：${(r.error && r.error.message) || '未知原因'}（可到草稿箱手动补发）`, d._id);
        }
      } catch (e) {
        summary.errors.push(`chainAuto ${d._id}: ${e.message}`);
      }
    } else if (d.chain.trigger === 'manual') {
      await db.collection('drafts').doc(d._id).update({
        data: { status: 'ready', updatedAt: db.serverDate() }
      });
      await notifyUser(db, d.ownerId, 'chain_confirm', '委托链下一步待确认',
        `「${d.title}」（第 ${step} 步）已就绪，请到草稿箱确认发布`, d._id);
      summary.chainTriggered += 1;
    }
    // trigger === 'pause'（停留）：不自动触发也不置待确认，保持 waiting，
    // 由发布者随时到草稿箱手动发布
  }

  // ---- 3.9 清理超保留期的历史链记录 ----
  try {
    const chainCutoff = new Date(Date.now() - (config.chainHistoryRetentionDays || 30) * 24 * 3600 * 1000);
    const removed = await db.collection('chain_history')
      .where({ disbandedAt: _.lt(chainCutoff) })
      .remove();
    summary.cleanedChainHistory = (removed && removed.stats && removed.stats.removed) || 0;
  } catch (e) {
    summary.errors.push(`chainHistory cleanup: ${e.message}`);
  }

  // ---- 4. 清理超过保留期的已结束委托（资金流水/订单永久保留） ----
  try {
    const retentionDays = config.closedRetentionDays || 30;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
    const removeRes = await db.collection('commissions')
      .where({
        status: _.in(['cancelled', 'expired', 'settled']),
        updatedAt: _.lt(cutoff)
      })
      .remove();
    summary.cleanedCommissions =
      (removeRes && removeRes.stats && removeRes.stats.removed) || 0;
  } catch (e) {
    summary.errors.push(`cleanup: ${e.message}`);
  }

  return ok(summary);
};

// 过期退款：pending 且 deadline 已过 → expired + 全额退回发布者
async function expireRefund(c) {
  const field = c.currency === 'gold' ? 'gold' : 'silver';
  // 事务 update 只写顶层原始值（嵌套对象会 PathNotViable）
  const t = await db.startTransaction();
  try {
    const cur = await t.collection('commissions').doc(c._id).get();
    if (cur.data.status !== 'pending') throw biz('INVALID_STATUS', '状态已变化');
    const pub = await t.collection('users').doc(c.publisherId).get();
    const balanceAfter = (pub.data[field] || 0) + c.amount;
    await t.collection('commissions').doc(c._id).update({
      data: {
        status: 'expired',
        cancelBy: 'system',
        cancelReason: '超过截止时间无人接单',
        cancelAt: Date.now(),
        updatedAt: db.serverDate()
      }
    });
    // 写计算后的绝对值，不用 inc 指令
    await t.collection('users').doc(c.publisherId).update({
      data: { [field]: balanceAfter, updatedAt: db.serverDate() }
    });
    await t.collection('transactions').add({
      data: {
        userId: c.publisherId, type: 'refund', currency: c.currency,
        amount: c.amount, balanceAfter, relatedId: c._id,
        remark: `委托「${c.title}」过期退款`, createdAt: db.serverDate()
      }
    });
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
    throw e;
  }
}
