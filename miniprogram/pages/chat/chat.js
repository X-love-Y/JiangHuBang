// chat —— 聊天窗口：文字 / 表情 / 图片（先预览后发送）/ 按住说话（上滑取消）/ 短视频
// 语音转文字：预留接口（需微信「同声传译」插件授权，见语音气泡操作菜单提示）
const { call } = require('../../utils/api');
const { ensureLogin } = require('../../utils/auth');
const { resolveCloudUrls } = require('../../utils/cloud-img');
const { formatDateTime } = require('../../utils/format');

const recorder = wx.getRecorderManager();
let audioCtx = null;

// 常用表情（微信风格精选）
const EMOJIS = ['😀', '😂', '😅', '😊', '😍', '😘', '🤔', '😎', '🥺', '😭', '😡', '👍', '👏', '🙏', '💪', '🤝', '🎉', '❤️', '🔥', '⭐', '🍵', '🐶', '🐱', '🌸', '☀️', '🌙', '💰', '🎁', '📌', '👀', '🫡', '🙃'];

Page({
  data: {
    conversationId: '',
    otherName: '',
    adminMode: false,
    messages: [],
    inputText: '',
    me: null,
    // 输入模式：text 文字 / voice 语音
    inputMode: 'text',
    // 展开面板：'' / emoji / plus
    showPanel: '',
    // 图片预览确认
    pendingImage: '',
    pendingImagePreview: false,
    // 录音状态
    recording: false,
    willCancel: false,
    emojis: EMOJIS
  },

  onLoad(options) {
    this.setData({
      conversationId: options.conversationId || '',
      otherName: decodeURIComponent(options.otherName || '对方'),
      adminMode: options.admin === '1'
    });
    wx.setNavigationBarTitle({ title: this.data.adminMode ? '管理员视角 · 会话' : this.data.otherName });
    this.initRecorder();
    this.bindAudioEvents();
  },

  onShow() {
    ensureLogin().then((u) => {
      this.setData({ me: u });
      this.fetchMessages();
      this.startPolling();
    });
  },

  onHide() { this.stopPolling(); },
  onUnload() {
    this.stopPolling();
    if (audioCtx) { try { audioCtx.destroy(); } catch (e) {} audioCtx = null; }
  },

  startPolling() {
    this.stopPolling();
    this._poll = setInterval(() => this.fetchMessages(), this.data.adminMode ? 8000 : 5000);
  },
  stopPolling() {
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
  },

  // ===== 录音（上滑取消） =====
  initRecorder() {
    recorder.onStop((res) => {
      if (this._cancelRecord || !res.tempFilePath) {
        this._cancelRecord = false;
        this.setData({ recording: false, willCancel: false });
        return;
      }
      this.setData({ recording: false, willCancel: false });
      wx.showLoading({ title: '发送中…', mask: true });
      wx.cloud.uploadFile({
        cloudPath: `chat/${this.data.conversationId}/${Date.now()}-voice.mp3`,
        filePath: res.tempFilePath
      }).then((up) => call('chat', {
        action: 'send', conversationId: this.data.conversationId,
        type: 'voice', fileId: up.fileID, duration: Math.round((res.duration || 0) / 1000)
      })).then(() => this.fetchMessages(true))
        .catch(() => wx.showToast({ title: '发送失败', icon: 'none' }))
        .finally(() => wx.hideLoading());
    });
  },

  onRecordStart() {
    this._startY = 0;
    this._cancelRecord = false;
    this.setData({ recording: true, willCancel: false });
    wx.showToast({ title: '上滑取消发送', icon: 'none' });
    recorder.start({ duration: 60000, format: 'mp3', sampleRate: 16000, encodeBitRate: 48000 });
  },
  onRecordMove(e) {
    if (!this.data.recording) return;
    const y = e.touches[0].clientY;
    if (this._startY === 0) this._startY = y;
    const delta = this._startY - y; // 上滑为正
    const willCancel = delta > 80;
    if (willCancel !== this.data.willCancel) {
      this.setData({ willCancel });
      if (willCancel) {
        wx.showToast({ title: '松开取消发送', icon: 'none' });
      } else {
        wx.showToast({ title: '上滑取消发送', icon: 'none' });
      }
    }
  },
  onRecordEnd() {
    if (!this.data.recording) return;
    if (this.data.willCancel) {
      this._cancelRecord = true; // 上滑取消：停止后丢弃
    }
    recorder.stop();
  },

  // ===== 消息加载 =====
  fetchMessages(forceScroll = false) {
    // 管理员只读模式：通过 admin 接口拉取任意会话
    if (this.data.adminMode) return this.fetchAdminMessages();
    return call('chat', { action: 'getMessages', conversationId: this.data.conversationId })
      .then(async (data) => {
        const msgs = data.messages || [];
        const snap = (data.conversation && data.conversation.memberSnapshots) || {};
        // 媒体文件 + 成员头像一并转临时链接
        const ids = [];
        msgs.forEach((m) => {
          if (['image', 'voice', 'video'].includes(m.type) && m.fileId) ids.push(m.fileId);
        });
        Object.values(snap).forEach((s) => {
          if (s.avatarUrl && typeof s.avatarUrl === 'string' && s.avatarUrl.startsWith('cloud://')) ids.push(s.avatarUrl);
        });
        let urlMap = await resolveCloudUrls(ids);
        // 兜底：临时链接转换失败的文件，逐个下载到本地（模拟器灰度库下更稳）
        const missing = ids.filter((f) => !urlMap[f]);
        if (missing.length) {
          const dlMap = await Promise.all(missing.map((f) =>
            wx.cloud.downloadFile({ fileID: f })
              .then((r) => ({ [f]: r.tempFilePath }))
              .catch((e) => {
                console.warn('[chat] 媒体下载失败:', f, e && e.errMsg);
                return {};
              })
          ));
          Object.assign(urlMap, ...dlMap);
        }
        const me = this.data.me;
        const messages = msgs.map((m) => {
          const mine = m.senderId === (me && me._id);
          const s = snap[m.senderId] || {};
          return Object.assign({}, m, {
            mine,
            name: s.nickname || '江湖路人',
            avatarUrl: urlMap[s.avatarUrl] || (s.avatarUrl && !s.avatarUrl.startsWith('cloud://') ? s.avatarUrl : ''),
            mediaUrl: urlMap[m.fileId] || '',
            timeText: formatDateTime(m.createdAt)
          });
        });
        const lastId = messages.length ? 'msg-' + messages[messages.length - 1]._id : '';
        const patch = { messages };
        // 仅当用户接近底部（或首次加载、或自己刚发消息）时自动跟随
        if (forceScroll || this.shouldAutoScroll()) {
          patch.lastMsgId = lastId;
          this._atBottomOnce = true;
          // 定位完成后立即清空目标：否则每次列表重渲染都会重新触发 scroll-into-view 拽回底部
          clearTimeout(this._clearScrollTimer);
          this._clearScrollTimer = setTimeout(() => {
            if (this.data.lastMsgId) this.setData({ lastMsgId: '' });
          }, 500);
        }
        this.setData(patch);
        call('chat', { action: 'markRead', conversationId: this.data.conversationId }).catch(() => {});
      })
      .catch(() => {});
  },

  // 管理员只读模式：拉取会话消息（含发送人昵称）
  fetchAdminMessages() {
    return call('admin', { action: 'chatMessages', conversationId: this.data.conversationId })
      .then(async (data) => {
        const msgs = data.messages || [];
        const ids = msgs.filter((m) => ['image', 'voice', 'video'].includes(m.type) && m.fileId).map((m) => m.fileId);
        const urlMap = await resolveCloudUrls(ids);
        const messages = msgs.map((m) => Object.assign({}, m, {
          mine: false,
          name: m.senderName || '用户',
          avatarUrl: '',
          mediaUrl: urlMap[m.fileId] || '',
          timeText: formatDateTime(m.createdAt)
        }));
        this.setData({ messages });
      })
      .catch(() => {});
  },

  // ===== 文字 / 表情 =====
  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },
  sendText() {
    const t = (this.data.inputText || '').trim();
    if (!t) return;
    this.setData({ inputText: '' });
    call('chat', {
      action: 'send', conversationId: this.data.conversationId, type: 'text', text: t
    })
      .then(() => this.fetchMessages(true))
      .catch((e) => { if (e.silent) wx.showToast({ title: e.message, icon: 'none', duration: 2200 }); });
  },
  tapEmoji(e) {
    const em = e.currentTarget.dataset.emoji;
    this.setData({ inputText: (this.data.inputText || '') + em });
  },

  // ===== 面板切换 =====
  toggleInputMode() {
    this.setData({
      inputMode: this.data.inputMode === 'text' ? 'voice' : 'text',
      showPanel: ''
    });
  },
  togglePanel(e) {
    const kind = e.currentTarget.dataset.panel;
    this.setData({ showPanel: this.data.showPanel === kind ? '' : kind, inputMode: 'text' });
  },

  // ===== 图片（先预览确认，再发送） =====
  chooseImage() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'],
      success: (res) => {
        this.setData({
          pendingImage: res.tempFiles[0].tempFilePath,
          pendingImagePreview: true
        });
      }
    });
  },
  cancelPendingImage() {
    this.setData({ pendingImage: '', pendingImagePreview: false });
  },
  confirmPendingImage() {
    const path = this.data.pendingImage;
    if (!path) return;
    this.setData({ pendingImage: '', pendingImagePreview: false });
    wx.showLoading({ title: '发送中…', mask: true });
    wx.cloud.uploadFile({
      cloudPath: `chat/${this.data.conversationId}/${Date.now()}-img.jpg`,
      filePath: path
    }).then((up) => call('chat', {
      action: 'send', conversationId: this.data.conversationId, type: 'image', fileId: up.fileID
    })).then(() => this.fetchMessages(true))
      .catch(() => wx.showToast({ title: '发送失败', icon: 'none' }))
      .finally(() => wx.hideLoading());
  },

  // ===== 短视频 =====
  chooseVideo() {
    wx.chooseMedia({
      count: 1, mediaType: ['video'], sourceType: ['camera', 'album'],
      maxDuration: 60, camera: 'back',
      success: (res) => {
        const f = res.tempFiles[0];
        wx.showLoading({ title: '发送中…', mask: true });
        wx.cloud.uploadFile({
          cloudPath: `chat/${this.data.conversationId}/${Date.now()}-video.mp4`,
          filePath: f.tempFilePath
        }).then((up) => call('chat', {
          action: 'send', conversationId: this.data.conversationId,
          type: 'video', fileId: up.fileID, duration: Math.round(f.duration || 0)
        })).then(() => this.fetchMessages(true))
          .catch(() => wx.showToast({ title: '发送失败', icon: 'none' }))
          .finally(() => wx.hideLoading());
      }
    });
  },

  // ===== 语音播放 / 转文字 =====
  // ===== 语音交互：单击 播放/暂停/重播，长按 转文字，进度条拖动 =====
  setVoiceState(msgId, voiceStatus, voiceCurrent, voiceDuration) {
    this.setData({
      messages: this.data.messages.map((m) => {
        if (m._id === msgId) {
          return Object.assign({}, m, { voiceStatus, voiceCurrent, voiceDuration });
        }
        return Object.assign({}, m, { voiceStatus: '', voiceCurrent: 0, voiceDuration: 0 });
      })
    });
  },

  onVoiceTap(e) {
    const url = e.currentTarget.dataset.url;
    const fileId = e.currentTarget.dataset.file;
    const msgId = e.currentTarget.dataset.id;
    const cur = this.data.messages.find((m) => m._id === msgId);
    const status = (cur && cur.voiceStatus) || '';

    if (!audioCtx) audioCtx = wx.createInnerAudioContext();
    // 当前正在播放 → 暂停
    if (status === 'playing' && this._audioMsgId === msgId) {
      audioCtx.pause();
      this.setVoiceState(msgId, 'paused', this._audioCurrent || 0, this._audioDuration || 0);
      return;
    }
    // 暂停中或播放其他消息 → 从头播放
    const doPlay = (src) => {
      audioCtx.stop();
      this._audioMsgId = msgId;
      this._audioCurrent = 0;
      audioCtx.src = src;
      audioCtx.play();
      this.setVoiceState(msgId, 'playing', 0, (cur && cur.duration) || 0);
    };
    if (url) {
      doPlay(url);
      return;
    }
    wx.showLoading({ title: '加载语音…', mask: true });
    wx.cloud.downloadFile({ fileID: fileId })
      .then((r) => { wx.hideLoading(); doPlay(r.tempFilePath); })
      .catch((e1) => {
        console.warn('[chat] 语音下载失败:', e1 && e1.errMsg);
        wx.hideLoading();
        wx.showToast({ title: '语音加载失败，请稍后重试', icon: 'none' });
      });
  },

  onVoiceLongPress() {
    wx.showModal({
      title: '语音转文字',
      content: '该功能需开通微信「同声传译」插件（mp.weixin.qq.com 后台 → 设置 → 第三方设置 → 插件管理 添加）。开通后即可将语音转为文字。',
      showCancel: false
    });
  },

  // 进度条拖动中（预览）
  onVoiceSeeking(e) {
    if (!audioCtx || !this._audioMsgId) return;
    this._seekValue = e.detail.value;
    this.setVoiceState(this._audioMsgId, 'paused', e.detail.value, this._audioDuration || 0);
  },
  // 进度条松手（跳转）
  onVoiceSeek(e) {
    if (!audioCtx || !this._audioMsgId) return;
    audioCtx.seek(e.detail.value);
    if (audioCtx.paused) audioCtx.play();
    this._audioCurrent = e.detail.value;
    this.setVoiceState(this._audioMsgId, 'playing', e.detail.value, this._audioDuration || 0);
  },

  bindAudioEvents() {
    if (!audioCtx) audioCtx = wx.createInnerAudioContext();
    audioCtx.onTimeUpdate(() => {
      if (!this._audioMsgId) return;
      this._audioCurrent = audioCtx.currentTime || 0;
      this._audioDuration = audioCtx.duration || this._audioDuration || 0;
      this.setVoiceState(this._audioMsgId, 'playing', this._audioCurrent, this._audioDuration);
    });
    audioCtx.onEnded(() => {
      if (this._audioMsgId) this.setVoiceState(this._audioMsgId, '', 0, this._audioDuration || 0);
      this._audioMsgId = null;
    });
    audioCtx.onStop(() => {
      if (this._audioMsgId) this.setVoiceState(this._audioMsgId, '', 0, this._audioDuration || 0);
      this._audioMsgId = null;
    });
    audioCtx.onError(() => {
      if (this._audioMsgId) this.setVoiceState(this._audioMsgId, '', 0, 0);
      this._audioMsgId = null;
    });
  },

  // ===== 滚动行为：仅在接近底部时自动跟随 =====
  onReady() {
    // 实测消息区视口高度，用于「接近底部」判断
    wx.createSelectorQuery().in(this).select('.msg-scroll').boundingClientRect((r) => {
      if (r) this._viewH = r.height;
    }).exec();
  },

  onScroll(e) {
    const { scrollTop, scrollHeight } = e.detail;
    this._scrollTop = scrollTop;
    this._scrollHeight = scrollHeight;
  },

  shouldAutoScroll() {
    if (this._atBottomOnce !== true) return true; // 首次
    const viewH = this._viewH || 600;
    const distToBottom = this._scrollHeight - this._scrollTop - viewH;
    return distToBottom < 300; // 距底 300px 内才跟随
  },

  previewMsgImage(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.previewImage({ urls: [url], current: url });
  }
});
