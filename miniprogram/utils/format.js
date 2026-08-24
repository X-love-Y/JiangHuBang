// format.js —— 金额 / 时间 / 星级格式化
const { CURRENCY } = require('../config/constants');

// 金额展示：金 "3 金"、银 "300 银"（千分位）
function formatAmount(amount, currency) {
  const num = Number(amount || 0);
  const text = num.toLocaleString ? num.toLocaleString('zh-CN') : String(num);
  const unit = (CURRENCY[currency] || CURRENCY.silver).unit;
  return `${text} ${unit}`;
}

// 仅数字+单位小字版（用于列表徽章）
function amountParts(amount, currency) {
  return {
    num: Number(amount || 0).toLocaleString('zh-CN'),
    unit: (CURRENCY[currency] || CURRENCY.silver).unit,
    isGold: currency === 'gold'
  };
}

// 相对时间：刚刚 / n 分钟前 / n 小时前 / n 天前 / 具体日期
function relativeTime(ts) {
  if (!ts) return '';
  const t = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
  const diff = Date.now() - t;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(ts);
}

// 具体日期：2026-08-20
function formatDate(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 日期时间：2026-08-20 14:30
function formatDateTime(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${formatDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 地区拼接：省 市 区
function formatRegion(region) {
  if (!region) return '不限地区';
  const parts = [region.province, region.city, region.district].filter(Boolean);
  return parts.join(' · ') || '不限地区';
}

// 截止倒计时（未来时间专用）：X 天后截止 / X 小时后截止 / 已截止
function deadlineFromNow(ts) {
  if (!ts) return '';
  const t = new Date(ts).getTime();
  const diff = t - Date.now();
  if (diff <= 0) return '已截止';
  const day = 24 * 3600 * 1000;
  const hour = 3600 * 1000;
  if (diff >= day) return `${Math.floor(diff / day)} 天后截止`;
  if (diff >= hour) return `${Math.floor(diff / hour)} 小时后截止`;
  return '即将截止';
}

module.exports = {
  formatAmount,
  amountParts,
  relativeTime,
  formatDate,
  formatDateTime,
  formatRegion,
  deadlineFromNow
};
