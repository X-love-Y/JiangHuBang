// list —— 寻找委托（大厅）：筛选 chips + 广播位 + 玻璃卡片流 + 分页
const { call } = require('../../utils/api');
const { cronBoost } = require('../../utils/cron');
const { resolveCloudUrls } = require('../../utils/cloud-img');
const { CATEGORIES, CURRENCY } = require('../../config/constants');
const { formatAmount, amountParts, relativeTime, formatRegion, deadlineFromNow } = require('../../utils/format');

Page({
  data: {
    categories: [{ code: '', name: '全部', icon: '🍂' }].concat(CATEGORIES),
    activeCategory: '',
    stars: [0, 1, 2, 3, 4, 5],
    activeStar: 0,
    currencies: [
      { label: '全部', value: '' },
      { label: '白银', value: 'silver' },
      { label: '黄金', value: 'gold' }
    ],
    activeCurrency: '',
    sorts: [
      { label: '最新', value: 'new' },
      { label: '金额高', value: 'amountDesc' },
      { label: '金额低', value: 'amountAsc' },
      { label: '星级高', value: 'starDesc' }
    ],
    activeSort: 'new',
    regionText: '',
    province: '',
    city: '',
    keyword: '',

    list: [],
    broadcast: [],
    page: 1,
    hasMore: true,
    loading: false,
    statusFilter: 'active' // active=可接取（默认） / closed=已结束（回查）
  },

  onLoad(options) {
    this.fetch(true);
  },

  onShow() {
    // 逛大厅时兜底触发定时任务（60 秒节流），到点的定时委托即刻上架
    cronBoost();
    this.fetchAnnouncement();
  },

  // 管理员公告横幅
  fetchAnnouncement() {
    call('admin', { action: 'announcementList' })
      .then((d) => {
        const a = (d.list || [])[0] || null;
        if (a && (!this.data.announcement || this.data.announcement._id !== a._id)) {
          this.setData({ announcement: a });
        }
      })
      .catch(() => {});
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
    return call('commissionList', {
      categoryId: this.data.activeCategory,
      star: this.data.activeStar,
      currency: this.data.activeCurrency,
      province: this.data.province,
      city: this.data.city,
      keyword: this.data.keyword,
      sort: this.data.activeSort,
      statusFilter: this.data.statusFilter,
      page,
      pageSize: 10
    })
      .then(async (data) => {
        // 云存储头像 fileID → 临时链接（部分基础库直接渲染 cloud:// 失败）
        const allItems = (data.list || []).concat(data.broadcast || []);
        const avatarIds = allItems
          .map((c) => (c.publisher && c.publisher.avatarUrl) || '')
          .filter(Boolean);
        const urlMap = await resolveCloudUrls(avatarIds);
        const enriched = (data.list || []).map((c) => this.enrich(c, urlMap));
        this.setData({
          list: reset ? enriched : this.data.list.concat(enriched),
          broadcast: (data.broadcast || []).map((c) => this.enrich(c, urlMap)),
          page,
          hasMore: data.hasMore
        });
      })
      .catch(() => {})
      .finally(() => this.setData({ loading: false }));
  },

  // 展示字段格式化 + 分类名称 + 头像临时链接
  enrich(c, urlMap = {}) {
    const cat = CATEGORIES.find((x) => x.code === c.categoryId) || {};
    const rawAvatar = (c.publisher && c.publisher.avatarUrl) || '';
    // 转换失败时返回空串（显示占位头像），绝不把原始 cloud:// 交给渲染层
    const avatarUrl = urlMap[rawAvatar]
      || (rawAvatar.startsWith('cloud://') ? '' : rawAvatar);
    const publisher = Object.assign({}, c.publisher, { avatarUrl });
    return Object.assign({}, c, {
      catName: cat.name || '',
      catIcon: cat.icon || '🏷️',
      amountText: formatAmount(c.amount, c.currency),
      amountParts: amountParts(c.amount, c.currency),
      timeText: relativeTime(c.createdAt),
      regionText: formatRegion(c.region),
      deadlineText: deadlineFromNow(c.deadline),
      isPublic: c.mode === 'public',
      pendingCount: (c.requests || []).filter((r) => r.status === 'pending').length,
      publisher
    });
  },

  // ---- 筛选交互 ----
  pickStatusFilter(e) {
    this.setData({ statusFilter: e.currentTarget.dataset.filter, page: 1, hasMore: true });
    this.fetch(true);
  },
  pickCategory(e) {
    this.setData({ activeCategory: e.currentTarget.dataset.code });
    this.fetch(true);
  },
  pickStar(e) {
    this.setData({ activeStar: Number(e.currentTarget.dataset.star) });
    this.fetch(true);
  },
  pickCurrency(e) {
    this.setData({ activeCurrency: e.currentTarget.dataset.currency });
    this.fetch(true);
  },
  pickSort(e) {
    this.setData({ activeSort: e.currentTarget.dataset.sort });
    this.fetch(true);
  },
  onRegionChange(e) {
    const [province, city] = e.detail.value || [];
    this.setData({
      province: province && province !== '全部' ? province : '',
      city: city && city !== '全部' ? city : '',
      regionText: [province, city].filter((v) => v && v !== '全部').join(' · ')
    });
    this.fetch(true);
  },
  clearRegion() {
    this.setData({ province: '', city: '', regionText: '' });
    this.fetch(true);
  },
  onSearchInput(e) {
    this.setData({ keyword: e.detail.value });
  },
  onSearchConfirm() {
    this.fetch(true);
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
  goPublish() {
    wx.navigateTo({ url: '/pages/publish/publish' });
  }
});
