const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

function loadAuth() {
  const p = path.join(__dirname, '..', 'out-tests', 'auth.js');
  const orig = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return {};
    return orig.call(this, req, parent, isMain);
  };
  delete require.cache[require.resolve(p)];
  try { return require(p); } finally { Module._load = orig; }
}

test('extractUserIdFromOAuth 处理 google-oauth2| 前缀', () => {
  const auth = loadAuth();
  assert.equal(
    auth.__test__.extractUserIdFromOAuth('google-oauth2|user_01J87EEM44VT22PEP4HM8A3GSG'),
    'user_01J87EEM44VT22PEP4HM8A3GSG'
  );
});

test('extractUserIdFromOAuth 处理 auth0| 前缀', () => {
  const auth = loadAuth();
  assert.equal(
    auth.__test__.extractUserIdFromOAuth('auth0|user_01KP9MSH54BWENV115BHMEHD11'),
    'user_01KP9MSH54BWENV115BHMEHD11'
  );
});

test('extractUserIdFromOAuth 处理无前缀的纯 user_ ID', () => {
  const auth = loadAuth();
  assert.equal(auth.__test__.extractUserIdFromOAuth('user_01ABCDEF'), 'user_01ABCDEF');
});

test('extractUserIdFromOAuth 对 null/empty 返回 null', () => {
  const auth = loadAuth();
  assert.equal(auth.__test__.extractUserIdFromOAuth(null), null);
  assert.equal(auth.__test__.extractUserIdFromOAuth(''), null);
  assert.equal(auth.__test__.extractUserIdFromOAuth('garbage'), null);
});

test('buildSessionCookie 生成正确的 URL-encoded cookie', () => {
  const auth = loadAuth();
  assert.equal(
    auth.buildSessionCookie('user_abc', 'token_xyz'),
    'WorkosCursorSessionToken=user_abc%3A%3Atoken_xyz'
  );
});
