// user-home —— 个人主页：三值雷达三角图（canvas）+ 统计 + 完成记录 + 隐私开关
// 他人视角尊重隐私开关；本人视角含隐私设置
const { call, callWithToast } = require('../../utils/api');
const { ensureLogin } = require('../../utils/auth');
const { resolveCloudUrls } = require('../../utils/cloud-img');
const { formatAmount } = require('../../utils/format');

Page({
  data: {
    profile: null,
    loading: true
  },

  onLoad(options) {
    this.setData({ targetId: options.userId || '' });
  },

  onShow() {
    ensureLogin().then(() => this.fetch());
  },

  fetch() {
    this.setData({ loading: true });
    return call('useItem', { action: 'userProfile', userId: this.data.targetId })
      .then(async (data) => {
        const p = data.profile;
        // 展示字段
        p.completedList = (p.completedList || []).map((c) => Object.assign({}, c, {
          amountText: formatAmount(c.amount, c.currency)
        }));
        // 云存储头像 → 临时链接；失败则隐藏（占位头像），不渲染原始 cloud://
        if (p.avatarUrl) {
          const map = await resolveCloudUrls([p.avatarUrl]);
          p.avatarUrl = map[p.avatarUrl] || (p.avatarUrl.startsWith('cloud://') ? '' : p.avatarUrl);
        }
        this.setData({ profile: p });
        // 数据就绪后画三角图（需等 canvas 渲染）
        if (p.rep !== null) {
          wx.nextTick(() => setTimeout(() => this.drawTriangle(), 60));
        }
      })
      .catch(() => {})
      .finally(() => this.setData({ loading: false }));
  },

  // 三值雷达三角图（canvas 2d，纯手绘）
  drawTriangle() {
    const query = wx.createSelectorQuery().in(this);
    query.select('#radar').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = (wx.getSystemInfoSync().pixelRatio || 2);
      canvas.width = res[0].width * dpr;
      canvas.height = res[0].height * dpr;
      ctx.scale(dpr, dpr);
      const W = res[0].width;
      const H = res[0].height;
      const cx = W / 2;
      const cy = H / 2 + 14;
      const R = Math.min(W, H) / 2 - 46;
      const p = this.data.profile;
      const vals = [p.rep || 0, p.fame || 0, p.skill || 0];
      // 三个顶点角度：上（信誉）、右下（名望）、左下（能力）
      const angles = [-90, 30, 150].map((a) => (a * Math.PI) / 180);
      const pt = (i, r) => ({
        x: cx + r * Math.cos(angles[i]),
        y: cy + r * Math.sin(angles[i])
      });

      // 网格层（250/500/750/1000）
      [250, 500, 750, 1000].forEach((lv) => {
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const q = pt(i, (R * lv) / 1000);
          if (i === 0) ctx.moveTo(q.x, q.y);
          else ctx.lineTo(q.x, q.y);
        }
        ctx.closePath();
        ctx.strokeStyle = 'rgba(28, 28, 30, 0.08)';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
      // 轴线
      angles.forEach((a) => {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a));
        ctx.strokeStyle = 'rgba(28, 28, 30, 0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
      // 数据多边形（渐变填充）
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const q = pt(i, (R * vals[i]) / 1000);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, 'rgba(201, 162, 39, 0.45)');
      grad.addColorStop(1, 'rgba(194, 75, 58, 0.32)');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(201, 162, 39, 0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // 数据顶点
      for (let i = 0; i < 3; i++) {
        const q = pt(i, (R * vals[i]) / 1000);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#C9A227';
        ctx.fill();
      }
      // 标签
      const labels = [
        { t: `信誉 ${vals[0]}`, x: cx, y: cy - R - 22, align: 'center' },
        { t: `名望 ${vals[1]}`, x: cx + R + 16, y: cy + 14, align: 'left' },
        { t: `能力 ${vals[2]}`, x: cx - R - 16, y: cy + 14, align: 'right' }
      ];
      ctx.font = '12px sans-serif';
      labels.forEach((l) => {
        ctx.fillStyle = '#6E6E73';
        ctx.textAlign = l.align;
        ctx.fillText(l.t, l.x, l.y);
      });
    });
  },

  // ---- 隐私开关（仅本人） ----
  onPrivacyChange(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    const p = this.data.profile;
    p.privacy[key] = value;
    this.setData({ 'profile.privacy': p.privacy });
    callWithToast('useItem', { action: 'updatePrivacy', privacy: { [key]: value } })
      .then((r) => {
        this.setData({ 'profile.privacy': r.privacy });
      })
      .catch(() => this.fetch());
  },

  // ---- 联系 ta（客服功能，阶段 5 接入） ----
  contactTa() {
    const p = this.data.profile;
    if (!p || p.isSelf) return;
    callWithToast('chat', {
      action: 'createByPair',
      otherUserId: this.data.targetId
    }, { loading: true, loadingText: '建立会话…' })
      .then((r) => {
        wx.navigateTo({
          url: `/pages/chat/chat?conversationId=${r.conversationId}&otherName=${encodeURIComponent(p.nickname || '对方')}`
        });
      })
      .catch(() => {});
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
  goReviews() {
    wx.navigateTo({ url: `/pages/review/review?mode=mine&userId=${this.data.profile && this.data.profile.userId ? '' : ''}` });
  }
});
