// business.test.js —— 核心业务纯函数单元测试（Node 直接运行，无需安装依赖）
// 覆盖：星级计算 / 中介费计算 / 等价白银折算 / 兑换率
const assert = require('assert');
const {
  calcStar, calcFee, toSilverEquiv, calcPublicSplits,
  calcThreeValues, calcFameFromScore, calcFameGain, DEFAULTS
} = require('../cloudfunctions/common/business.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

console.log('===== 星级计算 calcStar =====');
test('白银 10 → 1 星', () => assert.strictEqual(calcStar(10, 'silver'), 1));
test('白银 99 → 1 星', () => assert.strictEqual(calcStar(99, 'silver'), 1));
test('白银 100 → 2 星（边界）', () => assert.strictEqual(calcStar(100, 'silver'), 2));
test('白银 999 → 2 星', () => assert.strictEqual(calcStar(999, 'silver'), 2));
test('白银 1000 → 3 星（边界）', () => assert.strictEqual(calcStar(1000, 'silver'), 3));
test('白银 9999 → 3 星', () => assert.strictEqual(calcStar(9999, 'silver'), 3));
test('白银 10000 → 4 星（边界）', () => assert.strictEqual(calcStar(10000, 'silver'), 4));
test('白银 99999 → 4 星', () => assert.strictEqual(calcStar(99999, 'silver'), 4));
test('白银 100000 → 5 星（边界）', () => assert.strictEqual(calcStar(100000, 'silver'), 5));
test('黄金 1（=100银）→ 2 星', () => assert.strictEqual(calcStar(1, 'gold'), 2));
test('黄金 9（=900银）→ 2 星', () => assert.strictEqual(calcStar(9, 'gold'), 2));
test('黄金 10（=1000银）→ 3 星', () => assert.strictEqual(calcStar(10, 'gold'), 3));
test('黄金 1000（=100000银）→ 5 星（边界）', () => assert.strictEqual(calcStar(1000, 'gold'), 5));
test('自定义梯度生效', () => assert.strictEqual(calcStar(50, 'silver', [50, 100, 200, 500]), 2));

console.log('===== 中介费 calcFee =====');
test('100 银 × 1% → 1 银', () => assert.strictEqual(calcFee(100), 1));
test('1000 银 × 1% → 10 银', () => assert.strictEqual(calcFee(1000), 10));
test('最小收 1 文：50 银 × 1% = 0.5 → 1', () => assert.strictEqual(calcFee(50), 1));
test('最小收 1 文：1 金 × 1% = 0.01 → 1', () => assert.strictEqual(calcFee(1), 1));
test('称号折扣 0.5：1000 银 → 5 银', () => assert.strictEqual(calcFee(1000, 0.01, 0.5), 5));
test('称号折扣 0.8：100 银 → 1 银（最小 1）', () => assert.strictEqual(calcFee(100, 0.01, 0.8), 1));
test('称号折扣 0.6：1000 银 → 6 银', () => assert.strictEqual(calcFee(1000, 0.01, 0.6), 6));

console.log('===== 等价白银折算 toSilverEquiv =====');
test('5 金 → 500 银', () => assert.strictEqual(toSilverEquiv(5, 'gold'), 500));
test('500 银 → 500 银（白银不折算）', () => assert.strictEqual(toSilverEquiv(500, 'silver'), 500));
test('自定义倍率 10：3 金 → 30 银', () => assert.strictEqual(toSilverEquiv(3, 'gold', 10), 30));

console.log('===== 默认配置 DEFAULTS =====');
test('兑换倍率 100', () => assert.strictEqual(DEFAULTS.exchangeRate, 100));
test('中介费率 1%', () => assert.strictEqual(DEFAULTS.feeRate, 0.01));
test('充值档位 6 元 → 600 银', () => assert.strictEqual(DEFAULTS.rechargePlans[6], 600));
test('充值档位 128 元 → 12800 银', () => assert.strictEqual(DEFAULTS.rechargePlans[128], 12800));

console.log('===== 公共模式分账 calcPublicSplits =====');
test('均分 3 人：100 银/1 银手续费 → Σgross=100、Σfee=1、Σnet=99', () => {
  const s = calcPublicSplits(100, 1, 'equal', [], 3);
  assert.strictEqual(s.reduce((a, x) => a + x.gross, 0), 100);
  assert.strictEqual(s.reduce((a, x) => a + x.fee, 0), 1);
  assert.strictEqual(s.reduce((a, x) => a + x.net, 0), 99);
});
test('均分 2 人：奇数金额守恒（101 → 50+51）', () => {
  const s = calcPublicSplits(101, 1, 'equal', [], 2);
  assert.strictEqual(s[0].gross + s[1].gross, 101);
});
test('均分 3 人：99 银手续费 1 → 末人承担手续费余数', () => {
  const s = calcPublicSplits(99, 1, 'equal', [], 3);
  assert.strictEqual(s.reduce((a, x) => a + x.fee, 0), 1);
});
test('自定义比例 60/40：总额 100 → 60/40，守恒', () => {
  const s = calcPublicSplits(100, 1, 'custom', [60, 40], 2);
  assert.strictEqual(s[0].gross, 60);
  assert.strictEqual(s[1].gross, 40);
  assert.strictEqual(s.reduce((a, x) => a + x.gross, 0), 100);
  assert.strictEqual(s.reduce((a, x) => a + x.net, 0), 99);
});
test('自定义比例 30/30/40：手续费守恒', () => {
  const s = calcPublicSplits(1000, 10, 'custom', [30, 30, 40], 3);
  assert.strictEqual(s.reduce((a, x) => a + x.gross, 0), 1000);
  assert.strictEqual(s.reduce((a, x) => a + x.fee, 0), 10);
});
test('自定义比例和不为 100 → 抛错', () => {
  assert.throws(() => calcPublicSplits(100, 1, 'custom', [60, 30], 2));
});

console.log('===== 三值体系 calcThreeValues =====');
test('新用户：默认 500/300', () => {
  const r = calcThreeValues({ completed: 0 }, { count: 0, avgStar: 0 });
  assert.strictEqual(r.rep, 500);
  assert.strictEqual(r.skill, 300);
});
test('好评拉满：5 星 ×10 条 → 信誉 750（E+200，按时 +50）', () => {
  const r = calcThreeValues({ completed: 10, onTimeCount: 10 }, { count: 10, avgStar: 5 });
  assert.strictEqual(r.rep, 750);
});
test('差评：1 星 ×5 条 → 信誉 350（E-200，按时 +50）', () => {
  const r = calcThreeValues({ completed: 5, onTimeCount: 5 }, { count: 5, avgStar: 1 });
  assert.strictEqual(r.rep, 350);
});
test('冷启动保护：<3 条评价不计分', () => {
  const r = calcThreeValues({ completed: 2 }, { count: 2, avgStar: 1 });
  assert.strictEqual(r.rep, 500);
});
test('违约扣分：放弃 3 次 + 取消发布 2 次 → 360（T+50，V-190）', () => {
  const r = calcThreeValues(
    { completed: 10, onTimeCount: 10, giveUpCount: 3, cancelAsPublisher: 2 },
    { count: 0, avgStar: 0 }
  );
  assert.strictEqual(r.rep, 360);
});
test('能力值：完成 15 单无违约 → 750（Q300 + S150）', () => {
  const r = calcThreeValues({ completed: 15, cancelled: 0 }, {});
  assert.strictEqual(r.skill, 750);
});
test('信誉下限 0', () => {
  const r = calcThreeValues(
    { completed: 5, giveUpCount: 10, cancelAsPublisher: 10, banCount: 3 },
    { count: 5, avgStar: 1 }
  );
  assert.strictEqual(r.rep, 0);
});

console.log('===== 名望 calcFameFromScore / calcFameGain =====');
test('名望分 0 → 0', () => assert.strictEqual(calcFameFromScore(0), 0));
test('名望分 600 → 50', () => assert.strictEqual(calcFameFromScore(600), 50));
test('名望分 3000 → 100', () => assert.strictEqual(calcFameFromScore(3000), 100));
test('名望分 20000000+ → 1000', () => assert.strictEqual(calcFameFromScore(25000000), 1000));
test('星级权重：5 星 100 银 → 300 名望分', () => assert.strictEqual(calcFameGain(100, 5), 300));
test('星级权重：1 星 100 银 → 100 名望分', () => assert.strictEqual(calcFameGain(100, 1), 100));

console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====`);
process.exit(failed ? 1 : 0);
