// mine —— 我的：用户卡（卡面+称号）+ 余额卡 + 数据网格 + 功能入口
const { call } = require('../../utils/api');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: {
    user: null,
    equippedTitle: null,
    cardName: '',
    stats: [],
    aiPassText: ''
  },

  onShow() {
    ensureLogin().then(() => this.fetch());
    this.fetchUnread();
  },

  // 通知角标 + 会话未读角标
  fetchUnread() {
    call('notify', { action: 'unreadCount' })
      .then((d) => this.setData({ unreadCount: d.count || 0 }))
      .catch(() => {});
    call('chat', { action: 'listConversations' })
      .then((d) => this.setData({ chatUnread: d.totalUnread || 0 }))
      .catch(() => {});
  },

  fetch() {
    call('useItem', { action: 'myBag' })
      .then((data) => {
        const user = data.user;
        if (!user) return;
        const equipped = (data.ownedTitles || []).find((t) => t.titleId === user.equippedTitleId);
        const cardMap = { card_ink: '墨玉卡面', card_gold: '鎏金卡面' };
        const stats = [
          { label: '发布', value: (user.stats && user.stats.published) || 0 },
          { label: '接单', value: (user.stats && user.stats.accepted) || 0 },
          { label: '完成', value: (user.stats && user.stats.completed) || 0 },
          { label: '赚得银', value: (user.stats && user.stats.totalEarnedSilver) || 0 }
        ];
        const hasPass = user.aiPassExpire && new Date(user.aiPassExpire).getTime() > Date.now();
        let aiPassText = '未开通';
        if (hasPass) {
          const d = new Date(user.aiPassExpire);
          aiPassText = `月卡生效至 ${d.getMonth() + 1}/${d.getDate()}`;
        }
        this.setData({
          user,
          equippedTitle: equipped || { name: '江湖路人', icon: '🍃' },
          cardName: cardMap[user.cardId] || '',
          stats,
          aiPassText
        });
        getApp().globalData.userInfo = user;
      })
      .catch(() => {});
  },

  goOrders() { wx.navigateTo({ url: '/pages/my-orders/my-orders' }); },
  goTitles() { wx.navigateTo({ url: '/pages/titles/titles' }); },
  goShop() { wx.navigateTo({ url: '/pages/shop/shop' }); },
  goWallet() { wx.navigateTo({ url: '/pages/wallet/wallet' }); },
  goAI() { wx.navigateTo({ url: '/pages/ai/ai' }); },
  goProfile() { wx.navigateTo({ url: '/pages/profile/profile' }); },
  goUserHome() { wx.navigateTo({ url: '/pages/user-home/user-home' }); },
  goReviews() { wx.navigateTo({ url: '/pages/review/review?mode=mine' }); },
  goDrafts() { wx.navigateTo({ url: '/pages/drafts/drafts' }); },
  goNotify() { wx.navigateTo({ url: '/pages/notify/notify' }); },
  goChatList() { wx.navigateTo({ url: '/pages/chat-list/chat-list' }); },
  goAdmin() { wx.navigateTo({ url: '/pages/admin/admin' }); },
  goRecharge() { wx.navigateTo({ url: '/pages/recharge/recharge' }); },
  goAccount() {
    wx.navigateTo({ url: '/pages/account/account' });
  }
});
