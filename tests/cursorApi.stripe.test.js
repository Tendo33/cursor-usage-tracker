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

test('fetchStripeStatus 解析 ultra 账号 payload', async () => {
  const api = loadCursorApi();
  const payload = {
    membershipType: 'ultra', individualMembershipType: 'ultra',
    subscriptionStatus: 'active', customerBalance: 0, isTeamMember: false,
  };
  await withMockServer(
    (req, res) => {
      assert.match(req.headers.cookie ?? '', /^WorkosCursorSessionToken=user_abc%3A%3Atok_xyz$/);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    },
    async (base) => {
      const out = await api.__test__.fetchStripeStatusWithBase('user_abc', 'tok_xyz', base);
      assert.equal(out.ok, true);
      assert.equal(out.data.membershipType, 'ultra');
    }
  );
});

test('fetchStripeStatus 401 → unauthorized', async () => {
  const api = loadCursorApi();
  await withMockServer(
    (req, res) => { res.statusCode = 401; res.end('{}'); },
    async (base) => {
      const out = await api.__test__.fetchStripeStatusWithBase('user_abc', 'tok_xyz', base);
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'unauthorized');
    }
  );
});
