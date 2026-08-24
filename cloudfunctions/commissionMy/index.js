// commissionMy —— 我的委托：
//   published=我发布的；accepted=我接的（私人模式 acceptorId + 公共模式 acceptors 数组均覆盖）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, requireUser, fail } = require('./business');

exports.main = async (event) => {
  const auth = await requireUser(db);
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { action = 'published', status, page = 1, pageSize = 10 } = event || {};

  const size = Math.min(Number(pageSize) || 10, 20);
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;

  const where = {};
  if (status) where.status = status;

  let list = [];
  let total = 0;
  if (action === 'accepted') {
    // 私人模式：acceptorId 直接匹配；公共模式：acceptors 数组包含我
    const [privRes, pubRes] = await Promise.all([
      db.collection('commissions')
        .where(Object.assign({}, where, { acceptorId: OPENID }))
        .orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('commissions')
        .where(Object.assign({}, where, { mode: 'public', 'acceptors.userId': OPENID }))
        .orderBy('createdAt', 'desc').limit(100).get()
    ]);
    list = privRes.data.concat(pubRes.data)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    total = list.length;
  } else {
    const q = Object.assign({}, where, { publisherId: OPENID });
    const [listRes, totalRes] = await Promise.all([
      db.collection('commissions').where(q).orderBy('createdAt', 'desc')
        .skip(skip).limit(size).get(),
      db.collection('commissions').where(q).count()
    ]);
    list = listRes.data;
    total = totalRes.total;
  }

  // 补对方信息：我发布的补接单者/合作者；我接的补发布者
  const otherIds = [
    ...new Set(list.map((c) => {
      if (action === 'accepted') return c.publisherId;
      if (c.mode === 'public') return (c.acceptors || []).map((a) => a.userId);
      return [c.acceptorId];
    }).flat().filter(Boolean))
  ];
  const usersMap = {};
  if (otherIds.length) {
    const uRes = await db.collection('users').where({ _id: _.in(otherIds) }).get();
    uRes.data.forEach((u) => { usersMap[u._id] = u; });
  }
  const pick = (id) => {
    const u = usersMap[id];
    return u
      ? { nickname: u.nickname, avatarUrl: u.avatarUrl, titleId: u.equippedTitleId }
      : { nickname: '江湖路人', avatarUrl: '', titleId: '' };
  };
  const enriched = list.map((c) => {
    let other;
    if (action === 'accepted') {
      other = pick(c.publisherId);
    } else if (c.mode === 'public') {
      // 公共模式：合作者昵称列表
      const names = (c.acceptors || []).map((a) => a.nickname || '江湖路人');
      other = { nickname: names.join('、') || '待选定', avatarUrl: '', titleId: '' };
    } else {
      other = c.acceptorId ? pick(c.acceptorId) : { nickname: '待接单', avatarUrl: '', titleId: '' };
    }
    return Object.assign({}, c, { other });
  });

  // accepted 路径：内存分页
  const paged = action === 'accepted' ? enriched.slice(skip, skip + size) : enriched;
  const hasMore = action === 'accepted'
    ? skip + size < total
    : skip + list.length < total;

  return ok({ list: paged, total, hasMore });
};
