// publish —— 发布委托：玻璃表单卡 + 实时星级预览 + 图片上传
const { callWithToast } = require('../../utils/api');
const { ensureLogin, refreshUser } = require('../../utils/auth');
const { CATEGORIES, STAR_THRESHOLDS, STAR_DESC } = require('../../config/constants');

Page({
  data: {
    user: null,
    categories: CATEGORIES,
    activeCategory: null, // { code, name, icon, sub }
    subList: [],
    subIndex: -1,

    title: '',
    description: '',
    regionText: '',
    region: null,
    currency: 'silver',
    amount: '',
    star: 0,
    starDesc: '',
    balanceText: '',

    images: [], // 本地临时路径
    minDeadline: '',
    maxDeadline: '',
    deadlineText: '',
    deadlineTs: null,

    // 发布时间：立即 / 定时
    publishMode: 'now',
    publishDate: '',
    publishTime: '',

    // 发布模式：私人（单人先到先得）/ 公共（多人申请，发布者选定）
    mode: 'private',
    minAcceptors: 1,
    maxAcceptors: 3,
    splitMode: 'equal',

    submitting: false,
    assessResult: null
  },

  onLoad() {
    // 截止时间范围：今天 ~ +30 天
    const p = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const today = new Date();
    const max = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    this.setData({
      minDeadline: fmt(today),
      maxDeadline: fmt(max),
      deadlineText: fmt(new Date(Date.now() + 7 * 24 * 3600 * 1000)),
      deadlineTs: new Date(new Date(Date.now() + 7 * 24 * 3600 * 1000)).setHours(23, 59, 59, 999),
      // 定时发布默认值：今天当前时间
      publishDate: fmt(today),
      publishTime: `${p(today.getHours())}:${p(today.getMinutes())}`
    });
  },

  onShow() {
    ensureLogin().then((u) => {
      this.setData({ user: u });
    });
  },

  // ---- 输入 ----
  onTitleInput(e) {
    this.setData({ title: e.detail.value });
  },
  onDescInput(e) {
    this.setData({ description: e.detail.value });
  },

  // ---- 分类（再点一次已选分类 = 取消选择） ----
  pickCategory(e) {
    const i = Number(e.currentTarget.dataset.i);
    const cat = CATEGORIES[i];
    if (this.data.activeCategory && this.data.activeCategory.code === cat.code) {
      this.setData({ activeCategory: null, subList: [], subIndex: -1 });
      return;
    }
    this.setData({
      activeCategory: cat,
      subList: cat.sub || [],
      subIndex: -1
    });
  },
  pickSub(e) {
    const i = Number(e.currentTarget.dataset.i);
    // 再点一次已选子类 = 取消选择
    this.setData({ subIndex: this.data.subIndex === i ? -1 : i });
  },

  // ---- 地区 ----
  onRegionChange(e) {
    const [province, city, district] = e.detail.value || [];
    const text = [province, city, district].filter((v) => v && v !== '全部').join(' · ');
    this.setData({
      regionText: text,
      region: { province, city, district }
    });
  },

  // ---- 币种/金额/星级 ----
  switchCurrency(e) {
    const currency = e.currentTarget.dataset.currency;
    this.setData({ currency });
    this.calcStar();
  },
  onAmountInput(e) {
    this.setData({ amount: e.detail.value });
    this.calcStar();
  },
  calcStar() {
    const amt = Number(this.data.amount);
    if (!Number.isInteger(amt) || amt <= 0) {
      this.setData({ star: 0, starDesc: '' });
      return;
    }
    const equiv = this.data.currency === 'gold' ? amt * 100 : amt;
    const star = equiv < STAR_THRESHOLDS[0] ? 1
      : equiv < STAR_THRESHOLDS[1] ? 2
      : equiv < STAR_THRESHOLDS[2] ? 3
      : equiv < STAR_THRESHOLDS[3] ? 4 : 5;
    this.setData({ star, starDesc: STAR_DESC[star] });
  },

  // ---- 图片 ----
  chooseImages() {
    const rest = 9 - this.data.images.length;
    if (rest <= 0) return;
    wx.chooseMedia({
      count: rest,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        this.setData({ images: this.data.images.concat(paths) });
      }
    });
  },
  removeImage(e) {
    const i = Number(e.currentTarget.dataset.i);
    const images = this.data.images.slice();
    images.splice(i, 1);
    this.setData({ images });
  },
  previewImage(e) {
    const i = Number(e.currentTarget.dataset.i);
    wx.previewImage({ urls: this.data.images, current: this.data.images[i] });
  },

  // ---- 截止时间 ----
  onDeadlineChange(e) {
    const v = e.detail.value; // YYYY-MM-DD
    this.setData({
      deadlineText: v,
      deadlineTs: new Date(`${v} 23:59:59`).getTime()
    });
  },

  // ---- 发布模式 ----
  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode });
  },
  onMinInput(e) {
    this.setData({ minAcceptors: e.detail.value });
  },
  onMaxInput(e) {
    this.setData({ maxAcceptors: e.detail.value });
  },
  switchSplitMode(e) {
    this.setData({ splitMode: e.currentTarget.dataset.mode });
  },

  // ---- 发布时间 ----
  switchPublishMode(e) {
    this.setData({ publishMode: e.currentTarget.dataset.mode });
  },
  onPublishDateChange(e) {
    this.setData({ publishDate: e.detail.value });
  },
  onPublishTimeChange(e) {
    this.setData({ publishTime: e.detail.value });
  },

  // ---- 存为草稿 ----
  async saveDraft() {
    const d = this.data;
    if (d.submitting) return;
    if (!d.title || d.title.trim().length < 2) return wx.showToast({ title: '先填写标题', icon: 'none' });
    const cat = d.activeCategory;
    if (!cat) return wx.showToast({ title: '先选择分类', icon: 'none' });
    const amt = Number(d.amount);
    if (!Number.isInteger(amt) || amt <= 0) return wx.showToast({ title: '先填写金额', icon: 'none' });
    const params = {
      title: d.title.trim(),
      description: d.description.trim(),
      categoryId: cat.code,
      subCategory: d.subIndex >= 0 ? cat.sub[d.subIndex].code : '',
      region: d.region,
      amount: amt,
      currency: d.currency,
      deadline: d.deadlineTs || undefined,
      images: [],
      mode: d.mode
    };
    if (d.mode === 'public') {
      params.minAcceptors = Number(d.minAcceptors);
      params.maxAcceptors = Number(d.maxAcceptors);
      params.splitMode = d.splitMode;
    }
    // 定时发布草稿
    if (d.publishMode === 'scheduled') {
      const ts = new Date(`${d.publishDate} ${d.publishTime}`).getTime();
      if (isNaN(ts) || ts <= Date.now()) return wx.showToast({ title: '定时时间需晚于当前时间', icon: 'none' });
      params.scheduledAt = ts;
    }
    this.setData({ submitting: true });
    try {
      await callWithToast('draft', Object.assign({ action: 'save' }, params), { loading: true, loadingText: '保存中…' });
      wx.showToast({ title: '已存入草稿箱', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      // 错误已由 callWithToast 提示
    } finally {
      this.setData({ submitting: false });
    }
  },

  // ---- AI 评定建议 ----
  askAI() {
    const d = this.data;
    if (!d.title || d.title.trim().length < 2) return wx.showToast({ title: '先填写标题', icon: 'none' });
    if (!d.activeCategory) return wx.showToast({ title: '先选择分类', icon: 'none' });
    callWithToast('aiAssistant', {
      action: 'assess',
      title: d.title.trim(),
      description: d.description.trim(),
      categoryId: d.activeCategory.code,
      amount: Number(d.amount) || 0,
      currency: d.currency
    }, { loading: true, loadingText: 'AI 评定中…' })
      .then((r) => {
        this.setData({ assessResult: r });
        wx.showToast({ title: `建议 ${r.suggestStar} 星`, icon: 'none' });
      })
      .catch(() => {});
  },

  // ---- 提交 ----
  async submit() {
    const d = this.data;
    if (d.submitting) return;
    if (d.title.trim().length < 2) return wx.showToast({ title: '标题需 2-30 字', icon: 'none' });
    if (!d.activeCategory) return wx.showToast({ title: '请选择分类', icon: 'none' });
    const amt = Number(d.amount);
    if (!Number.isInteger(amt) || amt <= 0) return wx.showToast({ title: '请输入委托金额', icon: 'none' });
    if (d.currency === 'silver' && amt < 10) return wx.showToast({ title: '白银委托最低 10 银', icon: 'none' });
    if (d.currency === 'gold' && amt < 1) return wx.showToast({ title: '黄金委托最低 1 金', icon: 'none' });
    const cat = d.activeCategory;
    const sub = d.subIndex >= 0 ? cat.sub[d.subIndex] : null;
    // 公共模式参数校验（mode 必须随请求下发，否则服务端默认为私人模式）
    const publicParams = { mode: d.mode };
    if (d.mode === 'public') {
      const min = Number(d.minAcceptors);
      const max = Number(d.maxAcceptors);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < 1 || max > 10) {
        return wx.showToast({ title: '合作人数需为 1-10 的整数', icon: 'none' });
      }
      if (min > max) return wx.showToast({ title: '最少人数不能大于最多人数', icon: 'none' });
      publicParams.minAcceptors = min;
      publicParams.maxAcceptors = max;
      publicParams.splitMode = d.splitMode;
    }

    // 定时发布校验
    let publishAt;
    if (d.publishMode === 'scheduled') {
      const ts = new Date(`${d.publishDate} ${d.publishTime}`).getTime();
      if (isNaN(ts)) return wx.showToast({ title: '发布时间不合法', icon: 'none' });
      if (ts <= Date.now()) return wx.showToast({ title: '发布时间需晚于当前时间', icon: 'none' });
      publishAt = ts;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '发布中…', mask: true });
    try {
      // 先上传图片到云存储，拿 fileID
      let fileIDs = [];
      if (d.images.length) {
        fileIDs = await Promise.all(d.images.map((path, i) =>
          wx.cloud.uploadFile({
            cloudPath: `commissions/${Date.now()}-${i}-${Math.floor(Math.random() * 1e6)}.jpg`,
            filePath: path
          }).then((r) => r.fileID)
        ));
      }
      const data = {
        title: d.title.trim(),
        description: d.description.trim(),
        categoryId: cat.code,
        subCategory: sub ? sub.code : '',
        region: d.region,
        amount: amt,
        currency: d.currency,
        deadline: d.deadlineTs || undefined,
        publishAt,
        images: fileIDs,
        ...publicParams
      };
      await callWithToast('commissionCreate', data);
      await refreshUser();
      wx.hideLoading();
      wx.showToast({ title: '委托已发布', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: '/pages/list/list' }), 600);
    } catch (e) {
      wx.hideLoading();
    } finally {
      this.setData({ submitting: false });
    }
  }
});
