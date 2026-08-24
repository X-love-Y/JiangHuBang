// account —— 账号中心：查看账号 ID / 修改密码 / 修改 ID / 换账号登录
const { call } = require('../../utils/api');
const { ensureLogin, refreshUser } = require('../../utils/auth');

const ID_RE = /^[A-Za-z0-9]{4,16}$/;
const PWD_RE = /^(?=.*[A-Za-z])(?=.*\d)[\S]{6,20}$/;

Page({
  data: {
    user: null,
    tab: 'info', // info | pwd | id
    // 改密
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    // 改 ID
    idPassword: '',
    newUserId: '',
    submitting: false
  },

  onShow() {
    ensureLogin().then((u) => this.setData({ user: u }));
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  // ---- 修改密码 ----
  onOldPwdInput(e) { this.setData({ oldPassword: e.detail.value }); },
  onNewPwdInput(e) { this.setData({ newPassword: e.detail.value }); },
  onConfirmPwdInput(e) { this.setData({ confirmPassword: e.detail.value }); },

  async changePassword() {
    const d = this.data;
    if (d.submitting) return;
    if (!d.oldPassword) return wx.showToast({ title: '请输入旧密码', icon: 'none' });
    if (!PWD_RE.test(d.newPassword)) {
      return wx.showToast({ title: '新密码需 6-20 位且含字母和数字', icon: 'none' });
    }
    if (d.newPassword !== d.confirmPassword) {
      return wx.showToast({ title: '两次输入的密码不一致', icon: 'none' });
    }
    this.setData({ submitting: true });
    try {
      await call('account', {
        action: 'changePassword',
        oldPassword: d.oldPassword,
        newPassword: d.newPassword
      });
      wx.showToast({ title: '密码已修改', icon: 'success' });
      this.setData({ oldPassword: '', newPassword: '', confirmPassword: '', tab: 'info' });
    } catch (e) {
      if (e && e.silent) wx.showToast({ title: e.message, icon: 'none', duration: 2200 });
    } finally {
      this.setData({ submitting: false });
    }
  },

  // ---- 修改 ID ----
  onIdPwdInput(e) { this.setData({ idPassword: e.detail.value }); },
  onNewIdInput(e) { this.setData({ newUserId: e.detail.value.trim() }); },

  async changeUserId() {
    const d = this.data;
    if (d.submitting) return;
    if (!ID_RE.test(d.newUserId)) {
      return wx.showToast({ title: '新 ID 需 4-16 位字母或数字', icon: 'none' });
    }
    if (!d.idPassword) return wx.showToast({ title: '请输入当前密码验证身份', icon: 'none' });
    this.setData({ submitting: true });
    try {
      const r = await call('account', {
        action: 'changeUserId',
        password: d.idPassword,
        newUserId: d.newUserId
      });
      // 更新缓存并回显
      const user = r.user;
      wx.setStorageSync('jh_user_v3', user);
      getApp().globalData.userInfo = user;
      wx.setStorageSync('jh_last_login_id', d.newUserId);
      wx.showToast({ title: 'ID 已修改', icon: 'success' });
      this.setData({ user, idPassword: '', newUserId: '', tab: 'info' });
    } catch (e) {
      if (e && e.silent) wx.showToast({ title: e.message, icon: 'none', duration: 2200 });
    } finally {
      this.setData({ submitting: false });
    }
  },

  goRegister() {
    wx.navigateTo({ url: '/pages/register/register?mode=register' });
  },
  goLogin() {
    wx.navigateTo({ url: '/pages/register/register?mode=login' });
  }
});
