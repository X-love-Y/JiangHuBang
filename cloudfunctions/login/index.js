// login —— 微信身份自动登录/注册：取 openid，初始化用户（首登送新手白银见面礼）
// 二期：用户文档新增账号字段与三值字段；返回体脱敏（绝不携带密码哈希）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { DEFAULTS, sanitizeUser } = require('./business');

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, error: { code: 'NO_OPENID', message: '无法获取用户身份' } };

  const users = db.collection('users');

  // 用 where 查询代替 doc().get()：文档不存在时返回空数组而不是抛异常
  try {
    const q = await users.where({ _id: OPENID }).limit(1).get();
    if (q.data.length) {
      const u = q.data[0];
      if (u.status === -1) {
        return { ok: false, error: { code: 'BANNED', message: '账号已被封禁' } };
      }
      return {
        ok: true,
        data: {
          user: sanitizeUser(u),
          isNew: false,
          isRegistered: !!u.userId
        }
      };
    }
  } catch (e) {
    // users 集合尚未创建（初始化未完成）：返回明确错误，前端稍后重试
    return { ok: false, error: { code: 'NOT_READY', message: '云端初始化中，请稍后重试' } };
  }

  // ---- 新用户初始化（游客态：userId 为 null，需注册后才能写操作） ----
  const now = db.serverDate();
  const user = {
    _id: OPENID,
    openid: OPENID,
    nickname: '江湖路人',
    avatarUrl: '',
    gender: 0,
    bio: '',
    userId: null,           // 账号 ID，注册后填充
    pwdHash: null,
    pwdSalt: null,
    boundOpenids: [],
    adminLevel: 0,
    silver: DEFAULTS.newbieSilver, // 初入江湖见面礼
    gold: 0,
    titleIds: ['a_beginner'],
    equippedTitleId: 'a_beginner',
    cardId: '',
    stats: {
      published: 0, accepted: 0, completed: 0, cancelled: 0,
      totalEarnedSilver: 0, totalEarnedGold: 0,
      onTimeCount: 0, cancelAsPublisher: 0, giveUpCount: 0, banCount: 0
    },
    rep: DEFAULTS.newUserRep,
    fame: 0,
    skill: DEFAULTS.newUserSkill,
    privacy: { showThree: true, showStats: true, showTitles: true, showCompleted: true },
    aiPassExpire: null,        // AI 月卡到期时间
    acceptBanUntil: null,      // 接单权封禁截止
    priorityBoostUntil: null,  // 「先声夺人」道具生效截止
    publishBanUntil: null,     // 发布权封禁截止（管理员可设）
    chatBanUntil: null,        // 禁言截止
    registeredAt: null,
    lastLoginAt: now,
    lastUserIdChangeAt: null,
    status: 1,
    createdAt: now,
    updatedAt: now
  };

  try {
    // doc(id).set() 的数据不能携带 _id 字段，须剔除
    const { _id, ...userData } = user;
    await users.doc(OPENID).set({ data: userData });
  } catch (e) {
    // 并发首登：另一个请求已创建，读回即可
    const q = await users.where({ _id: OPENID }).limit(1).get().catch(() => ({ data: [] }));
    if (q.data.length) {
      return {
        ok: true,
        data: { user: sanitizeUser(q.data[0]), isNew: false, isRegistered: !!q.data[0].userId }
      };
    }
    throw e;
  }

  // 见面礼流水（失败不影响注册成功）
  try {
    await db.collection('transactions').add({
      data: {
        userId: OPENID, type: 'recharge', currency: 'silver',
        amount: DEFAULTS.newbieSilver, balanceAfter: DEFAULTS.newbieSilver, relatedId: '',
        remark: '初入江湖见面礼', createdAt: now
      }
    });
  } catch (e) {
    console.warn('[login] 见面礼流水写入失败（不影响注册）:', e.message);
  }

  return { ok: true, data: { user: sanitizeUser(user), isNew: true, isRegistered: false } };
};
