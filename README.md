# 江湖榜 · 悬赏令式任务平台小程序

> 生活…即是江湖…

微信小程序悬赏交易平台：任何人可发布委托（取外卖/讲题/寻人/P图…）并指定悬赏金额，完成者获得报酬。含星级体系、成就称号、黄金商城、AI 助手、双货币经济（白银/黄金）。

## 技术栈

- **前端**：原生小程序（WXML/WXSS/JS），玻璃拟态 + Soft UI 设计系统
- **后端**：微信云开发（云数据库 NoSQL + 云函数 Node.js + 云存储）
- **AI**：DeepSeek API（未配置 Key 时自动降级为模拟回复，不影响流程）
- **支付**：模拟通道 + 预留真实微信支付接口结构

## 目录结构

```
├── project.config.json        # AppID: wx73f0c145936cec3f
├── miniprogram/               # 小程序前端
│   ├── config/env.js          # ⚠️ 云环境 ID（部署前必填）
│   ├── config/constants.js    # 分类/状态/星级/货币常量
│   ├── styles/                # 设计系统（玻璃拟态变量 + 通用类）
│   ├── components/            # pill-button / star-bar / status-badge / empty-state / confirm-dialog
│   ├── utils/                 # api 封装 / auth 登录态 / format 格式化
│   └── pages/                 # 12 个页面
├── cloudfunctions/            # 14 个云函数（business.js 为共享业务逻辑副本）
│   ├── login                  # 登录注册（首登送 100 白银）
│   ├── commissionCreate/List/My  # 发布 / 大厅筛选分页 / 我的委托
│   ├── acceptCommission       # 接单（事务 + 接单上限 + 封禁检查）
│   ├── submitCommission       # 提交完成凭证
│   ├── confirmCommission      # 双方确认 → 结算事务（1% 中介费）
│   ├── cancelCommission       # 取消退款 / 放弃（24h 3 次封接单权）
│   ├── wallet                 # 充值（模拟+预留微信支付）/ 兑换（1金=100银不扣税）/ 流水
│   ├── aiAssistant            # DeepSeek：每日推荐 + 委托方案（月卡免费）
│   ├── shopPurchase           # 商城购买（黄金 + 解锁条件）
│   ├── useItem                # 道具使用 / 称号卡面佩戴 / 资料更新 / 背包
│   ├── cronSettle             # 定时任务：48h 自动结算 + 过期退款 + 置顶清理
│   └── initData               # 一次性：建集合 + 配置 + 称号/商品种子数据
└── tests/business.test.js     # 纯函数单元测试（node 直接运行）
```

## 部署步骤（首次必做）

### 第 1 步：创建云开发环境

1. 用微信开发者工具打开本项目
2. 工具栏点「云开发」→ 开通（免费额度即可）→ **创建环境**（如 `jianghu-prod`）
3. 复制**环境 ID**，填入 [miniprogram/config/env.js](miniprogram/config/env.js)

### 第 2 步：配置 DeepSeek Key（可选，不配则 AI 返回模拟结果）

1. 前往 https://platform.deepseek.com 注册并创建 API Key
2. 云开发控制台 → 云函数 → 配置 → 环境变量：新增 `DEEPSEEK_API_KEY`
3. 把 `aiAssistant` 函数的**超时时间**调到 30 秒以上（AI 调用较慢）

### 第 3 步：部署云函数（命令行一条龙）

```bash
"D:/learn/微信web开发者工具/cli.bat" cloud functions deploy ^
  --e <你的环境ID> ^
  --project "D:\CluadeProject\江湖榜" ^
  --n login commissionCreate commissionList commissionMy acceptCommission submitCommission confirmCommission cancelCommission wallet aiAssistant shopPurchase useItem cronSettle initData ^
  --r ^
  --token <你的CLI访问令牌>
```

> 参数说明：`--e` 环境 ID、`--n` 函数名列表、`--r` 云端安装依赖（等价于 --env / --names / --remote-npm-install）。

> 也可以在 IDE 里对 `cloudfunctions` 下每个函数右键「上传并部署：云端安装依赖」。
> `cronSettle` 的定时触发器已写入 config.json，部署后自动生效（每 60 分钟）。

### 第 4 步：初始化数据库（自动建集合 + 种子数据）

1. 云开发控制台 → 云函数 → `initData` → 云端测试 → 运行（幂等，可重复执行）
2. 它会自动：创建 9 个集合、写入平台配置、写入 12 个称号 + 13 个商城商品
3. **集合权限**：在控制台把 9 个集合的权限全部设为「所有用户不可读写」（数据只经云函数读写，防越权）

### 第 5 步：运行体验

编译运行 → 加载页竖排「生活…即是江湖…」→ 主页四按钮 → 完整走通：
注册送 100 银 → 发布委托 → 大厅接单 → 提交凭证 → 确认结算（扣 1% 中介费）→ 钱包充值/兑换 → 商城买称号 → AI 推荐

## 核心规则速查

| 规则 | 数值 |
|---|---|
| 兑换倍率 | 1 金 = 100 银，双向兑换**不扣税** |
| 平台中介费 | 结算金额的 **1%**（最低 1 文；佩戴称号可享折扣，最低 0.5%） |
| 星级梯度 | 等价白银：<100=1★ / <1千=2★ / <1万=3★ / <10万=4★ / ≥10万=5★ |
| 新手礼 | 注册送 100 白银 |
| 充值 | 6/18/30/68/128 元 → 600/1800/3000/6800/12800 银（模拟通道） |
| AI 定价 | 推荐 5 银/次（1次/日）· 方案 20 银/次（3次/日）· 月卡 50 金（30天 3+3 免费） |
| 接单上限 | 同时 3 单（称号可 +1/+2）· 24h 放弃 3 次封接单权 24h |
| 超时结算 | 提交凭证后 48h 未确认自动结算；7 天无人接单自动退款 |

## 单元测试

```bash
node tests/business.test.js   # 星级/中介费/折算 28 项断言
```

## 风险提示（提审上线前必读）

1. **虚拟货币充值是审核红线**：iOS 虚拟支付被禁，安卓需「虚拟支付」类目资质。当前为模拟支付，提审前需定案：接真实微信支付（仅安卓可用）或改为「完成任务赚白银」的经济模型。支付宝/银行卡需日后做 H5 版。
2. 玄学类已标注娱乐用途；寻人寻物请勿发布他人隐私；学业类禁代考代写。所有发布内容过 `msgSecCheck`。
3. 云开发按量计费：DeepSeek 调用消耗外网流量，已做限流（AI 调用次数限制）。建议在控制台开费用告警。
4. 上线前在控制台补建数据库索引（`status+createdAt`、`publisherId+status` 等组合索引）。
