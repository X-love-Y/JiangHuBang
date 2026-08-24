// ai —— AI 助手：月卡状态 + 每日推荐可接委托 + 为我的委托生成解决方案
const { call, callWithToast } = require('../../utils/api');
const { ensureLogin, refreshUser } = require('../../utils/auth');
const { formatAmount } = require('../../utils/format');

Page({
  data: {
    user: null,
    passText: '',
    hasPass: false,

    recommendLoading: false,
    recommends: [],
    recommendMock: false,
    remaining: 0,

    // 方案生成：选择我的一个委托
    myCommissions: [],
    pickedIndex: -1,
    solutionLoading: false,
    solutionText: '',
    solutionMock: false
  },

  onShow() {
    ensureLogin().then(() => {
      this.fetchUser();
      this.fetchMyCommissions();
    });
  },

  fetchUser() {
    return refreshUser().then((u) => {
      // !! 保证布尔值，避免 null/undefined 进入 setData
      const hasPass = !!(u.aiPassExpire && new Date(u.aiPassExpire).getTime() > Date.now());
      let passText = '未开通 · 非月卡用户推荐 5 银/次';
      if (hasPass) {
        const d = new Date(u.aiPassExpire);
        passText = `月卡生效至 ${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} · 每日 3 次推荐 + 3 次方案免费`;
      }
      this.setData({ user: u, hasPass, passText });
    });
  },

  fetchMyCommissions() {
    return call('commissionMy', { action: 'published', page: 1, pageSize: 20 })
      .then((data) => {
        const list = (data.list || [])
          .filter((c) => ['pending', 'accepted'].includes(c.status))
          .map((c) => Object.assign({}, c, { amountText: formatAmount(c.amount, c.currency) }));
        this.setData({ myCommissions: list });
      })
      .catch(() => {});
  },

  // ===== 今日推荐 =====
  doRecommend() {
    if (this.data.recommendLoading) return;
    this.setData({ recommendLoading: true, recommends: [] });
    call('aiAssistant', { action: 'recommend' })
      .then((r) => {
        refreshUser();
        this.setData({
          recommends: r.items || [],
          recommendMock: r.mock,
          remaining: r.remaining
        });
        if (!r.items.length) wx.showToast({ title: '当前没有可推荐的委托', icon: 'none' });
      })
      .catch((e) => {
        if (e && e.silent) wx.showToast({ title: e.message, icon: 'none', duration: 2200 });
        refreshUser();
      })
      .finally(() => this.setData({ recommendLoading: false }));
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
  },

  // ===== 委托方案 =====
  pickCommission(e) {
    this.setData({ pickedIndex: Number(e.currentTarget.dataset.i), solutionText: '' });
  },
  doSolution() {
    const c = this.data.myCommissions[this.data.pickedIndex];
    if (!c) return wx.showToast({ title: '请先选择一个委托', icon: 'none' });
    if (this.data.solutionLoading) return;
    this.setData({ solutionLoading: true, solutionText: '' });
    call('aiAssistant', { action: 'solution', commissionId: c._id })
      .then((r) => {
        refreshUser();
        this.setData({ solutionText: r.text, solutionMock: r.mock });
      })
      .catch((e) => {
        if (e && e.silent) wx.showToast({ title: e.message, icon: 'none', duration: 2200 });
      })
      .finally(() => this.setData({ solutionLoading: false }));
  },

  goShop() {
    wx.navigateTo({ url: '/pages/shop/shop' });
  }
});
