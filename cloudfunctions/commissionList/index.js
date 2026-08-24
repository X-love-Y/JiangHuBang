// commissionList —— 大厅委托列表：筛选（分类/地区/星级/币种/关键词）+ 分页 + 广播位
// 展示规则：
//   · 大厅（无关键词）：只显示可接取的活跃委托（待接单且未过期）
//   · 定向搜索（有关键词）：活跃委托在前，已取消/已过期/已结算的补后并带状态标识
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, fail } = require('./business');

exports.main = async (event) => {
  const { id } = event || {};
  if (id) return detail(id);

  const {
    categoryId, star, currency, province, city, keyword,
    sort = 'new', page = 1, pageSize = 10, statusFilter = 'active'
  } = event || {};

  const size = Math.min(Number(pageSize) || 10, 20);
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;

  // 基础筛选（分类/星级/币种/地区）
  const filters = {};
  if (categoryId) filters.categoryId = categoryId;
  if (star) filters.star = Number(star);
  if (currency) filters.currency = currency;
  if (province) filters['region.province'] = province;
  if (city) filters['region.city'] = city;

  // ---- 定向搜索模式：含已结束委托 ----
  if (keyword) {
    const data = await searchCommissions(filters, String(keyword).slice(0, 20), size, skip);
    const enriched = await attachPublishers(data.list);
    return ok({
      list: enriched,
      total: data.total,
      hasMore: data.hasMore,
      broadcast: [],
      search: true
    });
  }

  // ---- 已结束视图：已截止/已结算 + 到期未翻转的待接单（等待定时任务处理） ----
  // 注：已取消的委托不在此展示，仅定向搜索可查
  if (statusFilter === 'closed') {
    const whereClosed = Object.assign(
      { status: _.in(['expired', 'settled']) },
      filters
    );
    const whereDeadPending = Object.assign(
      { status: 'pending', deadline: _.lt(new Date()) },
      filters
    );
    const [closedRes, deadPendingRes] = await Promise.all([
      db.collection('commissions').where(whereClosed)
        .orderBy('createdAt', 'desc').skip(skip).limit(size).get(),
      db.collection('commissions').where(whereDeadPending)
        .orderBy('createdAt', 'desc').limit(20).get()
    ]);
    const closedCount = await db.collection('commissions').where(whereClosed).count();
    // 到期未翻转的 pending 展示为「已截止」
    const merged = closedRes.data.concat(
      deadPendingRes.data.map((c) => Object.assign({}, c, { status: 'expired' }))
    );
    const total = closedCount.total + (await db.collection('commissions').where(whereDeadPending).count()).total;
    return ok({
      list: await attachPublishers(merged),
      total,
      hasMore: skip + size < total,
      broadcast: []
    });
  }

  // ---- 大厅模式（默认）：只展示待接单且未过期的委托 ----
  const where = Object.assign({ status: 'pending', deadline: _.gt(new Date()) }, filters);

  let query = db.collection('commissions').where(where);
  const sortMap = {
    new: { sortScore: 'desc', createdAt: 'desc' },
    amountDesc: { amount: 'desc', sortScore: 'desc' },
    amountAsc: { amount: 'asc', sortScore: 'desc' },
    starDesc: { star: 'desc', sortScore: 'desc' }
  };
  const sortConf = sortMap[sort] || sortMap.new;
  Object.keys(sortConf).forEach((k) => {
    query = query.orderBy(k, sortConf[k]);
  });

  const [listRes, totalRes, broadcastRes] = await Promise.all([
    query.skip(skip).limit(size).get(),
    db.collection('commissions').where(where).count(),
    // 广播位：被喇叭/置顶符强化的待接单委托
    db.collection('commissions')
      .where({ status: 'pending', boostUntil: _.gt(new Date()), deadline: _.gt(new Date()) })
      .orderBy('sortScore', 'desc').limit(3).get()
  ]);

  const enriched = await attachPublishers(listRes.data);
  const enrichedBroadcast = await attachPublishers(broadcastRes.data);
  return ok({
    list: enriched,
    total: totalRes.total,
    hasMore: skip + listRes.data.length < totalRes.total,
    broadcast: enrichedBroadcast
  });
};

// 定向搜索：标题模糊匹配（含全部状态，活跃在前）+ 委托编号精确匹配
async function searchCommissions(filters, kw, size, skip) {
  const titleCond = { title: db.RegExp({ regexp: kw, options: 'i' }) };
  const activeWhere = Object.assign({}, filters, titleCond, {
    status: 'pending', deadline: _.gt(new Date())
  });
  const closedWhere = Object.assign({}, filters, titleCond, {
    status: _.in(['accepted', 'submitted', 'settled', 'cancelled', 'expired'])
  });
  const queries = [
    db.collection('commissions').where(activeWhere)
      .orderBy('sortScore', 'desc').orderBy('createdAt', 'desc').limit(50).get(),
    db.collection('commissions').where(closedWhere)
      .orderBy('createdAt', 'desc').limit(20).get(),
    // 到期未翻转的 pending 在搜索中也归入已结束（展示为已截止）
    db.collection('commissions')
      .where(Object.assign({}, filters, titleCond, { status: 'pending', deadline: _.lt(new Date()) }))
      .orderBy('createdAt', 'desc').limit(20).get()
  ];
  // 委托编号精确查找（JH 开头）
  if (/^jh/i.test(kw)) {
    queries.push(
      db.collection('commissions').where({ commissionNo: kw.toUpperCase() }).limit(1).get()
    );
  }
  const results = await Promise.all(queries);
  const seen = new Set();
  const all = [];
  results.forEach((r, idx) => {
    r.data.forEach((c) => {
      if (seen.has(c._id)) return;
      seen.add(c._id);
      // 第 3 组是到期未翻转的 pending → 展示为已截止
      all.push(idx === 2 ? Object.assign({}, c, { status: 'expired' }) : c);
    });
  });
  return {
    list: all.slice(skip, skip + size),
    total: all.length,
    hasMore: skip + size < all.length
  };
}

// 补发布者信息（昵称/头像/佩戴称号）
async function attachPublishers(list) {
  const pubIds = [...new Set(list.map((c) => c.publisherId))];
  const usersMap = {};
  if (pubIds.length) {
    const uRes = await db.collection('users').where({ _id: _.in(pubIds) }).get();
    uRes.data.forEach((u) => { usersMap[u._id] = u; });
  }
  return list.map((c) => {
    const u = usersMap[c.publisherId];
    return Object.assign({}, c, {
      publisher: u
        ? { nickname: u.nickname, avatarUrl: u.avatarUrl, titleId: u.equippedTitleId }
        : { nickname: '江湖路人', avatarUrl: '', titleId: '' }
    });
  });
}

// 委托详情：含发布者/接单者信息与关联订单
async function detail(id) {
  const cRes = await db.collection('commissions').doc(id).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;

  const ids = [c.publisherId, c.acceptorId].filter(Boolean);
  const usersMap = {};
  if (ids.length) {
    const uRes = await db.collection('users').where({ _id: _.in(ids) }).get();
    uRes.data.forEach((u) => { usersMap[u._id] = u; });
  }
  const party = (uid) => {
    const u = usersMap[uid];
    return u
      ? { nickname: u.nickname, avatarUrl: u.avatarUrl, titleId: u.equippedTitleId, bio: u.bio || '' }
      : { nickname: '江湖路人', avatarUrl: '', titleId: '', bio: '' };
  };

  let order = null;
  if (c.acceptorId) {
    const oRes = await db.collection('orders').where({ commissionId: id }).limit(1).get();
    order = oRes.data[0] || null;
  }
  return ok({
    detail: Object.assign({}, c, {
      publisher: party(c.publisherId),
      acceptor: c.acceptorId ? party(c.acceptorId) : null,
      order
    })
  });
}
