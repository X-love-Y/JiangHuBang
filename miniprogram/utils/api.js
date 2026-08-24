// api.js —— 云函数调用 Promise 封装 + 统一错误处理
// 所有云函数返回 { ok: true, data } 或 { ok: false, error: { code, message } }
// 注意：任何 toast 弹出前必须先 hideLoading，保证 showLoading/hideLoading 配对
function call(name, data = {}, options = {}) {
  const { loading = false, loadingText = '处理中…' } = options;
  if (loading) {
    wx.showLoading({ title: loadingText, mask: true });
  }
  const hide = () => {
    if (loading) wx.hideLoading();
  };
  return wx.cloud
    .callFunction({ name, data })
    .then((res) => {
      hide();
      const result = res.result || {};
      if (result.ok === true) {
        return result.data;
      }
      // 业务错误：抛出带 code 的错误，由调用方决定是否静默
      const err = new Error((result.error && result.error.message) || '操作失败');
      err.code = (result.error && result.error.code) || 'UNKNOWN';
      err.silent = true;
      throw err;
    })
    .catch((e) => {
      hide();
      if (!e.silent) {
        console.error(`[api] ${name} 调用失败:`, e);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      }
      throw e;
    });
}

// 业务错误弹 toast 后抛出，供页面 catch 终止流程
function callWithToast(name, data = {}, options = {}) {
  return call(name, data, options).catch((e) => {
    if (e.silent) {
      if (e.code === 'NEED_REGISTER') {
        // 游客写操作：弹注册引导（全站统一入口）
        wx.showModal({
          title: '需要注册账号',
          content: '发布委托、接单、聊天等操作需要注册江湖账号（ID + 密码）',
          confirmText: '去注册',
          cancelText: '先逛逛',
          success: (res) => {
            if (res.confirm) wx.navigateTo({ url: '/pages/register/register?mode=register' });
          }
        });
      } else {
        wx.showToast({ title: e.message, icon: 'none', duration: 2200 });
      }
    }
    throw e;
  });
}

module.exports = { call, callWithToast };
