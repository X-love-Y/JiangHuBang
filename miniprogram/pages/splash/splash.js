// splash —— 启动加载页：竖排「生活…即是江湖…」逐字浮现，1.8s 后进入主页
// 首次启动先完成云端初始化（建集合/种子数据），再静默登录，避免时序竞争
const { ensureLogin } = require('../../utils/auth');
const { cronBoost } = require('../../utils/cron');

Page({
  data: {
    chars: ['生', '活', '…', '即', '是', '江', '湖', '…'],
    delays: [] // 逐字浮现 stagger
  },

  onLoad() {
    const delays = this.data.chars.map((_, i) => `${0.12 + i * 0.13}s`);
    this.setData({ delays });

    // 启动流程：云端初始化 → 静默登录（都不阻塞动画）
    this.bootstrap().finally(() => {
      ensureLogin().catch(() => {});
    });

    // 动画结束后进入主页
    // 用 reLaunch 清空页面栈：主页成为真正的根页面，避免热重载时栈残留报错
    this.timer = setTimeout(() => {
      wx.reLaunch({ url: '/pages/home/home' });
    }, 2000);
  },

  // 一次性云端初始化：建 9 个集合 + 平台配置 + 称号/商城种子数据（幂等）
  // v2：二期新增集合/管理员种子/三值称号，升级标记 key 触发一次增量初始化
  bootstrap() {
    const done = wx.getStorageSync('jh_init_done_v2');
    const p = done
      ? Promise.resolve()
      : wx.cloud.callFunction({ name: 'initData' })
          .then((res) => {
            const r = res.result;
            if (r && r.ok) {
              wx.setStorageSync('jh_init_done_v2', true);
              console.log('[江湖榜] 云端初始化完成:', r.data);
            } else {
              console.warn('[江湖榜] 云端初始化返回异常:', r);
            }
          })
          .catch((e) => {
            console.warn('[江湖榜] 云端初始化失败（下次启动自动重试）:', e && e.errMsg);
          });
    // 兜底触发一轮定时任务（见 utils/cron.js）
    return p.then(() => cronBoost());
  },

  onUnload() {
    clearTimeout(this.timer);
  }
});
