// notify —— 站内通知：列表（未读高亮）+ 全部已读 + 链通知跳草稿箱
const { call } = require('../../utils/api');
const { formatDateTime } = require('../../utils/format');

Page({
  data: { list: [], loading: false },

  onShow() {
    this.fetch();
  },

  fetch() {
    this.setData({ loading: true });
    call('notify', { action: 'list', page: 1, pageSize: 50 })
      .then((data) => {
        this.setData({
          list: (data.list || []).map((n) => Object.assign({}, n, {
            timeText: formatDateTime(n.createdAt)
          }))
        });
      })
      .catch(() => {})
      .finally(() => this.setData({ loading: false }));
  },

  onPullDownRefresh() {
    this.fetch().finally(() => wx.stopPullDownRefresh());
  },

  // 点通知：标记全部已读；链相关通知跳草稿箱
  tapNotify() {
    call('notify', { action: 'readAll' }).catch(() => {});
    this.setData({ list: this.data.list.map((n) => Object.assign({}, n, { read: true })) });
    const types = ['chain_confirm', 'chain_skip', 'chain_auto', 'draft_published', 'publish_failed'];
    const anyChain = this.data.list.some((n) => types.includes(n.type) && !n.read);
    if (anyChain) {
      wx.navigateTo({ url: '/pages/drafts/drafts' });
    }
  }
});
