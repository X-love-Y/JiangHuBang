// register —— 注册 / 登录 / 补注册（三模式共用一页，mode 由 query 传入）
// 密码规则：6-20 位、必须同时含字母和数字；ID：4-16 位字母数字
const { call } = require('../../utils/api');
const { refreshUser } = require('../../utils/auth');

const ID_RE = /^[A-Za-z0-9]{4,16}$/;
const PWD_RE = /^(?=.*[A-Za-z])(?=.*\d)[\S]{6,20}$/;

Page({
  data: {
    mode: 'register', // register | login | setup
    title: '注册江湖账号',
    subtitle: 'ID 和密码是你的江湖身份凭证，请妥善保管',
    userId: '',
    password: '',
    confirmPassword: '',
    idOk: false,
    pwdOk: false,
    pwdHasLetter: false,
    pwdHasDigit: false,
    submitting: false
  },

  onLoad(options) {
    const mode = options.mode || 'register';
    const conf = {
      register: { title: '注册江湖账号', subtitle: 'ID 和密码是你的江湖身份凭证，请妥善保管' },
      login: { title: '登录江湖账号', subtitle: '换设备或换微信后，用 ID+密码找回你的账号' },
      setup: { title: '设置江湖账号', subtitle: '你的资产与记录都会保留，只需补设 ID 和密码' }
    };
    const c = conf[mode] || conf.register;
    this.setData(Object.assign({ mode: conf[mode] ? mode : 'register' }, c));
    if (mode === 'register' || mode === 'setup') {
      wx.setNavigationBarTitle({ title: '注册账号' });
    } else {
      wx.setNavigationBarTitle({ title: '登录账号' });
    }
    // 登录模式：回填上次登录的 ID，减少重复输入
    if (mode === 'login') {
      const lastId = wx.getStorageSync('jh_last_login_id');
      if (lastId) {
        this.setData({ userId: lastId, idOk: ID_RE.test(lastId) });
      }
    }
  },

  onIdInput(e) {
    const userId = e.detail.value.trim();
    this.setData({
      userId,
      idOk: ID_RE.test(userId)
    });
  },
  onPwdInput(e) {
    const password = e.detail.value;
    this.setData({
      password,
      pwdHasLetter: /[A-Za-z]/.test(password),
      pwdHasDigit: /\d/.test(password),
      pwdOk: PWD_RE.test(password)
    });
  },
  onConfirmInput(e) {
    this.setData({ confirmPassword: e.detail.value });
  },

  async submit() {
    const d = this.data;
    if (d.submitting) return;
    if (d.mode !== 'login' && !d.idOk) {
      return wx.showToast({ title: 'ID 需 4-16 位字母或数字', icon: 'none' });
    }
    if (!d.userId) return wx.showToast({ title: '请输入账号 ID', icon: 'none' });
    if (!d.pwdOk) {
      return wx.showToast({ title: '密码需 6-20 位且含字母和数字', icon: 'none' });
    }
    if (d.mode !== 'login' && d.password !== d.confirmPassword) {
      return wx.showToast({ title: '两次输入的密码不一致', icon: 'none' });
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: d.mode === 'login' ? '登录中…' : '注册中…', mask: true });
    try {
      if (d.mode === 'login') {
        await call('account', { action: 'login', userId: d.userId, password: d.password });
      } else {
        await call('account', { action: 'register', userId: d.userId, password: d.password });
      }
      // 记住上次登录 ID，方便下次登录回填
      wx.setStorageSync('jh_last_login_id', d.userId);
      // 强制刷新本地用户缓存（登录后可能发生资产合并）
      await refreshUser();
      wx.hideLoading();
      wx.showToast({ title: d.mode === 'login' ? '登录成功' : '注册成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      wx.hideLoading();
      if (e && e.silent) wx.showToast({ title: e.message, icon: 'none', duration: 2200 });
    } finally {
      this.setData({ submitting: false });
    }
  },

  goBrowse() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: '/pages/home/home' });
    }
  }
});
