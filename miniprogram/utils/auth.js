// auth.js —— 登录态与用户信息缓存
// 登录调用云函数 login：取 openid + 初始化用户（首登送 100 白银）
const { call } = require('./api');

const USER_KEY = 'jh_user_v3'; // v3：二期账号体系（userId/pwdHash 不上前端缓存之外无差异，换 key 防旧壳脏数据）
let cachedUser = null;

// 用户字段兜底：云数据库可能不返回 null 字段，统一补默认值防止 setData undefined 告警
const USER_SKELETON = {
  nickname: '江湖路人',
  avatarUrl: '',
  bio: '',
  silver: 0,
  gold: 0,
  titleIds: [],
  equippedTitleId: '',
  cardId: '',
  aiPassExpire: null,
  stats: { published: 0, accepted: 0, completed: 0, cancelled: 0, totalEarnedSilver: 0, totalEarnedGold: 0 }
};

function normalizeUser(u) {
  if (!u) return null;
  return Object.assign({}, USER_SKELETON, u, {
    stats: Object.assign({}, USER_SKELETON.stats, u.stats || {})
  });
}

// 确保已登录并返回用户（有缓存直接返回，无缓存调云函数）
function ensureLogin(force = false) {
  if (!force && cachedUser) return Promise.resolve(cachedUser);
  const cached = force ? null : wx.getStorageSync(USER_KEY);
  if (cached) {
    cachedUser = cached;
    getApp().globalData.userInfo = cached;
    return Promise.resolve(cached);
  }
  return call('login').then((res) => {
    // login 返回 { user, isNew }，须解包出真正的用户对象再缓存
    const user = res && res.user ? res.user : res;
    cachedUser = normalizeUser(user);
    getApp().globalData.userInfo = cachedUser;
    wx.setStorageSync(USER_KEY, cachedUser);
    return cachedUser;
  });
}

// 强制刷新（余额变动后调用）
function refreshUser() {
  return ensureLogin(true).then((user) => {
    wx.setStorageSync(USER_KEY, user);
    return user;
  });
}

// 是否游客（未注册 ID 账号）
function isGuest(user) {
  return !user || !user.userId;
}

// 要求已注册账号：未注册时弹引导并抛出 silent 错误，调用方 catch 后中止即可
function requireAccount() {
  return ensureLogin().then((u) => {
    if (!u.userId) {
      wx.showModal({
        title: '需要注册账号',
        content: '发布委托、接单、聊天、商城等操作需要注册江湖账号（ID + 密码）',
        confirmText: '去注册',
        cancelText: '先逛逛',
        success: (res) => {
          if (res.confirm) wx.navigateTo({ url: '/pages/register/register?mode=register' });
        }
      });
      const err = new Error('需要注册账号');
      err.code = 'NEED_REGISTER';
      err.silent = true;
      throw err;
    }
    return u;
  });
}

function logout() {
  cachedUser = null;
  getApp().globalData.userInfo = null;
  wx.removeStorageSync(USER_KEY);
}

module.exports = { ensureLogin, refreshUser, logout, isGuest, requireAccount };
