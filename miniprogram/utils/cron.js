// cron.js —— 定时任务客户端兜底触发器
// 云函数 cronSettle 的定时触发器若未生效，靠用户活跃行为补触发：
// 每次调用间隔 ≥60 秒时，代为执行一轮定时任务（定时发布/到期翻转/自动结算/清理）
// cronSettle 内部全部幂等，多触发无害
function cronBoost() {
  const last = wx.getStorageSync('jh_cron_boost');
  if (last && Date.now() - last < 60 * 1000) return;
  wx.setStorageSync('jh_cron_boost', Date.now());
  wx.cloud.callFunction({ name: 'cronSettle' })
    .then((res) => {
      const r = res.result;
      if (r && r.ok && r.data) {
        const d = r.data;
        if (d.publishedScheduled || d.expired || d.settled || d.publicSettled) {
          console.log('[江湖榜] 定时任务已执行:', d);
        }
      }
    })
    .catch(() => {});
}

module.exports = { cronBoost };
