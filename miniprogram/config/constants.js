// constants.js —— 业务常量：分类 / 状态文案 / 星级梯度 / 货币
// 权威数值（费率、梯度、上限）以云数据库 config 集合为准，此处为展示用默认值

// ===== 委托分类（10 大类 + 子类） =====
const CATEGORIES = [
  {
    code: 'run', name: '跑腿代办', icon: '🛵',
    sub: [
      { code: 'takeout', name: '取外卖快递' },
      { code: 'buy', name: '代买代送' },
      { code: 'queue', name: '排队取号' },
      { code: 'errand', name: '代办业务' }
    ]
  },
  {
    code: 'study', name: '学业互助', icon: '📖',
    sub: [
      { code: 'tutor', name: '课程讲题' },
      { code: 'exam', name: '考前辅导' },
      { code: 'writing', name: '文书润色' },
      { code: 'skillteach', name: '技能带教' }
    ]
  },
  {
    code: 'ride', name: '出行接送', icon: '🚗',
    sub: [
      { code: 'pickup', name: '顺风接送' },
      { code: 'designated', name: '代驾陪驾' },
      { code: 'medical', name: '陪同就医出行' }
    ]
  },
  {
    code: 'romance', name: '情感姻缘', icon: '💞',
    sub: [
      { code: 'match', name: '牵线介绍' },
      { code: 'talk', name: '情感倾诉' },
      { code: 'dateplan', name: '约会策划' },
      { code: 'confess', name: '表白助攻' }
    ]
  },
  {
    code: 'search', name: '寻人寻物', icon: '🔍',
    sub: [
      { code: 'person', name: '寻人' },
      { code: 'pet', name: '寻宠物' },
      { code: 'lost', name: '寻失物' },
      { code: 'clue', name: '寻线索' }
    ]
  },
  {
    code: 'life', name: '生活服务', icon: '🏠',
    sub: [
      { code: 'clean', name: '家政清洁' },
      { code: 'repair', name: '家电维修' },
      { code: 'petsit', name: '遛狗代养' },
      { code: 'move', name: '搬家搭手' },
      { code: 'cook', name: '代厨做饭' }
    ]
  },
  {
    code: 'skill', name: '技能悬赏', icon: '🎨',
    sub: [
      { code: 'photo', name: 'P图修图' },
      { code: 'design', name: '设计制图' },
      { code: 'copy', name: '文案翻译' },
      { code: 'video', name: '摄影剪辑' },
      { code: 'code', name: '编程开发' },
      { code: 'voice', name: '配音播音' }
    ]
  },
  {
    code: 'mystic', name: '玄学娱乐', icon: '🔮',
    sub: [
      { code: 'divination', name: '占卜测算' },
      { code: 'astro', name: '塔罗星座' },
      { code: 'dream', name: '解梦' },
      { code: 'fengshui', name: '风水咨询' }
    ],
    notice: '本类委托仅供娱乐用途，请理性看待'
  },
  {
    code: 'accompany', name: '陪伴探访', icon: '🤝',
    sub: [
      { code: 'visit', name: '医院探病' },
      { code: 'attend', name: '陪诊陪聊' },
      { code: 'game', name: '陪玩游戏' },
      { code: 'train', name: '陪逛陪练' }
    ]
  },
  {
    code: 'idea', name: '意见征集', icon: '💡',
    sub: [
      { code: 'consult', name: '方案咨询' },
      { code: 'bounty', name: '点子悬赏' },
      { code: 'survey', name: '问卷征集' },
      { code: 'vent', name: '吐槽树洞' }
    ]
  }
];

// ===== 委托状态 =====
const STATUS = {
  scheduled: { text: '待发布', badge: 'badge--info' },
  pending: { text: '待接单', badge: 'badge--info' },
  accepted: { text: '进行中', badge: 'badge--gold' },
  submitted: { text: '待确认', badge: 'badge--cinnabar' },
  settled: { text: '已结算', badge: 'badge--success' },
  cancelled: { text: '已取消', badge: 'badge--ink' },
  expired: { text: '已截止', badge: 'badge--ink' }
};

// ===== 星级梯度（等价白银，1金=100银） =====
const STAR_THRESHOLDS = [100, 1000, 10000, 100000];
const STAR_DESC = ['', '寻常小事', '稍有难度', '江湖悬赏', '高手云集', '旷世难寻'];

// ===== 货币 =====
const CURRENCY = {
  silver: { name: '白银', unit: '银', color: 'var(--silver)' },
  gold: { name: '黄金', unit: '金', color: 'var(--gold)' }
};

// 兑换倍率（展示用，权威值在 config 集合）
const EXCHANGE_RATE = 100;

// ===== 充值档位（元 → 白银） =====
const RECHARGE_PLANS = [
  { rmb: 6, silver: 600 },
  { rmb: 18, silver: 1800 },
  { rmb: 30, silver: 3000 },
  { rmb: 68, silver: 6800 },
  { rmb: 128, silver: 12800 }
];

// 支付通道（wechat/alipay/bankcard 为预留结构，当前仅 mock 可用）
const PAY_CHANNELS = [
  { code: 'mock', name: '模拟支付', hint: '开发阶段通道，点击即到账' },
  { code: 'wechat', name: '微信支付', hint: '需商户号开通后启用' },
  { code: 'alipay', name: '支付宝', hint: '小程序内不可用，预留 H5 版' },
  { code: 'bankcard', name: '银行卡', hint: '小程序内不可用，预留 H5 版' }
];

module.exports = {
  CATEGORIES,
  STATUS,
  STAR_THRESHOLDS,
  STAR_DESC,
  CURRENCY,
  EXCHANGE_RATE,
  RECHARGE_PLANS,
  PAY_CHANNELS
};
