// star-bar —— 星级展示组件（1-5 星，金星/灰星）
Component({
  properties: {
    star: { type: Number, value: 1 },
    size: { type: Number, value: 28 } // rpx 单位
  },
  data: {
    stars: [1, 2, 3, 4, 5]
  }
});
