// wallet —— 钱包：余额 + 充值（模拟/预留真支付）+ 兑换（1:100 双向不扣税）+ 流水
const { call, callWithToast } = require('../../utils/api');
const { ensureLogin, refreshUser } = require('../../utils/auth');
const { RECHARGE_PLANS, PAY_CHANNELS } = require('../../config/constants');
const { formatDateTime } = require('../../utils/format');

const TYPE_TEXT = {
  recharge: '充值', release: '完成收入', refund: '退款', fee: '中介费',
  escrow: '委托托管', exchange_out: '兑换支出', exchange_in: '兑换到账',
  consume: '消费支出'
};

Page({
  data: {
    user: null,
    rechargePlans: RECHARGE_PLANS,
    payChannels: PAY_CHANNELS,
    activePlan: 0,
    activeChannel: 'mock',
    // 兑换
    exchangeDir: 'toGold', // toGold: 银→金；toSilver: 金→银
    exchangeAmount: '',
    exchangePreview: '',
    // 流水
    txList: [],
    txPage: 1,
    txHasMore: true,
    txLoading: false
  },

  onShow() {
    ensureLogin().then(() => this.fetchAll());
  },

  fetchAll() {
    return Promise.all([this.fetchUser(), this.fetchTx(true)]);
  },

  fetchUser() {
    return refreshUser().then((u) => this.setData({ user: u }));
  },

  fetchTx(reset) {
    if (this.data.txLoading) return Promise.resolve();
    this.setData({ txLoading: true });
    const page = reset ? 1 : this.data.txPage + 1;
    return call('wallet', { action: 'transactions', page, pageSize: 20 })
      .then((data) => {
        const enriched = (data.list || []).map((t) => Object.assign({}, t, {
          typeText: TYPE_TEXT[t.type] || t.type,
          timeText: formatDateTime(t.createdAt),
          isPlus: t.amount > 0
        }));
        this.setData({
          txList: reset ? enriched : this.data.txList.concat(enriched),
          txPage: page,
          txHasMore: data.hasMore
        });
      })
      .catch(() => {})
      .finally(() => this.setData({ txLoading: false }));
  },

  // ===== 充值 =====
  pickPlan(e) {
    this.setData({ activePlan: Number(e.currentTarget.dataset.i) });
  },
  pickChannel(e) {
    this.setData({ activeChannel: e.currentTarget.dataset.code });
  },
  doRecharge() {
    const plan = this.data.rechargePlans[this.data.activePlan];
    const channel = this.data.activeChannel;
    callWithToast('wallet', { action: 'recharge', plan: plan.rmb, channel }, { loading: true, loadingText: '支付中…' })
      .then((r) => {
        this.fetchUser().then(() => this.fetchTx(true));
        wx.showToast({ title: `+${r.silver} 白银`, icon: 'success' });
      })
      .catch((e) => {
        if (e && e.silent) wx.showToast({ title: e.message, icon: 'none', duration: 2500 });
      });
  },

  // ===== 兑换 =====
  switchDir(e) {
    this.setData({ exchangeDir: e.currentTarget.dataset.dir });
    this.calcPreview();
  },
  onExchangeInput(e) {
    this.setData({ exchangeAmount: e.detail.value });
    this.calcPreview();
  },
  calcPreview() {
    const amt = Number(this.data.exchangeAmount);
    if (!Number.isInteger(amt) || amt <= 0) {
      this.setData({ exchangePreview: '' });
      return;
    }
    const dir = this.data.exchangeDir;
    this.setData({
      exchangePreview: dir === 'toGold'
        ? `${amt} 银 → ${amt / 100} 金`
        : `${amt} 金 → ${amt * 100} 银`
    });
  },
  doExchange() {
    const amt = Number(this.data.exchangeAmount);
    if (!Number.isInteger(amt) || amt <= 0) {
      return wx.showToast({ title: '请输入兑换数量', icon: 'none' });
    }
    if (this.data.exchangeDir === 'toGold' && amt % 100 !== 0) {
      return wx.showToast({ title: '白银须按 100 的整数倍兑换', icon: 'none' });
    }
    callWithToast('wallet', {
      action: 'exchange',
      direction: this.data.exchangeDir,
      amount: amt
    }, { loading: true, loadingText: '兑换中…' })
      .then((r) => {
        this.setData({ exchangeAmount: '', exchangePreview: '' });
        this.fetchUser().then(() => this.fetchTx(true));
        wx.showToast({ title: '兑换成功', icon: 'success' });
      })
      .catch((e) => {
        if (e && e.silent) wx.showToast({ title: e.message, icon: 'none' });
      });
  },

  onReachBottom() {
    if (this.data.txHasMore) this.fetchTx(false);
  }
});
