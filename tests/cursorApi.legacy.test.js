const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const http = require('http');

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

function withMockServer(handler, run) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      try { resolve(await run(`http://127.0.0.1:${port}`)); }
      catch (e) { reject(e); }
      finally { server.close(); }
    });
  });
}

test('fetchLegacyUsage 解析老 /api/usage 返回的 500 次结构', async () => {
  const api = loadCursorApi();
  const payload = {
    'gpt-4': { numRequests: 0, numRequestsTotal: 0, numTokens: 0, maxRequestUsage: 500, maxTokenUsage: null },
    'gpt-3.5-turbo': { numRequests: 0, numRequestsTotal: 0, numTokens: 0, maxRequestUsage: null, maxTokenUsage: null },
    startOfMonth: '2026-04-01T00:00:00.000Z',
  };
  await withMockServer(
    (req, res) => {
      assert.match(req.url, /^\/api\/usage\?user=user_abc$/);
      assert.match(req.headers.cookie ?? '', /^WorkosCursorSessionToken=user_abc%3A%3Atok$/);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    },
    async (base) => {
      const out = await api.__test__.fetchLegacyUsageWithBase('user_abc', 'tok', base);
      assert.equal(out.ok, true);
      assert.equal(out.data['gpt-4'].maxRequestUsage, 500);
      assert.equal(out.data['gpt-4'].numRequests, 0);
      assert.equal(out.data.startOfMonth, '2026-04-01T00:00:00.000Z');
    }
  );
});

test('fetchLegacyUsage 把 401 映射为 unauthorized', async () => {
  const api = loadCursorApi();
  await withMockServer(
    (req, res) => { res.statusCode = 401; res.end('{}'); },
    async (base) => {
      const out = await api.__test__.fetchLegacyUsageWithBase('user_abc', 'tok', base);
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'unauthorized');
    }
  );
});

test('fetchLegacyUsage 把 500 映射为 http 错误', async () => {
  const api = loadCursorApi();
  await withMockServer(
    (req, res) => { res.statusCode = 500; res.end('boom'); },
    async (base) => {
      const out = await api.__test__.fetchLegacyUsageWithBase('user_abc', 'tok', base);
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'http');
    }
  );
});
