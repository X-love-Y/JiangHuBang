// chat —— 客服聊天：委托双方（含公共模式合作者）会话
// actions: create(按委托建会话) / createByPair(按用户建会话) / listConversations / getMessages / send / markRead
// 消息类型：text / image / voice / video（文件存云存储，仅存 fileId）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { ok, fail, getConfig, requireUser, notifyUser } = require('./business');

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[chat] 未捕获异常:', e);
    return fail('INTERNAL', '系统异常，请稍后重试');
  }
};

async function handle(event) {
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const OPENID = auth.realId;
  const { action } = event || {};
  if (action === 'create') return createByCommission(OPENID, event);
  if (action === 'createByPair') return createByPair(OPENID, event);
  if (action === 'listConversations') return listConversations(OPENID, event);
  if (action === 'getMessages') return getMessages(OPENID, event);
  if (action === 'send') return send(OPENID, event);
  if (action === 'markRead') return markRead(OPENID, event);
  return fail('INVALID_ACTION', '未知操作');
}

// 会话成员校验：当前用户必须是该委托的参与方
function isParty(c, OPENID) {
  if (c.publisherId === OPENID) return true;
  if (c.acceptorId === OPENID) return true;
  if ((c.acceptors || []).some((a) => a.userId === OPENID)) return true;
  // 公共模式：已申请（待审核/已选定）的申请人也算参与方，接单前即可沟通
  if ((c.requests || []).some((r) => r.userId === OPENID && ['pending', 'approved'].includes(r.status))) return true;
  // 待接单阶段：任何注册用户都可以在接单前咨询发布者
  if (c.status === 'pending') return true;
  return false;
}

// ===== 按委托创建会话（成员 = 发布者 + 接单者/合作者） =====
async function createByCommission(OPENID, event) {
  const { commissionId } = event || {};
  if (!commissionId) return fail('INVALID_PARAM', '缺少委托 ID');
  const cRes = await db.collection('commissions').doc(commissionId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '委托不存在');
  const c = cRes.data;
  if (!isParty(c, OPENID)) return fail('FORBIDDEN', '只有委托参与方才能发起会话');

  // 已存在会话直接返回
  const exist = await db.collection('conversations').where({ commissionId }).limit(1).get();
  if (exist.data.length) {
    return ok({ conversationId: exist.data[0]._id, created: false });
  }

  const members = [c.publisherId];
  if (c.mode === 'public') {
    (c.acceptors || []).forEach((a) => members.push(a.userId));
    // 接单前沟通：把当前申请人一并纳入会话
    (c.requests || []).forEach((r) => {
      if (['pending', 'approved'].includes(r.status)) members.push(r.userId);
    });
  } else if (c.acceptorId) {
    members.push(c.acceptorId);
  } else if (c.status === 'pending') {
    // 私人模式待接单：把发起咨询的访客纳入会话
    members.push(OPENID);
  }
  const uniq = [...new Set(members)];
  // 成员昵称快照
  const uRes = await db.collection('users').where({ _id: _.in(uniq) }).get();
  const snapshots = {};
  uRes.data.forEach((u) => {
    snapshots[u._id] = { nickname: u.nickname || '江湖路人', avatarUrl: u.avatarUrl || '' };
  });
  const unread = {};
  uniq.forEach((id) => { unread[id] = 0; });

  const addRes = await db.collection('conversations').add({
    data: {
      commissionId,
      commissionTitle: c.title,
      members: uniq,
      memberSnapshots: snapshots,
      lastPreview: '',
      lastAt: db.serverDate(),
      unreadCounts: unread,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  return ok({ conversationId: addRes._id, created: true });
}

// ===== 按用户创建会话（个人主页「联系 ta」：找双方共同参与的最近委托） =====
async function createByPair(OPENID, event) {
  const { otherUserId } = event || {};
  if (!otherUserId) return fail('INVALID_PARAM', '缺少对方用户');
  if (otherUserId === OPENID) return fail('SELF_CHAT', '不能和自己聊天');
  const [q1, q2] = await Promise.all([
    db.collection('commissions')
      .where({ publisherId: OPENID, acceptorId: otherUserId })
      .orderBy('createdAt', 'desc').limit(1).get(),
    db.collection('commissions')
      .where({ publisherId: otherUserId, acceptorId: OPENID })
      .orderBy('createdAt', 'desc').limit(1).get()
  ]);
  const pub1 = await db.collection('commissions')
    .where({ publisherId: OPENID, mode: 'public', 'acceptors.userId': otherUserId })
    .orderBy('createdAt', 'desc').limit(1).get();
  const pub2 = await db.collection('commissions')
    .where({ publisherId: otherUserId, mode: 'public', 'acceptors.userId': OPENID })
    .orderBy('createdAt', 'desc').limit(1).get();
  const candidates = [...q1.data, ...q2.data, ...pub1.data, ...pub2.data]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (!candidates.length) {
    return fail('NO_COMMON_COMMISSION', '你们还没有共同参与的委托，暂时无法发起会话');
  }
  return createByCommission(OPENID, { commissionId: candidates[0]._id });
}

// ===== 会话列表（含对方昵称与我的未读数） =====
async function listConversations(OPENID) {
  const res = await db.collection('conversations')
    .where({ members: OPENID })
    .orderBy('lastAt', 'desc').limit(50).get();
  const list = res.data.map((c) => {
    const others = (c.members || []).filter((m) => m !== OPENID);
    const snap = (c.memberSnapshots || {})[others[0]] || {};
    return {
      conversationId: c._id,
      commissionId: c.commissionId,
      commissionTitle: c.commissionTitle || '',
      otherName: snap.nickname || '江湖路人',
      otherAvatar: snap.avatarUrl || '',
      lastPreview: c.lastPreview || '',
      lastAt: c.lastAt,
      unread: (c.unreadCounts && c.unreadCounts[OPENID]) || 0
    };
  });
  const totalUnread = list.reduce((a, c) => a + c.unread, 0);
  return ok({ list, totalUnread });
}

// ===== 消息列表（近 50 条，倒序返回，前端反转显示） =====
async function getMessages(OPENID, event) {
  const { conversationId } = event || {};
  if (!conversationId) return fail('INVALID_PARAM', '缺少会话 ID');
  const cRes = await db.collection('conversations').doc(conversationId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '会话不存在');
  if (!(cRes.data.members || []).includes(OPENID)) return fail('FORBIDDEN', '非会话成员不可查看');
  const res = await db.collection('messages')
    .where({ conversationId })
    .orderBy('createdAt', 'desc').limit(50).get();
  return ok({ messages: res.data.reverse(), conversation: cRes.data });
}

// ===== 发送消息（文字/图片/语音/视频） =====
async function send(OPENID, event) {
  const { conversationId, type, text, fileId, duration } = event || {};
  if (!conversationId) return fail('INVALID_PARAM', '缺少会话 ID');
  if (!['text', 'image', 'voice', 'video'].includes(type)) return fail('INVALID_TYPE', '消息类型不合法');
  const cRes = await db.collection('conversations').doc(conversationId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '会话不存在');
  const conv = cRes.data;
  if (!(conv.members || []).includes(OPENID)) return fail('FORBIDDEN', '非会话成员不可发送');

  // 禁言检查
  const uRes = await db.collection('users').doc(OPENID).get().catch(() => null);
  if (uRes && uRes.data && uRes.data.chatBanUntil && new Date(uRes.data.chatBanUntil).getTime() > Date.now()) {
    return fail('CHAT_BANNED', '你已被禁言，暂时不能发送消息');
  }

  let preview = '';
  if (type === 'text') {
    const t = String(text || '').trim();
    if (!t) return fail('INVALID_TEXT', '消息内容不能为空');
    if (t.length > 500) return fail('INVALID_TEXT', '消息最多 500 字');
    preview = t;
    // 内容安全（未开通权限时静默跳过）
    try {
      await cloud.openapi.security.msgSecCheck({ version: 2, openid: OPENID, scene: 2, content: t });
    } catch (e) { /* 跳过 */ }
  } else if (!fileId) {
    return fail('INVALID_FILE', '缺少文件');
  } else {
    preview = type === 'image' ? '[图片]' : type === 'voice' ? '[语音]' : '[视频]';
  }

  await db.collection('messages').add({
    data: {
      conversationId,
      senderId: OPENID,
      type,
      text: type === 'text' ? String(text || '').trim() : '',
      fileId: fileId || '',
      duration: Number(duration) || 0,
      createdAt: db.serverDate()
    }
  });
  // 更新会话 + 对方未读计数
  const others = (conv.members || []).filter((m) => m !== OPENID);
  const updates = {};
  others.forEach((o) => { updates[`unreadCounts.${o}`] = _.inc(1); });
  await db.collection('conversations').doc(conversationId).update({
    data: Object.assign({
      lastPreview: preview,
      lastAt: db.serverDate(),
      updatedAt: db.serverDate()
    }, updates)
  });
  return ok({ sent: true, preview });
}

// ===== 已读 =====
async function markRead(OPENID, event) {
  const { conversationId } = event || {};
  if (!conversationId) return fail('INVALID_PARAM', '缺少会话 ID');
  const cRes = await db.collection('conversations').doc(conversationId).get().catch(() => null);
  if (!cRes || !cRes.data) return fail('NOT_FOUND', '会话不存在');
  if (!(cRes.data.members || []).includes(OPENID)) return fail('FORBIDDEN', '非会话成员');
  await db.collection('conversations').doc(conversationId).update({
    data: { [`unreadCounts.${OPENID}`]: 0, updatedAt: db.serverDate() }
  });
  return ok({ done: true });
}
