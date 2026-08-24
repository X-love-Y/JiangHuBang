// status-badge —— 委托状态徽章：status 传委托状态码，渲染对应文案与配色
const { STATUS } = require('../../config/constants');

Component({
  properties: {
    status: { type: String, value: 'pending' }
  },
  data: {
    conf: {}
  },
  observers: {
    status(s) {
      this.setData({ conf: STATUS[s] || STATUS.pending });
    }
  }
});
