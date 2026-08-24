// home —— 主页：无任何杂项，仅四个玻璃按钮
// 上方两个竖排矩形按钮：发布委托 / 寻找委托；下方两个圆形按钮：AI 助手 / 我的
Page({
  goPublish() {
    wx.navigateTo({ url: '/pages/publish/publish' });
  },
  goList() {
    wx.navigateTo({ url: '/pages/list/list' });
  },
  goAI() {
    wx.navigateTo({ url: '/pages/ai/ai' });
  },
  goMine() {
    wx.navigateTo({ url: '/pages/mine/mine' });
  }
});
