// submitCommission —— 提交完成凭证：
//   私人模式：accepted → submitted（提交即视为完成方已确认）
//   公共模式：合作者各自提交（acceptors[i] 字段），全员提交后 → submitted
// ⚠️ 数组元素写用普通更新（点路径），事务只写顶层原始值
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { ok, fail, biz, requireUser } = require('./business');

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[submitCommission] 未捕获异常:', e);
    return fail('INTERNAL', '系统异常，请稍后重试');
  }
};

async function handle(event) {
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { commissionId, proof } = event || {};
  if (!commissionId) return fail('INVALID_PARAM', '缺少委托 ID');
  const text = (proof && String(proof.text || '').trim()) || '';
  const images = (proof && Array.isArray(proof.images)) ? proof.images.slice(0, 9) : [];
  if (!text && !images.length) {
    return fail('INVALID_PROOF', '请填写完成说明或上传凭证图片');
  }

  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;

  if (c.mode === 'public') return submitPublic(OPENID, c, text, images);

  // ---- 私人模式 ----
  const t = await db.startTransaction();
  try {
    const cur = await t.collection('commissions').doc(commissionId).get();
    if (!cur.data) throw biz('NOT_FOUND', '委托不存在');
    if (cur.data.acceptorId !== OPENID) throw biz('FORBIDDEN', '只有接单者才能提交完成凭证');
    if (cur.data.status !== 'accepted') throw biz('INVALID_STATUS', '当前状态不可提交');
    // 事务 update 只写顶层原始值：proof 扁平为 proofText / proofImages
    await t.collection('commissions').doc(commissionId).update({
      data: {
        status: 'submitted',
        proofText: text,
        proofImages: images,
        acceptorConfirmed: true, // 提交即视为完成方确认
        submittedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 忽略 */ }
    if (e.bizCode) return fail(e.bizCode, e.message);
    console.error('[submitCommission] 事务失败:', e);
    return fail('TRANSACTION_FAIL', '提交失败：' + String(e.message || '').slice(0, 100));
  }
  return ok({ submitted: true });
}

// ---- 公共模式：合作者各自提交 ----
async function submitPublic(OPENID, c, text, images) {
  if (c.status !== 'accepted') return fail('INVALID_STATUS', '当前状态不可提交');
  const acceptors = c.acceptors || [];
  const idx = acceptors.findIndex((a) => a.userId === OPENID);
  if (idx < 0) return fail('FORBIDDEN', '你不是该委托的合作者');
  if (acceptors[idx].submittedAt) return fail('ALREADY_SUBMITTED', '你已提交过凭证');
  await db.collection('commissions').doc(c._id).update({
    data: {
      [`acceptors.${idx}.proofText`]: text,
      [`acceptors.${idx}.proofImages`]: images,
      [`acceptors.${idx}.submittedAt`]: db.serverDate()
    }
  });
  // 全员提交 → 进入待确认
  const fresh = await db.collection('commissions').doc(c._id).get();
  const allDone = (fresh.data.acceptors || []).every((a) => a.submittedAt);
  if (allDone) {
    await db.collection('commissions').doc(c._id).update({
      data: {
        status: 'submitted',
        submittedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  }
  return ok({ submitted: true, allDone });
}
