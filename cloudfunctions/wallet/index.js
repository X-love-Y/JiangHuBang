// wallet —— 钱包：充值（模拟+预留真实微信支付）/ 兑换（1:100 双向不扣税）/ 流水
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, fail, biz, getConfig, requireUser } = require('./business');

exports.main = async (event) => {
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { action } = event || {};
  if (action === 'recharge') return recharge(OPENID, event);
  if (action === 'scanRecharge') return scanRecharge(OPENID, event);
  if (action === 'exchange') return exchange(OPENID, event);
  if (action === 'transactions') return listTransactions(OPENID, event);
  return fail('INVALID_ACTION', '未知操作');
};

// ===== 扫码充值（模拟）：orderNo 幂等，同一订单只入账一次 =====
async function scanRecharge(OPENID, event) {
  const { plan, orderNo } = event || {};
  const rmb = Number(plan);
  const silver = (await getConfig(db)).rechargePlans[String(rmb)];
  if (!silver) return fail('INVALID_PLAN', '充值金额不在可选档位内');
  if (!orderNo || String(orderNo).length < 8) return fail('INVALID_ORDER', '缺少订单号');
  const orderId = String(orderNo);

  // 幂等：订单已存在且已支付 → 直接返回
  const exist = await db.collection('pay_orders').doc(orderId).get().catch(() => null);
  if (exist && exist.data) {
    if (exist.data.status === 'paid') return fail('ALREADY_PAID', '该订单已支付，请勿重复提交');
    return fail('ORDER_PENDING', '该订单处理中');
  }
  try {
    await db.collection('pay_orders').doc(orderId).set({
      data: {
        userId: OPENID, plan: rmb, silver,
        channel: 'scan', status: 'pending',
        createdAt: db.serverDate(), paidAt: null
      }
    });
  } catch (e) {
    return fail('ORDER_EXISTS', '订单已存在，请勿重复提交');
  }

  let balanceAfter = 0;
  const t = await db.startTransaction();
  try {
    const u = await t.collection('users').doc(OPENID).get();
    balanceAfter = (u.data.silver || 0) + silver;
    await t.collection('users').doc(OPENID).update({
      data: { silver: balanceAfter, updatedAt: db.serverDate() }
    });
    await t.collection('transactions').add({
      data: {
        userId: OPENID, type: 'recharge', currency: 'silver',
        amount: silver, balanceAfter, relatedId: orderId,
        remark: `扫码充值 ¥${rmb}（模拟通道）`, createdAt: db.serverDate()
      }
    });
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 忽略 */ }
    console.error('[wallet] 扫码充值事务失败:', e);
    return fail('TRANSACTION_FAIL', '充值失败，请重试');
  }
  await db.collection('pay_orders').doc(orderId).update({
    data: { status: 'paid', paidAt: db.serverDate() }
  }).catch(() => {});
  return ok({ silver, rmb, balanceAfter });
}

// ===== 充值：人民币 → 白银 =====
// channel=mock 模拟到账；wechat 为预留真实微信支付结构（TODO 接入 cloud.cloudPay）
async function recharge(OPENID, event) {
  const { plan, channel = 'mock' } = event || {};
  const config = await getConfig(db);
  const rmb = Number(plan);
  const silver = config.rechargePlans[String(rmb)];
  if (!silver) return fail('INVALID_PLAN', '充值金额不在可选档位内');

  if (channel !== 'mock') {
    // TODO: 拿到微信支付商户号后，在此处替换为真实支付流程：
    // const payRes = await cloud.cloudPay.unifiedOrder({
    //   body: '江湖榜-白银充值', outTradeNo: genNo(), spbillCreateIp: '127.0.0.1',
    //   subMchId: '<子商户号>', totalFee: rmb * 100, envId: cloud.DYNAMIC_CURRENT_ENV,
    //   functionName: 'payCallback'
    // });
    // return ok({ payParams: payRes.payment });
    // 支付回调云函数 payCallback 中再执行本函数入账逻辑（加订单号幂等校验）
    const channelNames = { wechat: '微信支付', alipay: '支付宝', bankcard: '银行卡' };
    return fail(
      'REAL_PAY_NOT_READY',
      `${channelNames[channel] || channel}通道尚未开通（需商户号）。当前请使用模拟支付通道体验。`
    );
  }

  // 模拟通道：直接入账（事务防并发）
  let balanceAfter = 0; // 声明在 try 外，供成功返回使用
  const t = await db.startTransaction();
  try {
    const u = await t.collection('users').doc(OPENID).get();
    balanceAfter = (u.data.silver || 0) + silver;
    await t.collection('users').doc(OPENID).update({
      data: { silver: _.inc(silver), updatedAt: db.serverDate() }
    });
    await t.collection('transactions').add({
      data: {
        userId: OPENID, type: 'recharge', currency: 'silver',
        amount: silver, balanceAfter, relatedId: '',
        remark: `充值 ¥${rmb}（模拟通道）`, createdAt: db.serverDate()
      }
    });
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
    console.error('[wallet] 充值事务失败:', e);
    return fail('TRANSACTION_FAIL', '充值失败，请重试');
  }
  return ok({ silver, rmb, balanceAfter });
}

// ===== 兑换：1 金 = 100 银，双向，不扣税 =====
async function exchange(OPENID, event) {
  const { direction, amount } = event || {};
  const config = await getConfig(db);
  const rate = config.exchangeRate;
  const amt = Number(amount);
  if (!['toGold', 'toSilver'].includes(direction)) return fail('INVALID_PARAM', '兑换方向不合法');
  if (!Number.isInteger(amt) || amt <= 0) return fail('INVALID_AMOUNT', '兑换数量须为正整数');
  if (direction === 'toGold' && amt % rate !== 0) {
    return fail('INVALID_AMOUNT', `白银须按 ${rate} 的整数倍兑换黄金`);
  }

  const t = await db.startTransaction();
  try {
    const u = await t.collection('users').doc(OPENID).get();
    let outField, inField, outAmount, inAmount, outCurrency, inCurrency;
    if (direction === 'toGold') {
      outField = 'silver'; inField = 'gold';
      outAmount = amt; inAmount = amt / rate;
      outCurrency = 'silver'; inCurrency = 'gold';
    } else {
      outField = 'gold'; inField = 'silver';
      outAmount = amt; inAmount = amt * rate;
      outCurrency = 'gold'; inCurrency = 'silver';
    }
    if ((u.data[outField] || 0) < outAmount) {
      throw biz('INSUFFICIENT', `余额不足，当前${outCurrency === 'gold' ? '黄金' : '白银'}余额 ${u.data[outField] || 0}`);
    }
    const outAfter = (u.data[outField] || 0) - outAmount;
    const inAfter = (u.data[inField] || 0) + inAmount;
    await t.collection('users').doc(OPENID).update({
      data: {
        [outField]: _.inc(-outAmount),
        [inField]: _.inc(inAmount),
        updatedAt: db.serverDate()
      }
    });
    await t.collection('transactions').add({
      data: {
        userId: OPENID, type: 'exchange_out', currency: outCurrency,
        amount: -outAmount, balanceAfter: outAfter, relatedId: '',
        remark: `兑换${inCurrency === 'gold' ? '黄金' : '白银'}支出（1金=100银，不扣税）`,
        createdAt: db.serverDate()
      }
    });
    await t.collection('transactions').add({
      data: {
        userId: OPENID, type: 'exchange_in', currency: inCurrency,
        amount: inAmount, balanceAfter: inAfter, relatedId: '',
        remark: `兑换${inCurrency === 'gold' ? '黄金' : '白银'}到账（1金=100银，不扣税）`,
        createdAt: db.serverDate()
      }
    });
    await t.commit();
    return ok({ outAmount, inAmount, outCurrency, inCurrency, outAfter, inAfter });
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
    if (e.bizCode) return fail(e.bizCode, e.message);
    console.error('[wallet] 兑换事务失败:', e);
    return fail('TRANSACTION_FAIL', '兑换失败，请重试');
  }
}

// ===== 流水分页 =====
async function listTransactions(OPENID, event) {
  const { page = 1, pageSize = 20 } = event || {};
  const size = Math.min(Number(pageSize) || 20, 50);
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;
  const [listRes, totalRes] = await Promise.all([
    db.collection('transactions').where({ userId: OPENID })
      .orderBy('createdAt', 'desc').skip(skip).limit(size).get(),
    db.collection('transactions').where({ userId: OPENID }).count()
  ]);
  return ok({
    list: listRes.data,
    total: totalRes.total,
    hasMore: skip + listRes.data.length < totalRes.total
  });
}
