// pill-button —— 胶囊按钮组件：type 可选 primary/ghost/danger/gold，size 可选 normal/sm
Component({
  properties: {
    text: { type: String, value: '' },
    type: { type: String, value: 'primary' },
    size: { type: String, value: 'normal' },
    disabled: { type: Boolean, value: false }
  },
  methods: {
    onTap() {
      if (this.data.disabled) return;
      this.triggerEvent('tap');
    }
  }
});
