// titles —— 我的称号：成就进度 + 已拥有称号佩戴 + 未解锁成就一览
const { call, callWithToast } = require('../../utils/api');
const { refreshUser } = require('../../utils/auth');

Page({
  data: {
    user: null,
    ownedTitles: [],
    allTitles: [],
    equippedTitleId: '',
    nextTitle: null,
    progress: 0 // 距离下一成就称号的百分比
  },

  onShow() {
    this.fetch();
  },

  fetch() {
    call('useItem', { action: 'myBag' })
      .then((data) => {
        const user = data.user;
        if (!user) return;
        const completed = (user.stats && user.stats.completed) || 0;
        const achievements = (data.allTitles || []).filter((t) => t.source === 'achievement');
        const next = achievements.find((t) => !t.owned);
        // 进度：相对上一个已达成条件的推进比例
        let progress = 100;
        if (next) {
          const idx = achievements.indexOf(next);
          const prevValue = idx > 0 ? achievements[idx - 1].condition.value : 0;
          progress = Math.min(100, Math.round(((completed - prevValue) / (next.condition.value - prevValue)) * 100));
        }
        this.setData({
          user,
          ownedTitles: data.ownedTitles || [],
          allTitles: data.allTitles || [],
          equippedTitleId: user.equippedTitleId,
          nextTitle: next,
          progress
        });
      })
      .catch(() => {});
  },

  equip(e) {
    const titleId = e.currentTarget.dataset.id;
    if (titleId === this.data.equippedTitleId) return;
    callWithToast('useItem', { action: 'equipTitle', titleId }, { loading: true })
      .then(() => {
        refreshUser();
        wx.showToast({ title: '已佩戴', icon: 'success' });
        this.fetch();
      })
      .catch(() => {});
  },

  goShop() {
    wx.navigateTo({ url: '/pages/shop/shop' });
  }
});
