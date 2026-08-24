// commissionCreate —— 发布委托（薄壳）：身份校验后调用共享发布核心 publishCommission
// 草稿发布（draft.publish）与委托链自动发布复用同一核心，保证托管扣款/星级/上限规则一致
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { ok, fail, requireUser, publishCommission } = require('./business');

exports.main = async (event) => {
  try {
    const auth = await requireUser(db, { needAccount: true });
    if (!auth.ok) return fail(auth.error.code, auth.error.message);
    return await publishCommission(db, auth.realId, event || {});
  } catch (e) {
    console.error('[commissionCreate] 未捕获异常:', e);
    return fail('INTERNAL', '系统异常，请稍后重试');
  }
};
