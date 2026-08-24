// recharge —— 扫码充值（模拟）：选档位 → 展示模拟收款码 → 确认支付 → scanRecharge 幂等入账
const { call, callWithToast } = require('../../utils/api');
const { RECHARGE_PLANS } = require('../../config/constants');

Page({
  data: {
    plans: RECHARGE_PLANS,
    activePlan: 0,
    orderNo: '',
    paid: false
  },

  onLoad() {
    this.setData({ orderNo: this.genOrderNo() });
    this.drawQr();
  },

  genOrderNo() {
    const d = new Date();
    return `QR${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getTime()).slice(-8)}`;
  },

  pickPlan(e) {
    this.setData({ activePlan: Number(e.currentTarget.dataset.i), paid: false, orderNo: this.genOrderNo() });
    this.drawQr();
  },

  // 画模拟收款码（占位图案 + 订单信息）
  drawQr() {
    const query = wx.createSelectorQuery().in(this);
    query.select('#qrcode').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getSystemInfoSync().pixelRatio || 2;
      const W = res[0].width;
      canvas.width = W * dpr;
      canvas.height = W * dpr;
      ctx.scale(dpr, dpr);
      const c = W / 2;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, W, W);
      // 模拟二维码格子
      const cell = W / 17;
      for (let r = 0; r < 17; r++) {
        for (let col = 0; col < 17; col++) {
          if ((r * 7 + col * 13) % 3 === 0) {
            ctx.fillStyle = '#1C1C1E';
            ctx.fillRect(col * cell + 2, r * cell + 2, cell - 4, cell - 4);
          }
        }
      }
      // 中央方块
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(c - cell * 1.5, c - cell * 1.5, cell * 3, cell * 3);
      ctx.fillStyle = '#C9A227';
      ctx.font = `${cell * 1.4}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('¥', c, c + cell * 0.5);
    });
  },

  doPay() {
    if (this.data.paid) return;
    const plan = this.data.plans[this.data.activePlan];
    callWithToast('wallet', {
      action: 'scanRecharge', plan: plan.rmb, orderNo: this.data.orderNo
    }, { loading: true, loadingText: '确认支付中…' })
      .then((r) => {
        this.setData({ paid: true });
        wx.showModal({
          title: '充值成功',
          content: `+${r.silver} 白银已到账，当前余额 ${r.balanceAfter} 银`,
          showCancel: false,
          success: () => wx.navigateBack()
        });
      })
      .catch(() => {});
  }
});
