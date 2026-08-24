// profile —— 编辑资料：头像（chooseAvatar 合规能力）/ 昵称 / 简介
const { callWithToast } = require('../../utils/api');
const { ensureLogin, refreshUser } = require('../../utils/auth');

Page({
  data: {
    user: null,
    nickname: '',
    bio: '',
    avatarUrl: '',
    saving: false
  },

  onShow() {
    // 只加载一次：头像选择器关闭后 onShow 会再次触发，
    // 若重复拉取服务端资料会覆盖用户未保存的编辑内容
    if (this.data.user) return;
    ensureLogin().then((u) => {
      this.setData({
        user: u,
        nickname: u.nickname || '江湖路人',
        bio: u.bio || '',
        avatarUrl: u.avatarUrl || ''
      });
    });
  },

  // 微信合规头像选择能力
  onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl;
    if (!tempPath) return;
    this.setData({ avatarUrl: tempPath, avatarChanged: true });
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },
  onBioInput(e) {
    this.setData({ bio: e.detail.value });
  },

  async save() {
    const d = this.data;
    if (d.saving) return;
    const nickname = d.nickname.trim();
    if (!nickname) return wx.showToast({ title: '昵称不能为空', icon: 'none' });
    if (nickname.length > 16) return wx.showToast({ title: '昵称最多 16 字', icon: 'none' });

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      let avatarUrl = d.user.avatarUrl || '';
      if (d.avatarChanged && d.avatarUrl) {
        const res = await wx.cloud.uploadFile({
          cloudPath: `avatars/${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`,
          filePath: d.avatarUrl
        });
        avatarUrl = res.fileID;
      }
      const r = await callWithToast('useItem', {
        action: 'updateProfile',
        profile: { nickname, bio: d.bio.trim(), avatarUrl }
      });
      wx.hideLoading();
      wx.setStorageSync('jh_user', r.user);
      getApp().globalData.userInfo = r.user;
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      wx.hideLoading();
    } finally {
      this.setData({ saving: false });
    }
  }
});
