const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

function loadCursorApi() {
  const p = path.join(__dirname, '..', 'out-tests', 'cursorApi.js');
  const orig = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return {};
    return orig.call(this, req, parent, isMain);
  };
  delete require.cache[require.resolve(p)];
  try { return require(p); } finally { Module._load = orig; }
}

test('withNetworkRetry: network 错误重试至上限后返回 network outcome', async () => {
  const api = loadCursorApi();
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return { ok: false, reason: 'network', message: 'socket hang up' };
  };
  // 用环境变量替换 sleep 避免真实等待 — 简单 trick：让 fn 立即回 outcome，retry 内部 sleep
  // 时间由 API_RETRY_BASE_DELAY_MS * attempt 决定。这里只验证 calls 次数与最终 outcome。
  const t0 = Date.now();
  const out = await api.__test__.withNetworkRetry('test', fn, () => {});
  const elapsed = Date.now() - t0;
  assert.equal(calls, api.API_MAX_NETWORK_RETRIES, `expected ${api.API_MAX_NETWORK_RETRIES} attempts, got ${calls}`);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'network');
  assert.match(out.message, /socket hang up/);
  // sleep total = 1000 + 2000 = 3000ms (attempt 间)，加宽容裕度
  assert.ok(elapsed >= 2500, `expected >=2500ms total backoff, got ${elapsed}ms`);
});

test('withNetworkRetry: 第二次重试成功直接返回成功 outcome', async () => {
  const api = loadCursorApi();
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls < 2) return { ok: false, reason: 'network', message: 'ECONNRESET' };
    return { ok: true, data: { hello: 'world' } };
  };
  const out = await api.__test__.withNetworkRetry('test', fn, () => {});
  assert.equal(calls, 2);
  assert.equal(out.ok, true);
  assert.deepEqual(out.data, { hello: 'world' });
});

test('withNetworkRetry: 401 unauthorized 不重试，直接返回', async () => {
  const api = loadCursorApi();
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return { ok: false, reason: 'unauthorized', message: 'HTTP 401' };
  };
  const out = await api.__test__.withNetworkRetry('test', fn, () => {});
  assert.equal(calls, 1, '401 should not retry');
  assert.equal(out.reason, 'unauthorized');
});

test('withNetworkRetry: http 5xx 不重试（保留 v1.0.3 行为：仅 network 重试）', async () => {
  const api = loadCursorApi();
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return { ok: false, reason: 'http', message: 'HTTP 503' };
  };
  const out = await api.__test__.withNetworkRetry('test', fn, () => {});
  assert.equal(calls, 1, 'http should not retry');
  assert.equal(out.reason, 'http');
});
