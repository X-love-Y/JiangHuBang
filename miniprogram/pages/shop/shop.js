// shop —— 称号商城：称号/道具两栏，黄金购买，解锁条件 + 效果展示
const { call, callWithToast } = require('../../utils/api');
const { ensureLogin, refreshUser } = require('../../utils/auth');

const EFFECT_TEXT = {
  show: '',
  priority: (v) => `委托列表权重 +${v}`,
  feeDiscount: (v) => `中介费 ${v === 0.5 ? '减半(0.5%)' : `降至 ${(v * 100).toFixed(1)}%`}`,
  acceptBoost: (v) => `接单上限 +${v}`,
  publishBoost: (v) => `发布上限 +${v}`,
  broadcast: (v) => `广播/置顶 ${v} 小时`,
  push: (v) => `推送 ${v} 名匹配用户`,
  aiDaily: (v) => `${v} 天 AI 月卡`,
  priorityBoost: () => '24h 内发布权重 +50%'
};

function effectTexts(effect) {
  if (!effect) return ['无特殊效果'];
  const list = Array.isArray(effect) ? effect : [effect];
  return list
    .map((e) => EFFECT_TEXT[e.kind] ? EFFECT_TEXT[e.kind](e.value) : '')
    .filter(Boolean);
}

Page({
  data: {
    tab: 'title', // title | item
    items: [],
    user: { gold: 0, silver: 0, completed: 0 },
    dialog: { show: false, item: null, content: '' }
  },

  onShow() {
    ensureLogin().then(() => this.fetch());
  },

  fetch() {
    call('shopPurchase', { action: 'catalog' })
      .then((data) => {
        const items = (data.items || []).map((it) => Object.assign({}, it, {
          effects: effectTexts(it.effect),
          unlockText: it.unlock && it.unlock.value
            ? `解锁：累计完成 ${it.unlock.value} 单`
            : '',
          ownedText: it.type === 'title' ? '已拥有' : `背包 ×${it.bagCount}`
        }));
        this.setData({ items, user: data.user || this.data.user });
      })
      .catch(() => {});
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  askBuy(e) {
    const item = this.data.items.find((x) => x.itemId === e.currentTarget.dataset.id);
    if (!item) return;
    if (item.type === 'title' && item.owned) {
      return wx.showToast({ title: '已拥有该称号', icon: 'none' });
    }
    if (!item.unlocked) {
      return wx.showToast({ title: item.unlockText || '解锁条件未达成', icon: 'none' });
    }
    // 弹窗文案在 JS 拼好（WXML 表达式不支持 \n 转义）
    const content = `${item.icon} ${item.name} · ${item.price} 金\n${item.desc}`;
    this.setData({ dialog: { show: true, item, content } });
  },
  onDialogCancel() {
    this.setData({ 'dialog.show': false });
  },
  onDialogConfirm() {
    const item = this.data.dialog.item;
    this.setData({ 'dialog.show': false });
    if (!item) return;
    callWithToast('shopPurchase', { itemId: item.itemId }, { loading: true, loadingText: '购买中…' })
      .then(() => {
        refreshUser();
        wx.showToast({ title: '购买成功', icon: 'success' });
        this.fetch();
      })
      .catch((e) => {
        if (e && e.silent) wx.showToast({ title: e.message, icon: 'none' });
      });
  }
});
