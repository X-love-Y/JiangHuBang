// confirm-dialog —— 玻璃拟态确认弹窗（购买确认 / 取消确认等）
Component({
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '确认操作' },
    content: { type: String, value: '' },
    confirmText: { type: String, value: '确认' },
    cancelText: { type: String, value: '取消' },
    danger: { type: Boolean, value: false }
  },
  methods: {
    onConfirm() {
      this.triggerEvent('confirm');
    },
    onCancel() {
      this.triggerEvent('cancel');
    },
    noop() {}
  }
});
