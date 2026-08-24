// account —— 账号体系：注册（含补注册）/ ID+密码登录 / 改密 / 改 ID
// 密码规则：6-20 位，必须同时含字母和数字；存储：pbkdf2 + 随机盐，绝不下发前端
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const {
  ok, fail, biz, getConfig,
  hashPassword, verifyPassword, requireUser, sanitizeUser
} = require('./business');

const ID_RE = /^[A-Za-z0-9]{4,16}$/;
// 密码：6-20 位、含字母、含数字
const PWD_RE = /^(?=.*[A-Za-z])(?=.*\d)[\S]{6,20}$/;

exports.main = async (event) => {
  const { action } = event || {};
  if (action === 'register') return register(event);
  if (action === 'login') return loginByPassword(event);
  if (action === 'changePassword') return changePassword(event);
  if (action === 'changeUserId') return changeUserId(event);
  return fail('INVALID_ACTION', '未知操作');
};

// ===== 注册 / 补注册：对当前 openid 文档追加账号字段，资产分毫不动 =====
async function register(event) {
  const { userId, password } = event || {};
  if (!ID_RE.test(String(userId || ''))) {
    return fail('INVALID_ID', 'ID 需 4-16 位字母或数字');
  }
  if (!PWD_RE.test(String(password || ''))) {
    return fail('INVALID_PWD', '密码需 6-20 位，且同时包含字母和数字');
  }

  const auth = await requireUser(db);
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const user = auth.user;
  if (user.userId) return fail('ALREADY_REGISTERED', '当前微信已注册账号，可直接使用');

  // ID 唯一性：不能撞普通账号、管理员 ID
  const config = await getConfig(db);
  if ((config.adminIds || []).includes(userId)) return fail('ID_TAKEN', '该 ID 已被占用');
  const dup = await db.collection('users').where({ userId }).count();
  if (dup.total > 0) return fail('ID_TAKEN', '该 ID 已被占用');

  const { salt, hash } = hashPassword(password);
  await db.collection('users').doc(auth.realId).update({
    data: {
      userId,
      pwdHash: hash,
      pwdSalt: salt,
      registeredAt: db.serverDate(),
      lastUserIdChangeAt: null,
      boundOpenids: _.push([auth.openid]),
      updatedAt: db.serverDate()
    }
  });
  const fresh = await db.collection('users').doc(auth.realId).get();
  return ok({ user: sanitizeUser(fresh.data) });
}

// ===== ID + 密码登录（换微信/换设备时用；管理员先查 admins 集合） =====
async function loginByPassword(event) {
  const { userId, password } = event || {};
  if (!userId || !password) return fail('INVALID_PARAM', '请输入账号和密码');

  // ---- 管理员路径 ----
  const adminRes = await db.collection('admins').doc(String(userId)).get().catch(() => null);
  if (adminRes && adminRes.data) {
    const admin = adminRes.data;
    if (!verifyPassword(password, admin.pwdSalt, admin.pwdHash)) {
      return fail('WRONG_PWD', '账号或密码错误');
    }
    await bindAdmin(admin.userId);
    return ok({ user: await currentSafeUser(), isAdmin: true });
  }

  // ---- 普通用户路径 ----
  const q = await db.collection('users').where({ userId: String(userId) }).limit(1).get();
  if (!q.data.length) return fail('NOT_FOUND', '账号不存在');
  const target = q.data[0];
  if (!verifyPassword(password, target.pwdSalt, target.pwdHash)) {
    return fail('WRONG_PWD', '账号或密码错误');
  }

  // 绑定当前微信（带资产合并）
  const auth = await requireUser(db);
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  if (target._id !== auth.realId) {
    const mergeRes = await mergeAccounts(auth, target);
    if (mergeRes) return mergeRes;
  }
  // 记录绑定 + 登录时间
  await db.collection('users').doc(target._id).update({
    data: { lastLoginAt: db.serverDate(), updatedAt: db.serverDate() }
  });
  const fresh = await db.collection('users').doc(target._id).get();
  return ok({ user: sanitizeUser(fresh.data), isAdmin: (fresh.data.adminLevel || 0) >= 1 });
}

// 管理员登录：当前微信身份切换为管理员账号（ID/密码/adminLevel 一并切换）
async function bindAdmin(adminUserId) {
  const { OPENID } = cloud.getWXContext();
  const admin = await db.collection('admins').doc(String(adminUserId)).get();
  const existing = await db.collection('users').where({ _id: OPENID }).limit(1).get().catch(() => ({ data: [] }));
  if (existing.data.length) {
    await db.collection('users').doc(OPENID).update({
      data: {
        userId: adminUserId,
        pwdHash: admin.data.pwdHash,
        pwdSalt: admin.data.pwdSalt,
        adminLevel: 1,
        updatedAt: db.serverDate()
      }
    });
  } else {
    // 该微信从未用过：建文档并直接以管理员 ID 作为账号
    const { salt, hash } = hashPassword(''); // 占位哈希（登录走 admins 集合，不走这里）
    const admin = await db.collection('admins').doc(adminUserId).get();
    const now = db.serverDate();
    await db.collection('users').doc(OPENID).set({
      data: {
        nickname: '江湖路人', avatarUrl: '', gender: 0, bio: '',
        userId: adminUserId,
        pwdHash: admin.data.pwdHash, pwdSalt: admin.data.pwdSalt,
        adminLevel: 1,
        silver: 100, gold: 0,
        titleIds: ['a_beginner'], equippedTitleId: 'a_beginner', cardId: '',
        stats: { published: 0, accepted: 0, completed: 0, cancelled: 0, totalEarnedSilver: 0, totalEarnedGold: 0, onTimeCount: 0, cancelAsPublisher: 0, giveUpCount: 0, banCount: 0 },
        rep: 500, fame: 0, skill: 300,
        privacy: { showThree: true, showStats: true, showTitles: true, showCompleted: true },
        aiPassExpire: null, acceptBanUntil: null, priorityBoostUntil: null,
        publishBanUntil: null, chatBanUntil: null,
        registeredAt: now, lastLoginAt: now, lastUserIdChangeAt: null,
        boundOpenids: [OPENID],
        status: 1, createdAt: now, updatedAt: now
      }
    });
  }
  // 绑定管理员凭据 → 当前微信
  await db.collection('admins').doc(adminUserId).update({
    data: { openid: OPENID, lastLoginAt: db.serverDate() }
  });
}

// 资产合并：当前 openid 文档（游客资产）并入目标账号
async function mergeAccounts(auth, target) {
  const cur = auth.user;
  if (cur.userId && cur.userId !== target.userId) {
    return fail('ACCOUNT_CONFLICT', `该微信已绑定账号「${cur.userId}」`);
  }
  const config = await getConfig(db);
  const t = await db.startTransaction();
  try {
    const c1 = await t.collection('users').doc(auth.realId).get();
    const c2 = await t.collection('users').doc(target._id).get();
    // 余额并入
    await t.collection('users').doc(target._id).update({
      data: {
        silver: _.inc(c1.data.silver || 0),
        gold: _.inc(c1.data.gold || 0),
        titleIds: _.push((c1.data.titleIds || []).filter((x) => !(c2.data.titleIds || []).includes(x))),
        'stats.published': _.inc((c1.data.stats && c1.data.stats.published) || 0),
        'stats.accepted': _.inc((c1.data.stats && c1.data.stats.accepted) || 0),
        'stats.completed': _.inc((c1.data.stats && c1.data.stats.completed) || 0),
        'stats.cancelled': _.inc((c1.data.stats && c1.data.stats.cancelled) || 0),
        'stats.totalEarnedSilver': _.inc((c1.data.stats && c1.data.stats.totalEarnedSilver) || 0),
        'stats.totalEarnedGold': _.inc((c1.data.stats && c1.data.stats.totalEarnedGold) || 0),
        'stats.onTimeCount': _.inc((c1.data.stats && c1.data.stats.onTimeCount) || 0),
        aiPassExpire: pickLater(c1.data.aiPassExpire, c2.data.aiPassExpire),
        updatedAt: db.serverDate()
      }
    });
    // 道具改指主账号
    await t.collection('user_items').where({ userId: auth.realId }).update({
      data: { userId: target._id }
    });
    // 当前文档标记为影子
    await t.collection('users').doc(auth.realId).update({
      data: { accountOf: target._id, status: -2, updatedAt: db.serverDate() }
    });
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 回滚失败不掩盖原始错误 */ }
    console.error('[account] 资产合并失败:', e);
    return fail('TRANSACTION_FAIL', '登录失败，请重试');
  }
  // 绑定微信进 boundOpenids（上限 boundOpenidLimit）
  if (!(target.boundOpenids || []).includes(auth.openid)) {
    const boundCount = (target.boundOpenids || []).length;
    if (boundCount >= config.boundOpenidLimit) {
      return fail('BIND_LIMIT', `账号最多绑定 ${config.boundOpenidLimit} 个微信`);
    }
    await db.collection('users').doc(target._id).update({
      data: { boundOpenids: _.push([auth.openid]), updatedAt: db.serverDate() }
    });
  }
  return null;
}

// 取较晚的时间（AI 月卡合并用）
function pickLater(a, b) {
  const ta = a ? new Date(a).getTime() : 0;
  const tb = b ? new Date(b).getTime() : 0;
  return ta > tb ? new Date(a) : new Date(b);
}

// ===== 改密码（需旧密码验证） =====
async function changePassword(event) {
  const { oldPassword, newPassword } = event || {};
  if (!PWD_RE.test(String(newPassword || ''))) {
    return fail('INVALID_PWD', '新密码需 6-20 位，且同时包含字母和数字');
  }
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const user = auth.user;
  if (!verifyPassword(oldPassword, user.pwdSalt, user.pwdHash)) {
    return fail('WRONG_PWD', '旧密码错误');
  }
  const { salt, hash } = hashPassword(newPassword);
  await db.collection('users').doc(auth.realId).update({
    data: { pwdHash: hash, pwdSalt: salt, updatedAt: db.serverDate() }
  });
  // 管理员账号同步更新 admins 凭据
  if ((user.adminLevel || 0) >= 1 && user.userId) {
    await db.collection('admins').doc(user.userId).update({
      data: { pwdHash: hash, pwdSalt: salt }
    }).catch(() => {});
  }
  return ok({ changed: true });
}

// ===== 改 ID（需密码验证 + 30 天冷却） =====
async function changeUserId(event) {
  const { password, newUserId } = event || {};
  if (!ID_RE.test(String(newUserId || ''))) {
    return fail('INVALID_ID', '新 ID 需 4-16 位字母或数字');
  }
  const auth = await requireUser(db, { needAccount: true });
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const user = auth.user;
  if (!verifyPassword(password, user.pwdSalt, user.pwdHash)) {
    return fail('WRONG_PWD', '密码错误');
  }
  const config = await getConfig(db);
  if (user.lastUserIdChangeAt) {
    const cd = config.userIdChangeCooldownDays * 24 * 3600 * 1000;
    if (new Date(user.lastUserIdChangeAt).getTime() + cd > Date.now()) {
      return fail('COOLDOWN', `改 ID 后需等待 ${config.userIdChangeCooldownDays} 天才能再次修改`);
    }
  }
  if (newUserId === user.userId) return fail('SAME_ID', '新 ID 与当前 ID 相同');
  if ((config.adminIds || []).includes(newUserId)) return fail('ID_TAKEN', '该 ID 已被占用');
  const dup = await db.collection('users').where({ userId: newUserId }).count();
  if (dup.total > 0) return fail('ID_TAKEN', '该 ID 已被占用');

  await db.collection('users').doc(auth.realId).update({
    data: { userId: newUserId, lastUserIdChangeAt: db.serverDate(), updatedAt: db.serverDate() }
  });
  const fresh = await db.collection('users').doc(auth.realId).get();
  return ok({ user: sanitizeUser(fresh.data) });
}

// 当前 openid 的脱敏用户
async function currentSafeUser() {
  const { OPENID } = cloud.getWXContext();
  const q = await db.collection('users').where({ _id: OPENID }).limit(1).get().catch(() => ({ data: [] }));
  if (!q.data.length) return null;
  return sanitizeUser(q.data[0]);
}
