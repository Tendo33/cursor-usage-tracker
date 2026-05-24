const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');

function load(name) {
  const p = path.join(__dirname, '..', 'out-tests', `${name}.js`);
  const orig = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return {};
    return orig.call(this, req, parent, isMain);
  };
  delete require.cache[require.resolve(p)];
  try { return require(p); } finally { Module._load = orig; }
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function snapshotFromFixture(api, fx) {
  return api.mergeIntoSnapshot(
    fx.legacy ? { ok: true, data: fx.legacy } : { ok: false, reason: 'http', message: 'fixture has no legacy' },
    fx.usage  ? { ok: true, data: fx.usage  } : { ok: false, reason: 'http', message: 'fixture has no usage' },
    fx.stripe ? { ok: true, data: fx.stripe } : { ok: false, reason: 'http', message: 'fixture has no stripe' },
  );
}

const cases = [
  { name: 'legacy Pro 0/500 → 绿灯',
    fixture: 'legacy-pro-fresh.json', format: 'amount',
    expectModel: 'request_count', expectText: /^🟢 0\/500$/ },
  { name: 'legacy Business 1200/2000 (60%) → 黄灯',
    fixture: 'legacy-business-mid.json', format: 'amount',
    expectModel: 'request_count', expectText: /^🟡 1200\/2000$/ },
  { name: 'legacy + amount_with_plan → 含 plan label',
    fixture: 'legacy-pro-fresh.json', format: 'amount_with_plan',
    expectText: /^🟢 Pro 0\/500$/ },
  { name: 'legacy + percent → 60%',
    fixture: 'legacy-business-mid.json', format: 'percent',
    expectText: /^🟡 60%$/ },

  { name: 'USD Ultra (10%) → 绿灯 + 金额',
    fixture: 'usd-ultra-mid-cycle.json', format: 'amount',
    expectModel: 'usd_credit', expectText: /^🟢 \$42\.30\/\$400$/ },
  { name: 'USD Pro near-limit (90%) → 红灯',
    fixture: 'usd-pro-near-limit.json', format: 'amount',
    expectModel: 'usd_credit', expectText: /^🔴 \$18\.00\/\$20$/ },
  { name: 'USD Free no limit → 蓝灯 + Free 文本',
    fixture: 'usd-free-no-limit.json', format: 'amount',
    expectModel: 'usd_credit', expectText: /^🔵 Free$/ },
  { name: 'USD over-limit (>100%) → 红灯 + over_limit warning',
    fixture: 'usd-over-limit.json', format: 'amount',
    expectModel: 'usd_credit', expectText: /^🔴 /, expectWarning: 'over_limit' },
  { name: 'USD percent format',
    fixture: 'usd-ultra-mid-cycle.json', format: 'percent',
    expectText: /^🟢 11%$/ },
  { name: 'USD amount_with_plan format',
    fixture: 'usd-ultra-mid-cycle.json', format: 'amount_with_plan',
    expectText: /^🟢 Ultra \$42\.30\/\$400$/ },

  // followup: amount_with_reset 模板 — 用 ·\d+d 模式断言（不断言具体天数避免依赖 Date.now）
  { name: 'USD amount_with_reset format → 含 ·Nd 倒计时',
    fixture: 'usd-ultra-mid-cycle.json', format: 'amount_with_reset',
    expectText: /^🟢 \$42\.30\/\$400 ·\d+d$/ },
  { name: 'legacy amount_with_reset format → 含 ·Nd 倒计时',
    fixture: 'legacy-pro-fresh.json', format: 'amount_with_reset',
    expectText: /^🟢 0\/500 ·\d+d$/ },
];

for (const c of cases) {
  test(c.name, () => {
    const api = load('cursorApi');
    const render = load('render');
    const fx = loadFixture(c.fixture);
    const snapshot = snapshotFromFixture(api, fx);
    if (c.expectModel) assert.equal(snapshot.billingModel, c.expectModel);
    if (c.expectWarning) assert.ok(snapshot.warnings.includes(c.expectWarning),
      `expected warning ${c.expectWarning}, got: ${snapshot.warnings.join(',')}`);
    const text = render.renderStatusBarText(snapshot, c.format, { caution: 40, warning: 70 });
    assert.match(text, c.expectText);
  });
}

test('partial: usage 失败但 stripe ok → snapshot.partial.usage = failed', () => {
  const api = load('cursorApi');
  const fx = loadFixture('usd-ultra-mid-cycle.json');
  const snapshot = api.mergeIntoSnapshot(
    { ok: false, reason: 'http', message: 'no legacy' },
    { ok: false, reason: 'network', message: 'boom' },
    { ok: true, data: fx.stripe },
  );
  assert.equal(snapshot.partial.usage, 'failed');
  assert.equal(snapshot.partial.stripe, 'ok');
  assert.equal(snapshot.creditUsage, undefined);
  assert.equal(snapshot.legacyRequestUsage, undefined);
  assert.ok(snapshot.warnings.includes('partial_data'));
});

test('unauthorized: 任一接口 401 → token_expired warning', () => {
  const api = load('cursorApi');
  const snapshot = api.mergeIntoSnapshot(
    { ok: false, reason: 'unauthorized', message: 'HTTP 401' },
    { ok: false, reason: 'unauthorized', message: 'HTTP 401' },
    { ok: false, reason: 'unauthorized', message: 'HTTP 401' },
  );
  assert.ok(snapshot.warnings.includes('token_expired'));
  assert.equal(snapshot.partial.legacy, 'failed');
  assert.equal(snapshot.partial.usage, 'failed');
  assert.equal(snapshot.partial.stripe, 'failed');
});

test('detectBillingModel: 老优先 — 老接口和新接口都有时仍走 request_count', () => {
  const api = load('cursorApi');
  const legacyFx = loadFixture('legacy-pro-fresh.json');
  const usdFx = loadFixture('usd-ultra-mid-cycle.json');
  const snapshot = api.mergeIntoSnapshot(
    { ok: true, data: legacyFx.legacy },
    { ok: true, data: usdFx.usage },
    { ok: true, data: usdFx.stripe },
  );
  assert.equal(snapshot.billingModel, 'request_count');
  assert.ok(snapshot.legacyRequestUsage);
  assert.equal(snapshot.legacyRequestUsage.max, 500);
});

test('regression: legacy cycleEnd 必须在 UTC 下精确 +1 月，不受本地时区影响', () => {
  const api = load('cursorApi');
  const snapshot = api.mergeIntoSnapshot(
    { ok: true, data: {
      'gpt-4': { numRequests: 10, numRequestsTotal: 10, numTokens: 0,
                 maxRequestUsage: 500, maxTokenUsage: null },
      'gpt-3.5-turbo': { numRequests: 0, numRequestsTotal: 0, numTokens: 0,
                         maxRequestUsage: null, maxTokenUsage: null },
      startOfMonth: '2026-04-01T00:00:00.000Z',
    } },
    { ok: false, reason: 'http', message: '' },
    { ok: false, reason: 'http', message: '' },
  );
  const u = snapshot.legacyRequestUsage;
  assert.ok(u);
  assert.equal(u.cycleStart.toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(u.cycleEnd.toISOString(),   '2026-05-01T00:00:00.000Z');
});

test('regression: 非法 billingCycleStart 不应产生 NaN cycleEnd / ·NaNd', () => {
  const api = load('cursorApi');
  const snapshot = api.mergeIntoSnapshot(
    { ok: false, reason: 'http', message: '' },
    { ok: true, data: {
      billingCycleStart: 'not-a-number',
      billingCycleEnd: '',
      planUsage: { limit: 1000, remaining: 500, totalPercentUsed: 50 },
    } },
    { ok: false, reason: 'http', message: '' },
  );
  assert.ok(snapshot.creditUsage);
  assert.ok(Number.isFinite(snapshot.creditUsage.cycleStart.getTime()),
    `cycleStart should be finite, got ${snapshot.creditUsage.cycleStart}`);
  assert.ok(Number.isFinite(snapshot.creditUsage.cycleEnd.getTime()),
    `cycleEnd should be finite, got ${snapshot.creditUsage.cycleEnd}`);
});

test('usd_credit: 保留 Cursor 返回的 API/Auto 分路占比', () => {
  const api = load('cursorApi');
  const snapshot = api.mergeIntoSnapshot(
    { ok: false, reason: 'http', message: '' },
    { ok: true, data: {
      billingCycleStart: '1776986902000',
      billingCycleEnd: '1779578902000',
      planUsage: {
        limit: 40000,
        remaining: 5179,
        totalPercentUsed: 23,
        autoPercentUsed: 1,
        apiPercentUsed: 69,
      },
    } },
    { ok: true, data: {
      membershipType: 'ultra', individualMembershipType: 'ultra',
      subscriptionStatus: 'active', isTeamMember: false, isYearlyPlan: false,
      customerBalance: 0, pendingCancellationDate: null, lastPaymentFailed: false,
    } },
  );
  assert.ok(snapshot.creditUsage);
  assert.equal(snapshot.creditUsage.percentUsed, 23);
  assert.equal(snapshot.creditUsage.autoPercentUsed, 1);
  assert.equal(snapshot.creditUsage.apiPercentUsed, 69);
});

test('usd_credit: 无 remaining 时由 totalPercentUsed 反推已用金额（Ultra 等接口缺省）', () => {
  const api = load('cursorApi');
  const render = load('render');
  const snapshot = api.mergeIntoSnapshot(
    { ok: false, reason: 'http', message: '' },
    { ok: true, data: {
      billingCycleStart: '1776986902000',
      billingCycleEnd: '1779578902000',
      planUsage: {
        limit: 40000,
        totalPercentUsed: 30,
        autoPercentUsed: 2,
        apiPercentUsed: 86,
      },
    } },
    { ok: true, data: {
      membershipType: 'ultra', individualMembershipType: 'ultra',
      subscriptionStatus: 'active', isTeamMember: false, isYearlyPlan: false,
      customerBalance: 0, pendingCancellationDate: null, lastPaymentFailed: false,
    } },
  );
  assert.ok(snapshot.creditUsage);
  assert.equal(snapshot.creditUsage.usedCents, 12000);
  assert.equal(snapshot.creditUsage.percentUsed, 30);
  const t = { caution: 40, warning: 70 };
  // 有 apiPercentUsed 时状态栏默认走 API：86% → 红灯 + $344/$400
  assert.match(
    render.renderStatusBarText(snapshot, 'amount', t),
    /^🔴 \$344\.00\/\$400$/,
  );
});

test('warning: payment_failed 触发条件 — stripe.lastPaymentFailed=true', () => {
  const api = load('cursorApi');
  const snapshot = api.mergeIntoSnapshot(
    { ok: false, reason: 'http', message: '' },
    { ok: true, data: {
      billingCycleStart: '1776986902000', billingCycleEnd: '1779578902000',
      planUsage: { limit: 2000, remaining: 1500, totalPercentUsed: 25 },
    } },
    { ok: true, data: {
      membershipType: 'pro', individualMembershipType: 'pro',
      subscriptionStatus: 'active', isTeamMember: false, isYearlyPlan: false,
      customerBalance: 0, pendingCancellationDate: null,
      lastPaymentFailed: true,
    } },
  );
  assert.ok(snapshot.warnings.includes('payment_failed'),
    `expected payment_failed, got: ${snapshot.warnings.join(',')}`);
});

test('warning: pending_cancellation 触发 + tooltip 字段 plan.pendingCancellationDate', () => {
  const api = load('cursorApi');
  const snapshot = api.mergeIntoSnapshot(
    { ok: false, reason: 'http', message: '' },
    { ok: true, data: {
      billingCycleStart: '1776986902000', billingCycleEnd: '1779578902000',
      planUsage: { limit: 2000, remaining: 1500, totalPercentUsed: 25 },
    } },
    { ok: true, data: {
      membershipType: 'pro', individualMembershipType: 'pro',
      subscriptionStatus: 'active', isTeamMember: false, isYearlyPlan: false,
      customerBalance: 0, pendingCancellationDate: '2026-05-15',
      lastPaymentFailed: false,
    } },
  );
  assert.ok(snapshot.warnings.includes('pending_cancellation'));
  assert.equal(snapshot.plan.pendingCancellationDate, '2026-05-15');
});

test('renderUnknown: billingModel=unknown → 蓝灯 + plan label，所有 format 都退化', () => {
  const api = load('cursorApi');
  const render = load('render');
  const snapshot = api.mergeIntoSnapshot(
    { ok: false, reason: 'http', message: '' },
    { ok: false, reason: 'http', message: '' },
    { ok: true, data: {
      membershipType: 'pro', individualMembershipType: 'pro',
      subscriptionStatus: 'active', isTeamMember: false, isYearlyPlan: false,
      customerBalance: 0, pendingCancellationDate: null, lastPaymentFailed: false,
    } },
  );
  assert.equal(snapshot.billingModel, 'unknown');
  const t = { caution: 40, warning: 70 };
  for (const fmt of ['percent', 'amount', 'amount_with_reset', 'amount_with_plan']) {
    assert.match(
      render.renderStatusBarText(snapshot, fmt, t),
      /^🔵 Pro$/,
      `format=${fmt} should fallback to '🔵 Pro'`,
    );
  }
});

test('prepaidBalanceCents: stripe.customerBalance 为负 → 取绝对值作为预付余额', () => {
  const api = load('cursorApi');
  const snapshot = api.mergeIntoSnapshot(
    { ok: false, reason: 'http', message: '' },
    { ok: false, reason: 'http', message: '' },
    { ok: true, data: {
      membershipType: 'ultra', individualMembershipType: 'ultra',
      subscriptionStatus: 'active', isTeamMember: false, isYearlyPlan: false,
      customerBalance: -5000,
      pendingCancellationDate: null, lastPaymentFailed: false,
    } },
  );
  assert.equal(snapshot.prepaidBalanceCents, 5000);
});
