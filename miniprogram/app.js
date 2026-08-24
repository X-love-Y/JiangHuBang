// app.js —— 江湖榜入口
// 初始化云开发环境；云环境 ID 配置在 config/env.js
const { CLOUD_ENV_ID } = require('./config/env');

App({
  globalData: {
    userInfo: null, // 当前用户（users 集合文档），登录后由 utils/auth.js 填充
    config: null    // 平台全局配置（config 集合 global 文档）缓存
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('[江湖榜] 当前基础库版本过低，请使用 2.2.3 及以上基础库以使用云能力');
      return;
    }
    wx.cloud.init({
      env: CLOUD_ENV_ID,
      traceUser: true
    });
  }
});
