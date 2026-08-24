// initData —— 一次性初始化：创建集合 + 平台配置 + 称号/商城/管理员种子数据
// 二期：新增 10 个集合、管理员账号（盐哈希）、三值称号；config 改为字段级 merge
// 幂等：可重复执行，已有数据不覆盖（config 只补新字段，已有字段保留运营值）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { DEFAULTS, hashPassword, ok } = require('./business');

// ---- 种子数据：12 个称号（成就 6 + 商城 6） ----
const TITLES = [
  { titleId: 'a_beginner', name: '初入江湖', source: 'achievement', condition: { metric: 'completedCount', value: 1 }, price: 0, unlock: null, effect: { kind: 'show', value: null }, desc: '完成第 1 单委托自动获得', icon: '🌱', sort: 1 },
  { titleId: 'a_known', name: '小有名气', source: 'achievement', condition: { metric: 'completedCount', value: 10 }, price: 0, unlock: null, effect: { kind: 'show', value: null }, desc: '累计完成 10 单委托', icon: '🍵', sort: 2 },
  { titleId: 'a_chivalrous', name: '行侠仗义', source: 'achievement', condition: { metric: 'completedCount', value: 30 }, price: 0, unlock: null, effect: { kind: 'acceptBoost', value: 1 }, desc: '累计完成 30 单 · 同时接单上限 +1', icon: '⚔️', sort: 3 },
  { titleId: 'a_famous', name: '名震一方', source: 'achievement', condition: { metric: 'completedCount', value: 100 }, price: 0, unlock: null, effect: { kind: 'publishBoost', value: 2 }, desc: '累计完成 100 单 · 同时在挂委托 +2', icon: '🏮', sort: 4 },
  { titleId: 'a_overlord', name: '一方霸主', source: 'achievement', condition: { metric: 'completedCount', value: 300 }, price: 0, unlock: null, effect: { kind: 'priority', value: 20 }, desc: '累计完成 300 单 · 委托权重 +20', icon: '🐉', sort: 5 },
  { titleId: 'a_legend', name: '江湖传说', source: 'achievement', condition: { metric: 'completedCount', value: 1000 }, price: 0, unlock: null, effect: { kind: 'feeDiscount', value: 0.5 }, desc: '累计完成 1000 单 · 发布委托中介费减半', icon: '👑', sort: 6 },
  { titleId: 's_roamer', name: '江湖游侠', source: 'shop', condition: null, price: 20, unlock: { metric: 'completedCount', value: 1 }, effect: { kind: 'show', value: null }, desc: '展示称号，尽显侠士风范', icon: '🍶', sort: 7 },
  { titleId: 's_disciple', name: '名门弟子', source: 'shop', condition: null, price: 100, unlock: { metric: 'completedCount', value: 5 }, effect: { kind: 'priority', value: 10 }, desc: '佩戴时委托权重 +10', icon: '📜', sort: 8 },
  { titleId: 's_hero', name: '盖世豪侠', source: 'shop', condition: null, price: 300, unlock: { metric: 'completedCount', value: 20 }, effect: { kind: 'feeDiscount', value: 0.8 }, desc: '佩戴时中介费 1%→0.8%', icon: '🔥', sort: 9 },
  { titleId: 's_master', name: '一代宗师', source: 'shop', condition: null, price: 800, unlock: { metric: 'completedCount', value: 50 }, effect: [{ kind: 'feeDiscount', value: 0.6 }, { kind: 'publishBoost', value: 2 }], desc: '中介费→0.6% · 发布上限 +2', icon: '🎋', sort: 10 },
  { titleId: 's_chief', name: '武林盟主', source: 'shop', condition: null, price: 2000, unlock: { metric: 'completedCount', value: 100 }, effect: [{ kind: 'feeDiscount', value: 0.5 }, { kind: 'acceptBoost', value: 2 }], desc: '中介费→0.5% · 接单上限 +2', icon: '🏆', sort: 11 },
  { titleId: 's_immortal', name: '绝世高人', source: 'shop', condition: null, price: 5000, unlock: { metric: 'completedCount', value: 300 }, effect: [{ kind: 'feeDiscount', value: 0.5 }, { kind: 'priority', value: 50 }, { kind: 'publishBoost', value: 5 }], desc: '中介费→0.5% · 权重 +50 · 发布上限 +5', icon: '☯️', sort: 12 }
];

// ---- 二期新增：三值成就称号（source=threeValue，达标自动授予） ----
const THREE_VALUE_TITLES = DEFAULTS.threeValueTitles.map((t, i) => ({
  titleId: t.titleId,
  name: t.name,
  source: 'threeValue',
  condition: { metric: t.kind === 'all' ? 'threeAll' : t.kind, value: t.value },
  price: 0,
  unlock: null,
  effect: t.effect,
  desc: t.desc,
  icon: t.icon,
  sort: 20 + i
}));

// ---- 种子数据：13 个商城商品（6 商城称号 + 7 道具） ----
const SHOP_ITEMS = [
  { itemId: 's_roamer', name: '江湖游侠', type: 'title', price: 20, unlock: { metric: 'completedCount', value: 1 }, effect: { kind: 'show', value: null }, durationDays: 0, desc: '展示称号', icon: '🍶', stock: -1, status: 1, sort: 1 },
  { itemId: 's_disciple', name: '名门弟子', type: 'title', price: 100, unlock: { metric: 'completedCount', value: 5 }, effect: { kind: 'priority', value: 10 }, durationDays: 0, desc: '佩戴时委托权重 +10', icon: '📜', stock: -1, status: 1, sort: 2 },
  { itemId: 's_hero', name: '盖世豪侠', type: 'title', price: 300, unlock: { metric: 'completedCount', value: 20 }, effect: { kind: 'feeDiscount', value: 0.8 }, durationDays: 0, desc: '中介费 1%→0.8%', icon: '🔥', stock: -1, status: 1, sort: 3 },
  { itemId: 's_master', name: '一代宗师', type: 'title', price: 800, unlock: { metric: 'completedCount', value: 50 }, effect: [{ kind: 'feeDiscount', value: 0.6 }, { kind: 'publishBoost', value: 2 }], durationDays: 0, desc: '中介费→0.6% · 发布上限 +2', icon: '🎋', stock: -1, status: 1, sort: 4 },
  { itemId: 's_chief', name: '武林盟主', type: 'title', price: 2000, unlock: { metric: 'completedCount', value: 100 }, effect: [{ kind: 'feeDiscount', value: 0.5 }, { kind: 'acceptBoost', value: 2 }], durationDays: 0, desc: '中介费→0.5% · 接单上限 +2', icon: '🏆', stock: -1, status: 1, sort: 5 },
  { itemId: 's_immortal', name: '绝世高人', type: 'title', price: 5000, unlock: { metric: 'completedCount', value: 300 }, effect: [{ kind: 'feeDiscount', value: 0.5 }, { kind: 'priority', value: 50 }, { kind: 'publishBoost', value: 5 }], durationDays: 0, desc: '顶级称号，效果拉满', icon: '☯️', stock: -1, status: 1, sort: 6 },
  { itemId: 'card_ink', name: '墨玉卡面', type: 'card', price: 30, unlock: { metric: 'completedCount', value: 0 }, effect: { kind: 'show', value: null }, durationDays: 0, desc: '个人主页墨玉质感卡面（永久）', icon: '🖤', stock: -1, status: 1, sort: 7 },
  { itemId: 'card_gold', name: '鎏金卡面', type: 'card', price: 80, unlock: { metric: 'completedCount', value: 0 }, effect: { kind: 'show', value: null }, durationDays: 0, desc: '个人主页鎏金质感卡面（永久）', icon: '✨', stock: -1, status: 1, sort: 8 },
  { itemId: 'trumpet', name: '传音喇叭', type: 'trumpet', price: 5, unlock: { metric: 'completedCount', value: 0 }, effect: { kind: 'broadcast', value: 24 }, durationDays: 0, desc: '指定委托占据首页广播位 24 小时', icon: '📣', stock: -1, status: 1, sort: 9 },
  { itemId: 'push100', name: '委托推送', type: 'push', price: 10, unlock: { metric: 'completedCount', value: 0 }, effect: { kind: 'push', value: 100 }, durationDays: 0, desc: '推送你的委托给 100 名匹配侠士', icon: '📨', stock: -1, status: 1, sort: 10 },
  { itemId: 'boost24', name: '置顶符', type: 'boost', price: 20, unlock: { metric: 'completedCount', value: 0 }, effect: { kind: 'broadcast', value: 24 }, durationDays: 0, desc: '委托在大厅置顶 24 小时', icon: '📌', stock: -1, status: 1, sort: 11 },
  { itemId: 'priority', name: '先声夺人', type: 'priority', price: 15, unlock: { metric: 'completedCount', value: 0 }, effect: { kind: 'priority', value: 1.5 }, durationDays: 0, desc: '24h 内发布的委托列表权重 +50%', icon: '⚡', stock: -1, status: 1, sort: 12 },
  { itemId: 'aiPass', name: 'AI 月卡', type: 'aiPass', price: 50, unlock: { metric: 'completedCount', value: 0 }, effect: { kind: 'aiDaily', value: 30 }, durationDays: 30, desc: '30 天内每日 3 次推荐 + 3 次方案免费', icon: '🤖', stock: -1, status: 1, sort: 13 }
];

// ---- 二期新增：三值商城称号 ----
const TV_SHOP_ITEMS = [
  { itemId: 's_reputable', name: '德高望重', type: 'title', price: 500, unlock: { metric: 'rep', value: 800 }, effect: { kind: 'feeDiscount', value: 0.9 }, durationDays: 0, desc: '信誉值 800 解锁 · 中介费 9 折', icon: '🪶', stock: -1, status: 1, sort: 14 },
  { itemId: 's_craftsman', name: '鬼斧神工', type: 'title', price: 300, unlock: { metric: 'skill', value: 800 }, effect: { kind: 'acceptBoost', value: 1 }, durationDays: 0, desc: '能力值 800 解锁 · 接单上限 +1', icon: '⚒', stock: -1, status: 1, sort: 15 },
  { itemId: 's_herald', name: '名动江湖', type: 'title', price: 800, unlock: { metric: 'fame', value: 800 }, effect: { kind: 'priority', value: 20 }, durationDays: 0, desc: '名望值 800 解锁 · 委托权重 +20', icon: '🎺', stock: -1, status: 1, sort: 16 }
];
// 对应 titles 定义（佩戴效果读取用）
const TV_SHOP_TITLES = [
  { titleId: 's_reputable', name: '德高望重', source: 'shop', condition: null, price: 500, unlock: { metric: 'rep', value: 800 }, effect: { kind: 'feeDiscount', value: 0.9 }, desc: '佩戴时中介费 9 折', icon: '🪶', sort: 17 },
  { titleId: 's_craftsman', name: '鬼斧神工', source: 'shop', condition: null, price: 300, unlock: { metric: 'skill', value: 800 }, effect: { kind: 'acceptBoost', value: 1 }, desc: '佩戴时接单上限 +1', icon: '⚒', sort: 18 },
  { titleId: 's_herald', name: '名动江湖', source: 'shop', condition: null, price: 800, unlock: { metric: 'fame', value: 800 }, effect: { kind: 'priority', value: 20 }, desc: '佩戴时委托权重 +20', icon: '🎺', sort: 19 }
];

// ---- 管理员种子（密码盐哈希，明文仅存在于初始化配置） ----
const ADMINS = [
  { userId: 'XianZun', password: 'xz4444mima' },
  { userId: 'QingZhongSheng', password: 'xy333mima' }
];

exports.main = async () => {
  const names = [
    'users', 'commissions', 'orders', 'transactions', 'shop_items', 'titles',
    'user_items', 'ai_records', 'config',
    // 二期新增
    'drafts', 'notifications', 'conversations', 'messages', 'reviews',
    'admins', 'admin_logs', 'reports', 'announcements', 'pay_orders', 'chain_history'
  ];
  const created = [];
  const existed = [];
  for (const n of names) {
    try {
      await db.createCollection(n);
      created.push(n);
    } catch (e) {
      existed.push(n); // 已存在或环境不支持自动建集合
    }
  }

  // ---- 平台配置：字段级 merge（已有字段保留运营值，只补缺失字段） ----
  let configCreated = false;
  try {
    const cur = await db.collection('config').doc('global').get();
    const merged = Object.assign({}, DEFAULTS, cur.data);
    await db.collection('config').doc('global').set({ data: merged });
  } catch (e) {
    await db.collection('config').doc('global').set({ data: Object.assign({}, DEFAULTS) });
    configCreated = true;
  }

  // ---- 种子称号（已有数据则跳过，避免覆盖运营调整） ----
  const titleCnt = await db.collection('titles').count().catch(() => ({ total: 0 }));
  if (titleCnt.total === 0) {
    for (const t of TITLES.concat(THREE_VALUE_TITLES, TV_SHOP_TITLES)) {
      await db.collection('titles').doc(t.titleId).set({ data: t });
    }
  } else {
    // 增量：二期三值称号单独补种（按 titleId 幂等）
    for (const t of THREE_VALUE_TITLES.concat(TV_SHOP_TITLES)) {
      await db.collection('titles').doc(t.titleId).set({ data: t });
    }
  }
  const itemCnt = await db.collection('shop_items').count().catch(() => ({ total: 0 }));
  if (itemCnt.total === 0) {
    for (const it of SHOP_ITEMS.concat(TV_SHOP_ITEMS)) {
      await db.collection('shop_items').doc(it.itemId).set({ data: it });
    }
  } else {
    for (const it of TV_SHOP_ITEMS) {
      await db.collection('shop_items').doc(it.itemId).set({ data: it });
    }
  }

  // ---- 管理员种子（set 幂等；已存在的管理员密码不覆盖） ----
  for (const a of ADMINS) {
    try {
      await db.collection('admins').doc(a.userId).get();
    } catch (e) {
      const { salt, hash } = hashPassword(a.password);
      await db.collection('admins').doc(a.userId).set({
        data: {
          userId: a.userId,
          pwdHash: hash,
          pwdSalt: salt,
          openid: null,       // 首次登录时绑定
          level: 1,
          createdAt: db.serverDate()
        }
      });
    }
  }

  return ok({
    created, existed, configCreated,
    titlesSeeded: THREE_VALUE_TITLES.length + TV_SHOP_TITLES.length,
    adminsSeeded: ADMINS.map((a) => a.userId)
  });
};
