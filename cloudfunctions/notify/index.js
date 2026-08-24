// notify —— 站内通知：list 列表 / unreadCount 未读数 / readAll 全部已读
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, fail, requireUser } = require('./business');

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[notify] 未捕获异常:', e);
    return fail('INTERNAL', '系统异常，请稍后重试');
  }
};

async function handle(event) {
  const auth = await requireUser(db);
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { action, page = 1, pageSize = 20 } = event || {};

  if (action === 'unreadCount') {
    const cnt = await db.collection('notifications')
      .where({ userId: OPENID, read: false }).count();
    return ok({ count: cnt.total });
  }
  if (action === 'readAll') {
    await db.collection('notifications')
      .where({ userId: OPENID, read: false })
      .update({ data: { read: true } });
    return ok({ done: true });
  }

  const size = Math.min(Number(pageSize) || 20, 50);
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;
  const [listRes, totalRes] = await Promise.all([
    db.collection('notifications').where({ userId: OPENID })
      .orderBy('createdAt', 'desc').skip(skip).limit(size).get(),
    db.collection('notifications').where({ userId: OPENID }).count()
  ]);
  return ok({ list: listRes.data, total: totalRes.total, hasMore: skip + listRes.data.length < totalRes.total });
}
