// review —— 评价页：write=给完成者打分（发布者，结算后，支持预填+修改）/ mine=我收到的评价
const { call, callWithToast } = require('../../utils/api');
const { ensureLogin } = require('../../utils/auth');
const { formatDateTime } = require('../../utils/format');

Page({
  data: {
    mode: 'write', // write | mine
    commissionId: '',
    revieweeId: '',
    revieweeName: '',
    star: 0,
    dims: { onTime: 0, quality: 0, attitude: 0 },
    comment: '',
    existingReview: null, // 已存在评价（预填+修改模式）
    editLeft: 0,
    submitting: false,
    // mine 模式
    list: [],
    loading: false
  },

  onLoad(options) {
    if (options.mode === 'mine') {
      this.setData({ mode: 'mine' });
      wx.setNavigationBarTitle({ title: '我的评价' });
      this.fetchMine();
      return;
    }
    this.setData({
      commissionId: options.commissionId || '',
      revieweeId: options.revieweeId || '',
      revieweeName: decodeURIComponent(options.name || '这位侠士')
    });
    wx.setNavigationBarTitle({ title: '评价完成者' });
    this.fetchExisting();
  },

  onShow() {
    ensureLogin().catch(() => {});
  },

  // 拉取既有评价：有则预填并进入修改模式
  fetchExisting() {
    if (!this.data.commissionId || !this.data.revieweeId) return;
    call('review', {
      action: 'getByCommission',
      commissionId: this.data.commissionId,
      revieweeId: this.data.revieweeId
    })
      .then((data) => {
        const r = data.review;
        if (!r) return;
        this.setData({
          star: r.star || 0,
          dims: Object.assign({ onTime: 0, quality: 0, attitude: 0 }, r.dims || {}),
          comment: r.comment || '',
          existingReview: r,
          editLeft: Math.max(0, 1 - (r.editCount || 0))
        });
        wx.setNavigationBarTitle({ title: '修改评价' });
      })
      .catch(() => {});
  },

  fetchMine() {
    this.setData({ loading: true });
    call('review', { action: 'listMine', page: 1, pageSize: 50 })
      .then((data) => {
        this.setData({
          list: (data.list || []).map((r) => Object.assign({}, r, {
            timeText: formatDateTime(r.createdAt),
            dimsText: this.dimsText(r)
          }))
        });
      })
      .catch(() => {})
      .finally(() => this.setData({ loading: false }));
  },

  dimsText(r) {
    const parts = [];
    if (r.dims && r.dims.onTime) parts.push(`按时 ${r.dims.onTime}`);
    if (r.dims && r.dims.quality) parts.push(`质量 ${r.dims.quality}`);
    if (r.dims && r.dims.attitude) parts.push(`态度 ${r.dims.attitude}`);
    return parts.join(' · ');
  },

  // ---- 打分 ----
  pickStar(e) {
    this.setData({ star: Number(e.currentTarget.dataset.star) });
  },
  pickDim(e) {
    const dim = e.currentTarget.dataset.dim;
    const v = Number(e.currentTarget.dataset.v);
    this.setData({ [`dims.${dim}`]: v });
  },
  onCommentInput(e) {
    this.setData({ comment: e.detail.value });
  },

  async submit() {
    const d = this.data;
    if (d.submitting) return;
    if (!d.star) return wx.showToast({ title: '请先打分', icon: 'none' });
    if (d.existingReview && d.editLeft <= 0) {
      return wx.showToast({ title: '该评价已不能再修改', icon: 'none' });
    }
    this.setData({ submitting: true });
    try {
      if (d.existingReview) {
        await call('review', {
          action: 'edit',
          reviewId: d.existingReview._id,
          star: d.star,
          dims: d.dims,
          comment: d.comment.trim()
        });
        wx.showToast({ title: '评价已修改', icon: 'success' });
      } else {
        await call('review', {
          action: 'submit',
          commissionId: d.commissionId,
          revieweeId: d.revieweeId,
          star: d.star,
          dims: d.dims,
          comment: d.comment.trim()
        });
        wx.showToast({ title: '评价已提交', icon: 'success' });
      }
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      if (e && e.silent) wx.showToast({ title: e.message, icon: 'none', duration: 2200 });
    } finally {
      this.setData({ submitting: false });
    }
  },

  appeal(e) {
    const reviewId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '申诉该评价',
      editable: true,
      placeholderText: '请填写申诉理由',
      confirmText: '提交申诉',
      success: (res) => {
        if (res.confirm && res.content) {
          callWithToast('review', { action: 'appeal', reviewId, reason: res.content }, { loading: true })
            .then(() => wx.showToast({ title: '申诉已提交', icon: 'success' }))
            .catch(() => {});
        }
      }
    });
  }
});
