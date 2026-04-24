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
