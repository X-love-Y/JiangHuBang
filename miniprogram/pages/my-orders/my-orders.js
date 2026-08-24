// my-orders —— 我的委托：我发布的 / 我接的 + 状态筛选
const { call } = require('../../utils/api');
const { STATUS } = require('../../config/constants');
const { formatAmount, amountParts, relativeTime } = require('../../utils/format');

Page({
  data: {
    tab: 'published', // published | accepted
    statusFilter: '',
    statuses: [
      { value: '', label: '全部' },
      { value: 'pending', label: '待接单' },
      { value: 'accepted', label: '进行中' },
      { value: 'submitted', label: '待确认' },
      { value: 'settled', label: '已结算' },
      { value: 'cancelled', label: '已取消' },
      { value: 'expired', label: '已过期' }
    ],
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    emptyText: ''
  },

  onShow() {
    this.updateEmptyText();
    this.fetch(true);
  },

  // 空状态文案随标签变化（发布/接单 × 状态）
  updateEmptyText() {
    const statusWord = {
      '': '',
      pending: '待接单',
      accepted: '进行中',
      submitted: '待确认',
      settled: '已结算',
      cancelled: '已取消',
      expired: '已截止'
    }[this.data.statusFilter];
    const action = this.data.tab === 'published' ? '发布' : '接下';
    this.setData({
      emptyText: statusWord
        ? `还没有${statusWord}的委托`
        : (this.data.tab === 'published' ? '还没有发布过委托' : '还没有接过委托')
    });
  },

  onPullDownRefresh() {
    this.fetch(true).finally(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.fetch(false);
  },

  fetch(reset) {
    if (this.data.loading) return Promise.resolve();
    this.setData({ loading: true });
    const page = reset ? 1 : this.data.page + 1;
    return call('commissionMy', {
      action: this.data.tab,
      status: this.data.statusFilter,
      page,
      pageSize: 10
    })
      .then((data) => {
        const enriched = (data.list || []).map((c) => Object.assign({}, c, {
          amountText: formatAmount(c.amount, c.currency),
          amountParts: amountParts(c.amount, c.currency),
          timeText: relativeTime(c.createdAt),
          statusConf: STATUS[c.status] || STATUS.pending
        }));
        this.setData({
          list: reset ? enriched : this.data.list.concat(enriched),
          page,
          hasMore: data.hasMore
        });
      })
      .catch(() => {})
      .finally(() => this.setData({ loading: false }));
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    this.updateEmptyText();
    this.fetch(true);
  },
  pickStatus(e) {
    this.setData({ statusFilter: e.currentTarget.dataset.value });
    this.updateEmptyText();
    this.fetch(true);
  },
  goDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
  }
});
