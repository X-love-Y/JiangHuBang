// detail —— 委托详情：状态时间线 + 按身份/状态渲染操作区 + AI 方案 + 道具使用
const { call, callWithToast } = require('../../utils/api');
const { ensureLogin, refreshUser } = require('../../utils/auth');
const { STATUS, CATEGORIES } = require('../../config/constants');
const { formatAmount, formatDateTime, formatRegion } = require('../../utils/format');

Page({
  data: {
    id: '',
    me: null,
    c: null,
    isPublisher: false,
    isAcceptor: false,
    timeline: [],

    // 背包中可用于本委托的道具
    myBag: [],

    // 凭证编辑器
    proofEditorOpen: false,
    proofText: '',
    proofImages: [],

    // AI 方案
    aiLoading: false,
    aiSolution: null,
    aiMock: false,

    // 通用确认弹窗
    dialog: { show: false, title: '', content: '', confirmText: '确认', danger: false, key: '' },
    // 公共模式顶层字段（WXML 模板直接引用）
    requests: [],
    acceptors: [],
    myRequestStatus: '',
    myAcceptorIdx: -1,
    pendingCount: 0,
    expandedAcceptorIdx: -1 // 展开查看凭证的合作者下标
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
  },

  onShow() {
    ensureLogin().then((u) => {
      this.setData({ me: u });
      this.fetch();
    });
    this.fetchBag();
  },

  // ===== 数据加载 =====
  fetch() {
    return call('commissionList', { id: this.data.id })
      .then((data) => {
        const c = data.detail;
        // 云存储 fileID → 临时 https 链接（部分基础库渲染 cloud:// 图片失败）
        return this.resolveCloudImages(c).then(() => this.renderCommission(c));
      })
      .catch(() => {});
  },

  // 批量把云存储 fileID 转成临时链接（头像/委托图/凭证图/合作者凭证图）
  resolveCloudImages(c) {
    const fileIds = [];
    (c.images || []).forEach((f) => { if (typeof f === 'string' && f.startsWith('cloud://')) fileIds.push(f); });
    (c.proofImages || []).forEach((f) => { if (typeof f === 'string' && f.startsWith('cloud://')) fileIds.push(f); });
    (c.acceptors || []).forEach((a) => {
      (a.proofImages || []).forEach((f) => { if (typeof f === 'string' && f.startsWith('cloud://')) fileIds.push(f); });
    });
    if (c.publisher && typeof c.publisher.avatarUrl === 'string' && c.publisher.avatarUrl.startsWith('cloud://')) {
      fileIds.push(c.publisher.avatarUrl);
    }
    if (c.acceptor && typeof c.acceptor.avatarUrl === 'string' && c.acceptor.avatarUrl.startsWith('cloud://')) {
      fileIds.push(c.acceptor.avatarUrl);
    }
    if (!fileIds.length) return Promise.resolve();
    return wx.cloud.getTempFileURL({ fileList: fileIds })
      .then((res) => {
        const map = {};
        (res.fileList || []).forEach((f) => {
          if (f.status === 0 && f.tempFileURL) map[f.fileID] = f.tempFileURL;
        });
        this._cloudMap = map;
      })
      .catch(() => {});
  },

  cloudUrl(fid) {
    if (!fid) return '';
    if (typeof fid !== 'string' || !fid.startsWith('cloud://')) return fid;
    // 转换失败时返回空串（显示占位），绝不把原始 cloud:// 交给渲染层
    return (this._cloudMap && this._cloudMap[fid]) || '';
  },

  renderCommission(c) {
    const cat = CATEGORIES.find((x) => x.code === c.categoryId) || {};
    const me = this.data.me;
    const deadTs = c.deadline ? new Date(c.deadline).getTime() : 0;
    const isExpired = c.status === 'pending' && deadTs > 0 && deadTs < Date.now();
    const displayStatus = isExpired ? 'expired' : c.status;
    // 公共模式：申请/合作者信息
    const requests = (c.requests || []).map((r) => Object.assign({}, r, {
      timeText: formatDateTime(r.at)
    }));
    const acceptors = c.acceptors || [];
    let myRequestStatus = '';
    if (me && requests.length) {
      const mine = requests.find((r) => r.userId === me._id);
      if (mine) myRequestStatus = mine.status;
    }
    let myAcceptorIdx = -1;
    if (me) {
      myAcceptorIdx = acceptors.findIndex((a) => a.userId === me._id);
    }
    const pendingCount = requests.filter((r) => r.status === 'pending').length;
    this.setData({
      c: Object.assign({}, c, {
        catName: cat.name || '',
        catIcon: cat.icon || '🏷️',
        amountText: formatAmount(c.amount, c.currency),
        regionText: formatRegion(c.region),
        createdText: formatDateTime(c.createdAt),
        deadlineText: formatDateTime(c.deadline),
        statusConf: STATUS[displayStatus] || STATUS.pending,
        isExpired,
        displayStatus
      }),
      // 公共模式字段放顶层，WXML 直接用 {{requests}} 等引用
      requests,
      acceptors,
      myRequestStatus,
      myAcceptorIdx,
      pendingCount,
      isPublisher: me ? c.publisherId === me._id : false,
      isAcceptor: me ? c.acceptorId === me._id : false,
      timeline: buildTimeline(c),
      proofEditorOpen: false
    });
  },

  fetchBag() {
    call('useItem', { action: 'myBag' })
      .then((data) => {
        const usable = (data.bag || []).filter(
          (b) => b.remaining > 0 && ['trumpet', 'boost24', 'push'].includes(b.itemId)
        );
        this.setData({ myBag: usable });
      })
      .catch(() => {});
  },

  // ===== 操作 =====
  askAccept() {
    const c = this.data.c;
    this.setData({
      dialog: {
        show: true,
        title: '接下委托',
        content: `接单后请与发布者保持联系，按时完成并提交凭证。确认接下「${c.title}」？`,
        confirmText: '接下委托',
        danger: false,
        key: 'accept'
      }
    });
  },
  askGiveUp() {
    this.setData({
      dialog: {
        show: true,
        title: '放弃委托',
        content: '放弃后委托将回到大厅。24 小时内放弃 3 次会封禁接单权 24 小时。',
        confirmText: '放弃',
        danger: true,
        key: 'giveUp'
      }
    });
  },
  askCancel() {
    this.setData({
      dialog: {
        show: true,
        title: '取消委托',
        content: '取消后托管金额将全额退回你的账户。确认取消？',
        confirmText: '取消委托',
        danger: true,
        key: 'cancel'
      }
    });
  },
  askConfirm() {
    this.setData({
      dialog: {
        show: true,
        title: '确认完成',
        content: '确认后将结算委托：扣除 1% 中介费，剩余金额转给完成者。此操作不可撤销。',
        confirmText: '确认完成',
        danger: false,
        key: 'confirm'
      }
    });
  },
  askAI() {
    const c = this.data.c;
    this.setData({
      dialog: {
        show: true,
        title: 'AI 解决方案',
        content: `AI 将为「${c.title}」生成完成方案（背景分析/执行步骤/风险提示/成本预估）。非月卡用户每次消耗 20 白银。`,
        confirmText: '生成方案',
        danger: false,
        key: 'ai'
      }
    });
  },
  onDialogConfirm() {
    const key = this.data.dialog.key;
    this.setData({ 'dialog.show': false });
    const actions = {
      accept: () => this.doAccept(),
      giveUp: () => this.doGiveUp(),
      cancel: () => this.doCancel(),
      confirm: () => this.doConfirm(),
      ai: () => this.doAI()
    };
    if (actions[key]) actions[key]();
  },
  onDialogCancel() {
    this.setData({ 'dialog.show': false });
  },

  doAccept() {
    callWithToast('acceptCommission', { commissionId: this.data.id }, { loading: true, loadingText: '接单中…' })
      .then(() => {
        refreshUser();
        wx.showToast({ title: '接单成功', icon: 'success' });
        this.fetch();
      })
      .catch(() => {});
  },
  doGiveUp() {
    callWithToast('cancelCommission', { commissionId: this.data.id, action: 'giveUp' }, { loading: true })
      .then((r) => {
        refreshUser();
        wx.showToast({ title: r.banned ? '放弃成功，接单权被暂封' : '已放弃', icon: 'none' });
        this.fetch();
      })
      .catch(() => {});
  },
  doCancel() {
    callWithToast('cancelCommission', { commissionId: this.data.id, action: 'cancel', reason: '发布者取消' }, { loading: true })
      .then(() => {
        refreshUser();
        // 长文案用无图标模式：支持两行完整显示（带图标会被截断）
        wx.showToast({ title: '已取消，金额已退还', icon: 'none' });
        this.fetch();
      })
      .catch(() => {});
  },
  doConfirm() {
    callWithToast('confirmCommission', { commissionId: this.data.id }, { loading: true, loadingText: '结算中…' })
      .then((r) => {
        refreshUser();
        wx.showToast({ title: r.settled ? '已结算' : '已确认，等待对方', icon: 'success' });
        this.fetch();
      })
      .catch(() => {});
  },
  doAI() {
    this.setData({ aiLoading: true });
    call('aiAssistant', { action: 'solution', commissionId: this.data.id })
      .then((r) => {
        refreshUser();
        this.setData({ aiSolution: r.text, aiMock: r.mock });
      })
      .catch((e) => {
        if (e && e.silent) wx.showToast({ title: e.message, icon: 'none' });
      })
      .finally(() => this.setData({ aiLoading: false }));
  },

  // ===== 客服会话入口 =====
  goChat() {
    const c = this.data.c;
    callWithToast('chat', { action: 'create', commissionId: c._id }, { loading: true, loadingText: '建立会话…' })
      .then((r) => {
        const name = (c.publisher && c.publisher.nickname) || '对方';
        wx.navigateTo({
          url: `/pages/chat/chat?conversationId=${r.conversationId}&otherName=${encodeURIComponent(name)}`
        });
      })
      .catch(() => {});
  },

  // ===== 个人主页 / 评价入口 =====
  goPublisherHome() {
    const c = this.data.c;
    if (c && c.publisherId) {
      wx.navigateTo({ url: `/pages/user-home/user-home?userId=${c.publisherId}` });
    }
  },
  goReview(e) {
    const c = this.data.c;
    const userId = e.currentTarget.dataset.user;
    const name = e.currentTarget.dataset.name || '';
    wx.navigateTo({
      url: `/pages/review/review?commissionId=${c._id}&revieweeId=${userId}&name=${encodeURIComponent(name)}`
    });
  },

  // ===== 公共模式操作 =====
  askApply() {
    const c = this.data.c;
    wx.showModal({
      title: '申请合作',
      editable: true,
      placeholderText: '介绍一下你的优势（可选）',
      confirmText: '提交申请',
      success: (res) => {
        if (res.confirm) {
          callWithToast('acceptCommission', {
            commissionId: c._id,
            action: 'apply',
            message: res.content || ''
          }, { loading: true })
            .then((r) => {
              // 回显服务端实际写入的申请人数，便于当场核对同步
              wx.showToast({
                title: `申请已提交（共 ${r.requestCount || 1} 人申请）`,
                icon: 'none'
              });
              this.fetch();
            })
            .catch(() => {});
        }
      }
    });
  },
  doWithdraw() {
    const c = this.data.c;
    callWithToast('acceptCommission', { commissionId: c._id, action: 'withdraw' }, { loading: true })
      .then(() => {
        wx.showToast({ title: '已撤销申请', icon: 'none' });
        this.fetch();
      })
      .catch(() => {});
  },
  doApprove(e) {
    const c = this.data.c;
    const userId = e.currentTarget.dataset.user;
    if (c.splitMode === 'custom') {
      wx.showModal({
        title: '分账比例（单位：%）',
        editable: true,
        placeholderText: '1-100 的整数，如 60',
        confirmText: '批准',
        success: (res) => {
          if (res.confirm) {
            const v = Number(res.content);
            if (!Number.isInteger(v) || v < 1 || v > 100) {
              return wx.showToast({ title: '比例需为 1-100 的整数（%）', icon: 'none' });
            }
            callWithToast('acceptCommission', {
              commissionId: c._id, action: 'approve', userId, split: v
            }, { loading: true })
              .then(() => { wx.showToast({ title: '已批准', icon: 'success' }); this.fetch(); })
              .catch(() => {});
          }
        }
      });
    } else {
      callWithToast('acceptCommission', { commissionId: c._id, action: 'approve', userId }, { loading: true })
        .then(() => { wx.showToast({ title: '已批准', icon: 'success' }); this.fetch(); })
        .catch(() => {});
    }
  },
  doChangeSplit(e) {
    const c = this.data.c;
    const userId = e.currentTarget.dataset.user;
    const cur = Number(e.currentTarget.dataset.split) || 0;
    wx.showModal({
      title: '修改分账比例（单位：%）',
      editable: true,
      // 输入框初始内容只放当前数字（可直接改），提示词放占位符
      content: String(cur),
      placeholderText: '1-100 的整数（单位：%）',
      confirmText: '修改',
      success: (res) => {
        if (res.confirm) {
          const v = Number(res.content);
          if (!Number.isInteger(v) || v < 1 || v > 100) {
            return wx.showToast({ title: '比例需为 1-100 的整数（%）', icon: 'none' });
          }
          callWithToast('acceptCommission', {
            commissionId: c._id, action: 'updateSplit', userId, split: v
          }, { loading: true })
            .then((r) => {
              wx.showToast({ title: `已修改（总和 ${r.sum}%）`, icon: 'none' });
              this.fetch();
            })
            .catch(() => {});
        }
      }
    });
  },
  doReject(e) {
    const c = this.data.c;
    const userId = e.currentTarget.dataset.user;
    callWithToast('acceptCommission', { commissionId: c._id, action: 'reject', userId }, { loading: true })
      .then(() => { wx.showToast({ title: '已拒绝', icon: 'none' }); this.fetch(); })
      .catch(() => {});
  },
  // 展开/收起合作者凭证
  toggleAcceptorProof(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({
      expandedAcceptorIdx: this.data.expandedAcceptorIdx === i ? -1 : i
    });
  },
  // 预览合作者凭证图片
  previewAcceptorProof(e) {
    const ai = Number(e.currentTarget.dataset.ai);
    const img = e.currentTarget.dataset.img;
    const ac = this.data.acceptors[ai];
    if (!ac) return;
    const urls = (ac.proofImages || []).map((f) => this.cloudUrl(f));
    wx.previewImage({ urls, current: this.cloudUrl(img) });
  },

  doCommit() {
    const c = this.data.c;
    wx.showModal({
      title: '开始合作',
      content: `确认与已选定的 ${c.acceptors.length} 位合作者开始合作？其余申请将被婉拒。`,
      confirmText: '开始合作',
      success: (res) => {
        if (res.confirm) {
          callWithToast('acceptCommission', { commissionId: c._id, action: 'commitAcceptors' }, { loading: true })
            .then(() => { wx.showToast({ title: '合作已开始', icon: 'success' }); this.fetch(); })
            .catch(() => {});
        }
      }
    });
  },
  doConfirmAcceptor(e) {
    const c = this.data.c;
    const userId = e.currentTarget.dataset.user;
    callWithToast('confirmCommission', { commissionId: c._id, userId }, { loading: true })
      .then((r) => {
        refreshUser();
        wx.showToast({ title: r.settled ? '已结算' : '已确认', icon: 'success' });
        this.fetch();
      })
      .catch(() => {});
  },
  doConfirmAll() {
    const c = this.data.c;
    callWithToast('confirmCommission', { commissionId: c._id, all: true }, { loading: true, loadingText: '结算中…' })
      .then((r) => {
        refreshUser();
        wx.showToast({ title: r.settled ? '已结算' : '已确认全部', icon: 'success' });
        this.fetch();
      })
      .catch(() => {});
  },

  // ===== 道具 =====
  useItem(e) {
    const itemId = e.currentTarget.dataset.item;
    callWithToast('useItem', { action: 'use', itemId, commissionId: this.data.id }, { loading: true })
      .then((r) => {
        wx.showToast({ title: r.message || '使用成功', icon: 'none' });
        this.fetchBag();
        this.fetch();
      })
      .catch(() => {});
  },

  // ===== 凭证编辑 =====
  openProofEditor() {
    this.setData({ proofEditorOpen: true });
  },
  closeProofEditor() {
    this.setData({ proofEditorOpen: false });
  },
  onProofInput(e) {
    this.setData({ proofText: e.detail.value });
  },
  chooseProofImages() {
    const rest = 9 - this.data.proofImages.length;
    if (rest <= 0) return;
    wx.chooseMedia({
      count: rest,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        this.setData({ proofImages: this.data.proofImages.concat(paths) });
      }
    });
  },
  removeProofImage(e) {
    const i = Number(e.currentTarget.dataset.i);
    const images = this.data.proofImages.slice();
    images.splice(i, 1);
    this.setData({ proofImages: images });
  },
  previewProofImage(e) {
    const i = Number(e.currentTarget.dataset.i);
    wx.previewImage({ urls: this.data.proofImages, current: this.data.proofImages[i] });
  },
  async submitProof() {
    const d = this.data;
    if (!d.proofText.trim() && !d.proofImages.length) {
      return wx.showToast({ title: '请填写说明或上传凭证', icon: 'none' });
    }
    wx.showLoading({ title: '提交中…', mask: true });
    try {
      let fileIDs = [];
      if (d.proofImages.length) {
        fileIDs = await Promise.all(d.proofImages.map((path, i) =>
          wx.cloud.uploadFile({
            cloudPath: `proofs/${Date.now()}-${i}-${Math.floor(Math.random() * 1e6)}.jpg`,
            filePath: path
          }).then((r) => r.fileID)
        ));
      }
      await callWithToast('submitCommission', {
        commissionId: d.id,
        proof: { text: d.proofText.trim(), images: fileIDs }
      });
      wx.hideLoading();
      wx.showToast({ title: '凭证已提交', icon: 'success' });
      this.fetch();
    } catch (e) {
      wx.hideLoading();
    }
  },

  // ===== 图片预览 =====
  previewImages(e) {
    const i = Number(e.currentTarget.dataset.i);
    const c = this.data.c;
    wx.previewImage({ urls: c.images, current: c.images[i] });
  },
  previewProofs(e) {
    const i = Number(e.currentTarget.dataset.i);
    const c = this.data.c;
    wx.previewImage({ urls: c.proofImages, current: c.proofImages[i] });
  }
});

// 状态时间线
function buildTimeline(c) {
  if (c.status === 'scheduled') {
    return [
      { label: '创建委托', time: formatDateTime(c.createdAt), done: true },
      { label: '定时发布上架', time: formatDateTime(c.publishAt), done: false, end: true }
    ];
  }
  const items = [
    { label: '发布悬赏', time: formatDateTime(c.createdAt), done: true }
  ];
  if (c.status === 'cancelled' || c.status === 'expired') {
    items.push({
      label: c.status === 'cancelled' ? '委托取消' : '委托过期',
      time: formatDateTime(c.cancelAt),
      done: true,
      end: true
    });
    return items;
  }
  items.push({
    label: '侠士接单',
    time: formatDateTime(c.acceptedAt),
    done: !!c.acceptedAt
  });
  items.push({
    label: '提交凭证',
    time: formatDateTime(c.submittedAt),
    done: !!c.submittedAt
  });
  items.push({
    label: '完成结算',
    time: formatDateTime(c.settledAt),
    done: !!c.settledAt,
    end: true
  });
  return items;
}
