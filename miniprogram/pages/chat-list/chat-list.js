// chat-list —— 客服会话列表
const { call } = require('../../utils/api');
const { resolveCloudUrls } = require('../../utils/cloud-img');
const { relativeTime } = require('../../utils/format');

Page({
  data: { list: [], loading: false },

  onShow() {
    this.fetch();
  },

  fetch() {
    this.setData({ loading: true });
    call('chat', { action: 'listConversations' })
      .then(async (data) => {
        const list = data.list || [];
        const avatars = list.map((c) => c.otherAvatar).filter(Boolean);
        const urlMap = await resolveCloudUrls(avatars);
        this.setData({
          list: list.map((c) => Object.assign({}, c, {
            timeText: relativeTime(c.lastAt),
            otherAvatar: urlMap[c.otherAvatar] || c.otherAvatar
          }))
        });
      })
      .catch(() => {})
      .finally(() => this.setData({ loading: false }));
  },

  goChat(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/chat/chat?conversationId=${id}&otherName=${encodeURIComponent(name || '对方')}`
    });
  }
});
