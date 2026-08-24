// cloud-img.js —— 云存储 fileID → 临时 https 链接批量转换
// 部分基础库版本直接渲染 cloud:// 图片会失败（渲染层报 Failed to load image），
// 统一在展示前把 fileID 换成临时链接
function resolveCloudUrls(fileIds) {
  const ids = [...new Set(
    (fileIds || []).filter((f) => typeof f === 'string' && f.startsWith('cloud://'))
  )];
  if (!ids.length) return Promise.resolve({});
  return wx.cloud.getTempFileURL({ fileList: ids })
    .then((res) => {
      const map = {};
      (res.fileList || []).forEach((f) => {
        if (f.status === 0 && f.tempFileURL) map[f.fileID] = f.tempFileURL;
      });
      // 诊断日志：转换不完整时输出详情，便于定位环境问题
      if (Object.keys(map).length < ids.length) {
        console.warn('[cloud-img] getTempFileURL 部分失败:', {
          requested: ids.length,
          ok: Object.keys(map).length,
          detail: (res.fileList || []).map((f) => ({
            status: f.status, errMsg: f.errMsg || '', fileID: String(f.fileID || '').slice(0, 70)
          }))
        });
      }
      return map;
    })
    .catch((e) => {
      console.warn('[cloud-img] getTempFileURL 调用失败:', e && e.errMsg);
      return {};
    });
}

module.exports = { resolveCloudUrls };
