// admin —— 管理面板：委托/用户/聊天/草稿/流水/公告/日志（仅 adminLevel>=1 可见入口）
const { call, callWithToast } = require('../../utils/api');
const { formatDateTime } = require('../../utils/format');

Page({
  data: {
    tab: 'commission',
    tabs: [
      { key: 'commission', label: '📋 委托' },
      { key: 'user', label: '👤 用户' },
      { key: 'chat', label: '💬 聊天' },
      { key: 'draft', label: '📝 草稿' },
      { key: 'tx', label: '💸 流水' },
      { key: 'finance', label: '📊 财报' },
      { key: 'announce', label: '📢 公告' },
      { key: 'log', label: '📜 日志' }
    ],
    keyword: '',
    list: [],
    announces: [],
    announceText: '',
    loading: false,
    finance: null,
    needSearch: true,
    searchPlaceholder: '委托编号或标题'
  },

  onShow() {
    this.doSearch();
    if (this.data.tab === 'announce') this.fetchAnnounces();
    if (this.data.tab === 'log') this.fetchLogs();
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.key;
    this.setData({ keyword: '', openChatId: '', openTxId: '', openLogId: '' });
    const SEARCH_CONF = {
      commission: ['委托编号或标题', true],
      user: ['用户 ID 或昵称', true],
      chat: ['委托标题或 ID（留空查全部）', true],
      draft: ['用户 ID（openid）', true],
      tx: ['用户 ID（留空查全部流水）', true],
      finance: ['', false],
      announce: ['', false],
      log: ['', false]
    };
    const [ph, need] = SEARCH_CONF[tab] || ['', false];
    this.setData({ tab, list: [], searchPlaceholder: ph, needSearch: need });
    if (this.data.tab === 'announce') { this.fetchAnnounces(); return; }
    if (this.data.tab === 'log') { this.fetchLogs(); return; }
    if (this.data.tab === 'finance') { this.fetchFinance(); return; }
    if (this.data.tab === 'tx') { this.doSearch(); return; } // 流水自动加载全部
    this.doSearch();
  },


  onKeyword(e) { this.setData({ keyword: e.detail.value }); },

  // 聊天：点开会话查看完整消息
  openChat(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.openChatId === id) {
      this.setData({ openChatId: '', openMessages: [], openChatTitle: '' });
      return;
    }
    call('admin', { action: 'chatMessages', conversationId: id })
      .then((d) => {
        const list = (d.messages || []).map((m) => Object.assign({}, m, {
          timeText: formatDateTime(m.createdAt)
        }));
        this.setData({
          openChatId: id,
          openMessages: list,
          openChatTitle: (d.conversation && d.conversation.commissionTitle) || ''
        });
      })
      .catch(() => {});
  },
  onAnnounceInput(e) { this.setData({ announceText: e.detail.value }); },

  doSearch() {
    const t = this.data.tab;
    if (!this.data.needSearch) return;
    const kw = this.data.keyword.trim();
    if (t !== 'chat' && t !== 'tx' && !kw) {
      return wx.showToast({ title: '请输入查询关键词', icon: 'none' });
    }
    this.setData({ loading: true });
    const actionMap = {
      commission: ['commissionList', {}],
      user: ['userSearch', {}],
      chat: ['listChats', {}],
      draft: ['listDrafts', { userId: kw }],
      tx: ['listTransactions', { userId: kw }]
    };
    const [action, extra] = actionMap[t];
    call('admin', Object.assign({ action, keyword: kw }, extra))
      .then((data) => {
        const list = (data.list || []).map((x) => Object.assign({}, x, {
          timeText: formatDateTime(x.createdAt || x.lastAt),
          detailText: x.detail ? JSON.stringify(x.detail) : ''
        }));
        this.setData({ list });
      })
      .catch(() => {})
      .finally(() => this.setData({ loading: false }));
  },

  // ===== 委托操作 =====
  doPin(e) {
    const id = e.currentTarget.dataset.id;
    callWithToast('admin', { action: 'forcePin', commissionId: id }, { loading: true })
      .then(() => wx.showToast({ title: '已置顶 24 小时', icon: 'success' }))
      .catch(() => {});
  },
  doChangeAmount(e) {
    const id = e.currentTarget.dataset.id;
    const cur = e.currentTarget.dataset.amount;
    wx.showModal({
      title: '修改委托金额',
      editable: true,
      content: String(cur),
      placeholderText: '输入新金额（整数）',
      confirmText: '修改',
      success: (res) => {
        if (!res.confirm) return;
        const amt = Number(res.content);
        if (!Number.isInteger(amt) || amt < 1) return wx.showToast({ title: '金额须为正整数', icon: 'none' });
        callWithToast('admin', { action: 'changeAmount', commissionId: id, amount: amt }, { loading: true })
          .then(() => { wx.showToast({ title: '金额已修改', icon: 'success' }); this.doSearch(); })
          .catch(() => {});
      }
    });
  },
  doDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ['退款给发布者（推荐）', '结算给接单者', '没收至平台（违规）'],
      success: (res) => {
        const mode = ['refund', 'settle', 'confiscate'][res.tapIndex];
        wx.showModal({
          title: '确认删除委托',
          content: `将执行「${['全额退款', '结算', '没收'][res.tapIndex]}」处理，操作会记录审计日志。`,
          confirmText: '确认执行',
          success: (r2) => {
            if (!r2.confirm) return;
            callWithToast('admin', { action: 'commissionDelete', commissionId: id, mode }, { loading: true, loadingText: '执行中…' })
              .then(() => { wx.showToast({ title: '已执行', icon: 'success' }); this.doSearch(); })
              .catch(() => {});
          }
        });
      }
    });
  },

  // ===== 用户操作 =====
  doBan(e) {
    const { id, type, days } = e.currentTarget.dataset;
    wx.showModal({
      title: type === 'publish' ? '暂停发布' : '禁言',
      editable: true,
      placeholderText: '处罚原因（可选）',
      confirmText: '执行',
      success: (res) => {
        if (!res.confirm) return;
        callWithToast('admin', {
          action: 'userBan', userId: id, type, days: Number(days), reason: res.content || ''
        }, { loading: true })
          .then(() => wx.showToast({ title: '已执行', icon: 'success' }))
          .catch(() => {});
      }
    });
  },
  doBanAccount(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '封禁账号',
      content: '封禁后该账号无法进行任何操作，确定？',
      confirmText: '封禁',
      success: (res) => {
        if (res.confirm) {
          callWithToast('admin', { action: 'userBan', userId: id, type: 'account' }, { loading: true })
            .then(() => { wx.showToast({ title: '已封禁', icon: 'none' }); this.doSearch(); })
            .catch(() => {});
        }
      }
    });
  },
  doUnban(e) {
    const id = e.currentTarget.dataset.id;
    callWithToast('admin', { action: 'userUnban', userId: id }, { loading: true })
      .then(() => { wx.showToast({ title: '已解封', icon: 'success' }); this.doSearch(); })
      .catch(() => {});
  },

  // 流水详情展开
  openTx(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ openTxId: this.data.openTxId === id ? '' : id });
  },
  // 日志详情展开
  openLog(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ openLogId: this.data.openLogId === id ? '' : id });
  },

  // ===== 公告 =====
  fetchAnnounces() {
    call('admin', { action: 'announcementList' })
      .then((d) => this.setData({ announces: d.list || [] }))
      .catch(() => {});
  },
  doAnnounce(e) {
    const hours = Number(e.currentTarget.dataset.hours);
    const text = this.data.announceText.trim();
    if (!text) return wx.showToast({ title: '请填写公告内容', icon: 'none' });
    callWithToast('admin', { action: 'announcementCreate', content: text, expireHours: hours }, { loading: true })
      .then(() => {
        this.setData({ announceText: '' });
        wx.showToast({ title: '公告已发布', icon: 'success' });
        this.fetchAnnounces();
      })
      .catch(() => {});
  },

  // ===== 日志 =====
  fetchLogs() {
    this.setData({ loading: true });
    call('admin', { action: 'logList' })
      .then((d) => {
        this.setData({
          list: (d.list || []).map((x) => Object.assign({}, x, { timeText: formatDateTime(x.createdAt) }))
        });
      })
      .catch(() => {})
      .finally(() => this.setData({ loading: false }));
  },

// ===== 财报看板 =====
fetchFinance() {
  this.setData({ loading: true });
  call('admin', { action: 'dashboard' })
    .then((d) => {
      this.setData({ finance: d });
      wx.nextTick(() => setTimeout(() => {
        this.drawLineChart(d.daily);
        this.drawBarChart(d.daily);
        this.drawPieChart(d.catDist);
      }, 80));
    })
    .catch(() => {})
    .finally(() => this.setData({ loading: false }));
},

setupCanvas(id, cb) {
  wx.createSelectorQuery().in(this).select(id).fields({ node: true, size: true }).exec((res) => {
    if (!res || !res[0] || !res[0].node) return;
    const canvas = res[0].node;
    const ctx = canvas.getContext('2d');
    const dpr = wx.getSystemInfoSync().pixelRatio || 2;
    canvas.width = res[0].width * dpr;
    canvas.height = res[0].height * dpr;
    ctx.scale(dpr, dpr);
    cb(ctx, res[0].width, res[0].height);
  });
},

// 折线图：近 14 天平台收入（金线）+ 充值（蓝线）
drawLineChart(daily) {
  this.setupCanvas('#chart-line', (ctx, W, H) => {
    const data = daily || [];
    if (!data.length) return;
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 34, r: 10, t: 14, b: 24 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const maxV = Math.max(10, ...data.map((x) => Math.max(x.fee || 0, x.recharge || 0)));
    const x = (i) => pad.l + (data.length === 1 ? iw / 2 : (iw * i) / (data.length - 1));
    const y = (v) => pad.t + ih - (v / maxV) * ih;
    // 网格
    ctx.strokeStyle = 'rgba(28,28,30,0.08)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 3; g++) {
      ctx.beginPath();
      ctx.moveTo(pad.l, pad.t + (ih * g) / 3);
      ctx.lineTo(W - pad.r, pad.t + (ih * g) / 3);
      ctx.stroke();
    }
    const lines = [
      { key: 'fee', color: '#C9A227' },
      { key: 'recharge', color: '#4A7BD0' }
    ];
    lines.forEach((ln) => {
      ctx.beginPath();
      data.forEach((pt, i) => {
        i === 0 ? ctx.moveTo(x(i), y(pt[ln.key] || 0)) : ctx.lineTo(x(i), y(pt[ln.key] || 0));
      });
      ctx.strokeStyle = ln.color;
      ctx.lineWidth = 2;
      ctx.stroke();
    });
    // X 轴标签（隔天）
    ctx.fillStyle = 'rgba(28,28,30,0.4)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    data.forEach((pt, i) => {
      if (i % 2 === 0) ctx.fillText(pt.date, x(i), H - 8);
    });
  });
},

// 柱状图：近 14 天新增委托数
drawBarChart(daily) {
  this.setupCanvas('#chart-bar', (ctx, W, H) => {
    const data = daily || [];
    if (!data.length) return;
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 24, r: 10, t: 14, b: 24 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const maxV = Math.max(1, ...data.map((x) => x.commissions || 0));
    const bw = iw / data.length;
    data.forEach((pt, i) => {
      const h = ((pt.commissions || 0) / maxV) * ih;
      const bx = pad.l + i * bw + bw * 0.2;
      ctx.fillStyle = i % 2 === 0 ? '#4A7BD0' : '#8EADF0';
      ctx.fillRect(bx, pad.t + ih - h, bw * 0.6, h);
    });
    ctx.fillStyle = 'rgba(28,28,30,0.4)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    data.forEach((pt, i) => {
      if (i % 2 === 0) ctx.fillText(pt.date, pad.l + i * bw + bw / 2, H - 8);
    });
  });
},

// 饼图：委托分类占比
drawPieChart(catDist) {
  this.setupCanvas('#chart-pie', (ctx, W, H) => {
    const data = (catDist || []).slice(0, 6);
    if (!data.length) return;
    ctx.clearRect(0, 0, W, H);
    const colors = ['#C9A227', '#C24B3A', '#4A7BD0', '#3BA55D', '#8E5FD0', '#E8833A'];
    const cx = W * 0.3;
    const cy = H / 2;
    const R = Math.min(W * 0.26, H / 2 - 14);
    const total = data.reduce((a, x) => a + x.count, 0);
    let angle = -Math.PI / 2;
    data.forEach((d, i) => {
      const a2 = angle + (d.count / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, angle, a2);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      angle = a2;
    });
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.fillStyle = '#1C1C1E';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(total), cx, cy + 4);
    // 图例（含中文分类名：色块 + 名称 + 占比）
    ctx.textAlign = 'left';
    ctx.font = '10px sans-serif';
    const catMap = {};
    require('../../config/constants').CATEGORIES.forEach((c) => { catMap[c.code] = c.name; });
    data.forEach((d, i) => {
      const ly = 18 + i * 18;
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(W * 0.60, ly - 8, 10, 10);
      ctx.fillStyle = '#1C1C1E';
      const name = (catMap[d.categoryId] || d.categoryId).slice(0, 5);
      ctx.fillText(name + ' ' + ((d.count / total) * 100).toFixed(0) + '%', W * 0.60 + 15, ly);
    });
    // 饼块上直接标注分类名（引线 + 中文）
    angle = -Math.PI / 2;
    data.forEach((d, i) => {
      const mid = angle + (d.count / total) * Math.PI;
      const pct = (d.count / total) * 100;
      if (pct < 5) { angle += (d.count / total) * Math.PI * 2; return; } // 太小的块不标注
      const lx = cx + Math.cos(mid) * R * 0.65;
      const ly2 = cy + Math.sin(mid) * R * 0.65;
      const ex = cx + Math.cos(mid) * (R + 10);
      const ey = cy + Math.sin(mid) * (R + 10);
      ctx.beginPath();
      ctx.moveTo(lx, ly2);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = colors[i % colors.length];
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#1C1C1E';
      ctx.font = '9px sans-serif';
      const name = catMap[d.categoryId] || d.categoryId;
      ctx.textAlign = Math.cos(mid) > 0 ? 'left' : 'right';
      ctx.fillText(name, ex + (Math.cos(mid) > 0 ? 2 : -2), ey + 3);
      angle += (d.count / total) * Math.PI * 2;
    });
  });
},
});
