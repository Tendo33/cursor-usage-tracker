# Cursor Usage Tracker v1.1 — 双轨制多账号自适应 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Cursor Usage Tracker 升级为「双轨制」插件：同时支持老的请求次数计费模型（500 次/2000 次）与新的 USD credit 计费模型（Pro $20 / Pro+ $70 / Ultra $400），插件按「老优先」策略自动识别账号属于哪种模型并选对应展示。

**Architecture:** 把 770 行单文件 `extension.ts` 拆为 4 个文件 (`auth.ts` / `cursorApi.ts` / `types.ts` / `render.ts` / `extension.ts`)。三接口并行 (`/api/usage` 老 + `GetCurrentPeriodUsage` 新 + `/api/auth/stripe`)，结果由 `mergeIntoSnapshot` 合成统一 `AccountSnapshot`（含 `billingModel: 'request_count' | 'usd_credit' | 'unknown'`），由纯函数 `renderStatusBarText` 按 `billingModel` 选不同模板。

**Tech Stack:** TypeScript 5.3, esbuild, sql.js, vscode 1.85+, node:test。无新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-04-24-multi-account-credit-adaptation-design.md`

**核心承诺：老用户体验完全无变化**。「老优先」策略保证 `maxRequestUsage > 0` 的账号显示与 v1.0.x 一致。

---

## Task 1: 抽取 `auth.ts`（无行为变化的重构）

**Files:**
- Create: `src/auth.ts`
- Create: `tests/auth.test.js`
- Modify: `src/extension.ts` — 删除已搬迁函数，改为 import

**目标：** 把 `extension.ts` 中所有"获取 userId / accessToken / cookie"逻辑搬到 `auth.ts`，零行为变化，加单元测试覆盖关键的 `extractUserIdFromOAuth`。

- [ ] **Step 1: 写失败的测试**

创建 `tests/auth.test.js`：

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

function loadAuth() {
  const p = path.join(__dirname, '..', 'out', 'auth.js');
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
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run compile && node --test tests/auth.test.js
```

预期：FAIL，`out/auth.js` 不存在。

- [ ] **Step 3: 实现 `src/auth.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import initSqlJs, { Database } from 'sql.js';

const MAX_READFILE_SIZE = 2 * 1024 * 1024 * 1024;
let cachedAccessToken: string | null = null;

export function getPossibleStoragePaths(): string[] {
  const paths: string[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    paths.push(
      path.join(appData, 'Cursor', 'sentry', 'scope_v3.json'),
      path.join(appData, 'Cursor', 'sentry', 'session.json'),
      path.join(appData, 'Cursor', 'User', 'globalStorage', 'storage.json'),
      path.join(appData, 'Cursor', 'storage.json'),
      path.join(appData, 'Cursor', 'User', 'settings.json'),
      path.join(homeDir, '.cursor', 'storage.json'),
      path.join(homeDir, '.cursor-tutor', 'storage.json'),
    );
  } else if (process.platform === 'darwin') {
    paths.push(
      path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'sentry', 'scope_v3.json'),
      path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'sentry', 'session.json'),
      path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json'),
      path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'storage.json'),
      path.join(homeDir, '.cursor', 'storage.json'),
    );
  } else {
    paths.push(
      path.join(homeDir, '.config', 'Cursor', 'sentry', 'scope_v3.json'),
      path.join(homeDir, '.config', 'Cursor', 'sentry', 'session.json'),
      path.join(homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'storage.json'),
      path.join(homeDir, '.config', 'Cursor', 'storage.json'),
      path.join(homeDir, '.cursor', 'storage.json'),
    );
  }
  return paths;
}

export function getCursorDbPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  } else if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function extractUserIdFromOAuth(oauthId: unknown): string | null {
  if (!oauthId || typeof oauthId !== 'string') return null;
  if (oauthId.includes('|')) {
    const parts = oauthId.split('|');
    const userPart = parts.find((p) => p.startsWith('user_'));
    if (userPart) return userPart;
  }
  if (oauthId.startsWith('user_')) return oauthId;
  return null;
}

function findUserIdInObject(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const key in obj) {
    const value = obj[key];
    if (typeof value === 'string' && value.startsWith('user_') && value.length > 20) return value;
    if (typeof value === 'object') {
      const found = findUserIdInObject(value);
      if (found) return found;
    }
  }
  return null;
}

async function findUserIdInPath(filePath: string, log: (m: string) => void): Promise<string | null> {
  try {
    if (!fs.existsSync(filePath)) {
      const dirPath = path.dirname(filePath);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        return await searchDirectoryForUserId(dirPath, log);
      }
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    try {
      const data = JSON.parse(content);
      if (data.scope?.user?.id) {
        const id = extractUserIdFromOAuth(data.scope.user.id);
        if (id) return id;
      }
      if (data.did) {
        const id = extractUserIdFromOAuth(data.did);
        if (id) return id;
      }
      const possibleKeys = ['cursorAuth/cachedSignInMethod', 'userId', 'user_id', 'id'];
      for (const key of possibleKeys) {
        if (typeof data[key] === 'string' && data[key].startsWith('user_')) return data[key];
      }
      return findUserIdInObject(data);
    } catch {
      const match = content.match(/user_[a-zA-Z0-9]{20,}/);
      return match ? match[0] : null;
    }
  } catch (err) {
    log(`  - failed to read file: ${err}`);
    return null;
  }
}

async function searchDirectoryForUserId(dirPath: string, log: (m: string) => void): Promise<string | null> {
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile() && (file.endsWith('.json') || file === 'storage.json')) {
        const id = await findUserIdInPath(filePath, log);
        if (id) return id;
      } else if (stat.isDirectory() && !file.startsWith('.')) {
        const id = await searchDirectoryForUserId(filePath, log);
        if (id) return id;
      }
    }
  } catch {}
  return null;
}

export async function getUserId(log: (m: string) => void = () => {}): Promise<string | null> {
  for (const p of getPossibleStoragePaths()) {
    log(`Trying path: ${p}`);
    const id = await findUserIdInPath(p, log);
    if (id) {
      log(`Successfully found user ID: ${id}`);
      return id;
    }
  }
  return null;
}

function execFileAsync(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const t = stdout.trim();
      resolve(t.length > 0 ? t : null);
    });
  });
}

async function getAccessTokenViaSqlJs(dbPath: string): Promise<string | null> {
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(__dirname, f) });
  const buf = fs.readFileSync(dbPath);
  const db: Database = new SQL.Database(buf);
  try {
    const r = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");
    if (r.length > 0 && r[0].values.length > 0) return r[0].values[0][0] as string;
    return null;
  } finally {
    db.close();
  }
}

async function getAccessTokenViaPython(dbPath: string): Promise<string | null> {
  const cmds = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  const script =
    "import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); cur = conn.cursor(); " +
    "cur.execute(\"SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1\"); " +
    "row = cur.fetchone(); print(row[0] if row and row[0] else ''); conn.close()";
  for (const cmd of cmds) {
    try {
      const tok = await execFileAsync(cmd, ['-c', script, dbPath]);
      if (tok) return tok;
    } catch {}
  }
  return null;
}

function isFileTooLargeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as NodeJS.ErrnoException).code === 'ERR_FS_FILE_TOO_LARGE';
}

export async function getAccessToken(forceRefresh = false, log: (m: string) => void = () => {}): Promise<string | null> {
  if (cachedAccessToken && !forceRefresh) return cachedAccessToken;
  if (forceRefresh) cachedAccessToken = null;

  const dbPath = getCursorDbPath();
  if (!fs.existsSync(dbPath)) {
    log(`Database file does not exist: ${dbPath}`);
    return null;
  }
  try {
    const dbSize = fs.statSync(dbPath).size;
    let token: string | null = null;
    if (dbSize >= MAX_READFILE_SIZE) {
      token = await getAccessTokenViaPython(dbPath);
    } else {
      token = await getAccessTokenViaSqlJs(dbPath);
    }
    if (token) cachedAccessToken = token;
    return token;
  } catch (err) {
    if (isFileTooLargeError(err)) {
      const token = await getAccessTokenViaPython(dbPath);
      if (token) cachedAccessToken = token;
      return token;
    }
    log(`Failed to read database: ${err}`);
    return null;
  }
}

export function clearCachedAccessToken(): void {
  cachedAccessToken = null;
}

export function buildSessionCookie(userId: string, accessToken: string): string {
  return `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`;
}

export const __test__ = { extractUserIdFromOAuth, findUserIdInObject };
```

- [ ] **Step 4: 从 `extension.ts` 删除已搬迁函数，改为 import**

在 `src/extension.ts` 顶部 import 段加上：

```typescript
import {
  getUserId,
  getAccessToken,
  clearCachedAccessToken,
  buildSessionCookie,
} from './auth';
```

并删除 `extension.ts` 中的：`getUserId`、`getPossibleStoragePaths`、`findUserIdInPath`、`extractUserIdFromOAuth`、`findUserIdInObject`、`searchDirectoryForUserId`、`getCursorDbPath`、`getAccessToken`、`getAccessTokenViaSqlJs`、`getAccessTokenViaPython`、`execFileAsync`、`isFileTooLargeError`、模块变量 `MAX_READFILE_SIZE`、`cachedAccessToken`。把所有 `cachedAccessToken = null;` 改为 `clearCachedAccessToken();`。

- [ ] **Step 5: 编译 + 测试**

```bash
npm run compile && node --test tests/auth.test.js
```

预期：5 个测试 PASS。

- [ ] **Step 6: 验证主流程未破坏**

```bash
node test-api.js
```

预期：能打印 userId、token、然后老接口请求结果（哪怕全 N/A 也属预期，不应有 stack trace）。

- [ ] **Step 7: Commit**

```bash
git add src/auth.ts tests/auth.test.js src/extension.ts
git commit -m "refactor: 抽取 auth.ts，分离 userId/token/cookie 逻辑

将 770 行单文件 extension.ts 拆分第一步：把所有用户认证相关
逻辑（路径探测、SQLite 读取、OAuth ID 解析、cookie 拼装）独立到
src/auth.ts，并补充 5 个单元测试覆盖关键路径。零行为变化。"
```

---

## Task 2: 新建 `types.ts` + `cursorApi.ts` 骨架

**Files:**
- Create: `src/types.ts`
- Create: `src/cursorApi.ts`

**目标：** 定义共享类型（含双轨制的 `BillingModel` / `LegacyRequestUsage` / `CreditUsage`）和 API 客户端骨架（含 retry 工具迁移），暂不实现具体接口调用。

- [ ] **Step 1: 创建 `src/types.ts`**

```typescript
export type BillingModel = 'request_count' | 'usd_credit' | 'unknown';

export type PlanTier = 'free' | 'pro' | 'pro_plus' | 'ultra' | 'team' | 'unknown';

export type SubscriptionStatus = 'active' | 'trialing' | 'cancelled' | 'past_due' | 'unknown';

export type SnapshotWarning =
  | 'token_expired'
  | 'over_limit'
  | 'payment_failed'
  | 'pending_cancellation'
  | 'trialing'
  | 'partial_data';

export interface PlanInfo {
  tier: PlanTier;
  label: string;
  isYearly: boolean;
  subscriptionStatus: SubscriptionStatus;
  pendingCancellationDate: string | null;
}

export interface CreditUsage {
  usedCents: number;
  limitCents?: number;
  percentUsed: number;
  cycleStart: Date;
  cycleEnd: Date;
}

export interface LegacyRequestUsage {
  used: number;
  max: number;
  percentUsed: number;
  cycleStart: Date;
  cycleEnd: Date;
}

export interface AccountSnapshot {
  fetchedAt: number;
  billingModel: BillingModel;
  plan: PlanInfo;
  creditUsage?: CreditUsage;
  legacyRequestUsage?: LegacyRequestUsage;
  prepaidBalanceCents: number;
  warnings: SnapshotWarning[];
  partial: {
    legacy: 'ok' | 'failed';
    usage: 'ok' | 'failed';
    stripe: 'ok' | 'failed';
  };
}

export interface LegacyUsageRaw {
  'gpt-4'?: {
    numRequests: number;
    numRequestsTotal: number;
    numTokens: number;
    maxRequestUsage: number | null;
    maxTokenUsage: number | null;
  };
  'gpt-3.5-turbo'?: {
    numRequests: number;
    numRequestsTotal: number;
    numTokens: number;
    maxRequestUsage: number | null;
    maxTokenUsage: number | null;
  };
  startOfMonth: string;
}

export interface CurrentPeriodUsageRaw {
  billingCycleStart: string;
  billingCycleEnd: string;
  planUsage: {
    limit?: number;
    remaining?: number;
    totalPercentUsed?: number;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
  };
  spendLimitUsage?: { limitType?: string };
  displayMessage?: string;
}

export interface StripeStatusRaw {
  membershipType?: string;
  individualMembershipType?: string;
  subscriptionStatus?: string;
  isTeamMember?: boolean;
  isYearlyPlan?: boolean;
  customerBalance?: number;
  pendingCancellationDate?: string | null;
  lastPaymentFailed?: boolean;
  trialWasCancelled?: boolean;
}

export type FetchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'unauthorized' | 'network' | 'parse' | 'http' | 'timeout'; message: string };

export interface RetryAsyncOptions {
  maxAttempts: number;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleepFn?: (ms: number) => Promise<void>;
}
```

- [ ] **Step 2: 创建 `src/cursorApi.ts` 骨架**

```typescript
import * as https from 'https';
import { buildSessionCookie } from './auth';
import type {
  AccountSnapshot,
  CurrentPeriodUsageRaw,
  FetchOutcome,
  LegacyUsageRaw,
  RetryAsyncOptions,
  StripeStatusRaw,
} from './types';

export const API_REQUEST_TIMEOUT_MS = 15000;
export const API_MAX_NETWORK_RETRIES = 3;
export const API_RETRY_BASE_DELAY_MS = 1000;

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
]);

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isRetryableNetworkError(err: unknown): boolean {
  const code = getErrorCode(err);
  if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) return true;
  const m = getErrorMessage(err);
  return /Client network socket disconnected before secure TLS connection was established/i.test(m)
    || /socket hang up/i.test(m);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function retryAsync<T>(
  op: (attempt: number) => Promise<T>,
  opts: RetryAsyncOptions,
): Promise<T> {
  const sleepFn = opts.sleepFn ?? sleep;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await op(attempt);
    } catch (err) {
      if (attempt === opts.maxAttempts || !opts.shouldRetry(err)) throw err;
      const delay = API_RETRY_BASE_DELAY_MS * attempt;
      opts.onRetry?.(err, attempt, delay);
      await sleepFn(delay);
    }
  }
  throw new Error('retryAsync exhausted without returning or throwing');
}

// 占位，由后续 task 实现
export async function fetchLegacyUsage(_userId: string, _token: string): Promise<FetchOutcome<LegacyUsageRaw>> {
  throw new Error('not implemented');
}
export async function fetchCurrentPeriodUsage(_token: string): Promise<FetchOutcome<CurrentPeriodUsageRaw>> {
  throw new Error('not implemented');
}
export async function fetchStripeStatus(_userId: string, _token: string): Promise<FetchOutcome<StripeStatusRaw>> {
  throw new Error('not implemented');
}
export function mergeIntoSnapshot(
  _legacy: FetchOutcome<LegacyUsageRaw>,
  _usage: FetchOutcome<CurrentPeriodUsageRaw>,
  _stripe: FetchOutcome<StripeStatusRaw>,
): AccountSnapshot {
  throw new Error('not implemented');
}
```

- [ ] **Step 3: 编译验证类型正确**

```bash
npm run compile
```

预期：编译成功，无类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/cursorApi.ts
git commit -m "feat: 新增 types.ts + cursorApi.ts 骨架（双轨制类型定义）

定义双轨制核心类型：
- BillingModel = 'request_count' | 'usd_credit' | 'unknown'
- LegacyRequestUsage（老接口字段）
- CreditUsage（新接口字段）
- 统一 view-model AccountSnapshot 同时容纳两种 usage

cursorApi.ts 暂为骨架，含 retry 工具与三个接口占位，
具体实现在后续 task 中完成。"
```

---

## Task 3: 实现 `fetchLegacyUsage`（老 /api/usage 接口客户端）

**Files:**
- Modify: `src/cursorApi.ts` — 实现 `fetchLegacyUsage` 与共用 `getJson` 工具
- Create: `tests/cursorApi.legacy.test.js`

**目标：** 把 v1.0.x `extension.ts` 中调用 `cursor.com/api/usage` 的逻辑迁到 `cursorApi.ts`，封装为返回 `FetchOutcome<LegacyUsageRaw>` 的纯函数（不再抛异常）。处理 308 redirect、401、JSON 解析。

- [ ] **Step 1: 写失败的测试**

创建 `tests/cursorApi.legacy.test.js`：

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const http = require('http');

function loadCursorApi() {
  const p = path.join(__dirname, '..', 'out', 'cursorApi.js');
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
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run compile && node --test tests/cursorApi.legacy.test.js
```

预期：FAIL，3 个测试都因 `not implemented` 抛错。

- [ ] **Step 3: 实现 `getJson` 工具 + `fetchLegacyUsage`**

在 `src/cursorApi.ts` 中替换 `fetchLegacyUsage` 占位实现，并新增共用的 `getJson` 函数：

```typescript
const PROD_LEGACY_URL = 'https://cursor.com/api/usage';
const PROD_STRIPE_URL = 'https://cursor.com/api/auth/stripe';

async function getJson<T>(
  url: string,
  headers: Record<string, string>,
): Promise<FetchOutcome<T>> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : require('http');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'cursor-usage-tracker/1.1',
          Accept: 'application/json',
          ...headers,
        },
      },
      (res: any) => {
        let chunks = '';
        res.on('data', (c: Buffer) => (chunks += c.toString()));
        res.on('end', () => {
          const status: number = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            resolve({ ok: false, reason: 'unauthorized', message: `HTTP ${status}` });
            return;
          }
          if (status < 200 || status >= 300) {
            resolve({ ok: false, reason: 'http', message: `HTTP ${status}: ${chunks.slice(0, 200)}` });
            return;
          }
          try {
            resolve({ ok: true, data: JSON.parse(chunks) as T });
          } catch (err) {
            resolve({ ok: false, reason: 'parse', message: getErrorMessage(err) });
          }
        });
      },
    );
    req.on('error', (err: unknown) => resolve({ ok: false, reason: 'network', message: getErrorMessage(err) }));
    req.setTimeout(API_REQUEST_TIMEOUT_MS, () => {
      const e = new Error(`Request timed out after ${API_REQUEST_TIMEOUT_MS}ms`) as NodeJS.ErrnoException;
      e.code = 'ETIMEDOUT';
      req.destroy(e);
      resolve({ ok: false, reason: 'timeout', message: e.message });
    });
    req.end();
  });
}

async function fetchLegacyUsageWithBase(userId: string, token: string, base: string): Promise<FetchOutcome<LegacyUsageRaw>> {
  const url = base === PROD_LEGACY_URL
    ? `${PROD_LEGACY_URL}?user=${userId}`
    : `${base}/api/usage?user=${userId}`;
  return getJson<LegacyUsageRaw>(url, {
    Cookie: buildSessionCookie(userId, token),
  });
}

export async function fetchLegacyUsage(userId: string, token: string): Promise<FetchOutcome<LegacyUsageRaw>> {
  return fetchLegacyUsageWithBase(userId, token, PROD_LEGACY_URL);
}

export const __test__ = { fetchLegacyUsageWithBase, getJson };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run compile && node --test tests/cursorApi.legacy.test.js
```

预期：3 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cursorApi.ts tests/cursorApi.legacy.test.js
git commit -m "feat: 实现 fetchLegacyUsage 老接口客户端

把 v1.0.x extension.ts 中调用 cursor.com/api/usage 的逻辑搬到
cursorApi.ts，封装成 FetchOutcome<LegacyUsageRaw>。提取共用的
getJson 工具函数（后续 fetchStripeStatus 也会用到）。
3 个测试覆盖正常/401/500 场景。"
```

---

## Task 4: 实现 `fetchCurrentPeriodUsage`（新主接口客户端）

**Files:**
- Modify: `src/cursorApi.ts` — 实现 `fetchCurrentPeriodUsage` + `postJson` 工具
- Create: `tests/cursorApi.fetch.test.js`

**目标：** 实现 `POST api2.cursor.sh GetCurrentPeriodUsage`。

- [ ] **Step 1: 写失败的测试**

创建 `tests/cursorApi.fetch.test.js`：

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const http = require('http');

function loadCursorApi() {
  const p = path.join(__dirname, '..', 'out', 'cursorApi.js');
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

test('fetchCurrentPeriodUsage 401 → unauthorized', async () => {
  const api = loadCursorApi();
  await withMockServer(
    (req, res) => { res.statusCode = 401; res.end('{}'); },
    async (base) => {
      const out = await api.__test__.fetchCurrentPeriodUsageWithBase('fake', base);
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'unauthorized');
    }
  );
});

test('fetchCurrentPeriodUsage 解析正常 USD payload', async () => {
  const api = loadCursorApi();
  const payload = {
    billingCycleStart: '1776986902000',
    billingCycleEnd:   '1779578902000',
    planUsage: { limit: 40000, remaining: 30000, totalPercentUsed: 25 }
  };
  await withMockServer(
    (req, res) => {
      assert.equal(req.method, 'POST');
      assert.match(req.headers.authorization ?? '', /^Bearer fake$/);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    },
    async (base) => {
      const out = await api.__test__.fetchCurrentPeriodUsageWithBase('fake', base);
      assert.equal(out.ok, true);
      assert.equal(out.data.planUsage.limit, 40000);
    }
  );
});

test('fetchCurrentPeriodUsage 500 → http', async () => {
  const api = loadCursorApi();
  await withMockServer(
    (req, res) => { res.statusCode = 500; res.end('boom'); },
    async (base) => {
      const out = await api.__test__.fetchCurrentPeriodUsageWithBase('fake', base);
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'http');
    }
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run compile && node --test tests/cursorApi.fetch.test.js
```

预期：FAIL，3 个测试都因 `not implemented` 抛错。

- [ ] **Step 3: 实现 `postJson` + `fetchCurrentPeriodUsage`**

在 `src/cursorApi.ts` 中替换 `fetchCurrentPeriodUsage` 占位实现，并新增 `postJson`：

```typescript
const PROD_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

async function postJson<T>(
  url: string,
  body: object,
  headers: Record<string, string>,
): Promise<FetchOutcome<T>> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : require('http');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'cursor-usage-tracker/1.1',
          ...headers,
        },
      },
      (res: any) => {
        let chunks = '';
        res.on('data', (c: Buffer) => (chunks += c.toString()));
        res.on('end', () => {
          const status: number = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            resolve({ ok: false, reason: 'unauthorized', message: `HTTP ${status}` });
            return;
          }
          if (status < 200 || status >= 300) {
            resolve({ ok: false, reason: 'http', message: `HTTP ${status}: ${chunks.slice(0, 200)}` });
            return;
          }
          try {
            resolve({ ok: true, data: JSON.parse(chunks) as T });
          } catch (err) {
            resolve({ ok: false, reason: 'parse', message: getErrorMessage(err) });
          }
        });
      },
    );
    req.on('error', (err: unknown) => resolve({ ok: false, reason: 'network', message: getErrorMessage(err) }));
    req.setTimeout(API_REQUEST_TIMEOUT_MS, () => {
      const e = new Error(`Request timed out after ${API_REQUEST_TIMEOUT_MS}ms`) as NodeJS.ErrnoException;
      e.code = 'ETIMEDOUT';
      req.destroy(e);
      resolve({ ok: false, reason: 'timeout', message: e.message });
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function fetchCurrentPeriodUsageWithBase(token: string, base: string): Promise<FetchOutcome<CurrentPeriodUsageRaw>> {
  const url = base === PROD_USAGE_URL
    ? PROD_USAGE_URL
    : `${base}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
  return postJson<CurrentPeriodUsageRaw>(url, {}, {
    Authorization: `Bearer ${token}`,
    'Connect-Protocol-Version': '1',
  });
}

export async function fetchCurrentPeriodUsage(token: string): Promise<FetchOutcome<CurrentPeriodUsageRaw>> {
  return fetchCurrentPeriodUsageWithBase(token, PROD_USAGE_URL);
}
```

把已有的 `__test__` 导出扩展为：

```typescript
export const __test__ = { fetchLegacyUsageWithBase, fetchCurrentPeriodUsageWithBase, getJson, postJson };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run compile && node --test tests/cursorApi.fetch.test.js
```

预期：3 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cursorApi.ts tests/cursorApi.fetch.test.js
git commit -m "feat: 实现 fetchCurrentPeriodUsage 新主接口客户端

POST api2.cursor.sh GetCurrentPeriodUsage 拿 USD credit 数据。
401/403→unauthorized、2xx→ok、其他→http、超时→timeout。
新增共用 postJson 工具。3 个 mock-server 用例覆盖主路径。"
```

---

## Task 5: 实现 `fetchStripeStatus`（plan 元数据接口）

**Files:**
- Modify: `src/cursorApi.ts` — 实现 `fetchStripeStatus`
- Create: `tests/cursorApi.stripe.test.js`

**目标：** 实现 `GET cursor.com/api/auth/stripe` 拿 plan label / customerBalance / cancellation status。

- [ ] **Step 1: 写失败的测试**

创建 `tests/cursorApi.stripe.test.js`：

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const http = require('http');

function loadCursorApi() {
  const p = path.join(__dirname, '..', 'out', 'cursorApi.js');
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
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run compile && node --test tests/cursorApi.stripe.test.js
```

预期：FAIL，因 `not implemented`。

- [ ] **Step 3: 实现 `fetchStripeStatus`**

在 `src/cursorApi.ts` 中替换 `fetchStripeStatus` 占位实现：

```typescript
async function fetchStripeStatusWithBase(userId: string, token: string, base: string): Promise<FetchOutcome<StripeStatusRaw>> {
  const url = base === PROD_STRIPE_URL ? PROD_STRIPE_URL : `${base}/api/auth/stripe`;
  return getJson<StripeStatusRaw>(url, {
    Cookie: buildSessionCookie(userId, token),
  });
}

export async function fetchStripeStatus(userId: string, token: string): Promise<FetchOutcome<StripeStatusRaw>> {
  return fetchStripeStatusWithBase(userId, token, PROD_STRIPE_URL);
}
```

把 `__test__` 导出扩展为：

```typescript
export const __test__ = {
  fetchLegacyUsageWithBase,
  fetchCurrentPeriodUsageWithBase,
  fetchStripeStatusWithBase,
  getJson,
  postJson,
};
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run compile && node --test tests/cursorApi.stripe.test.js
```

预期：2 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cursorApi.ts tests/cursorApi.stripe.test.js
git commit -m "feat: 实现 fetchStripeStatus 辅助接口客户端

GET cursor.com/api/auth/stripe 拿 plan label / customerBalance /
subscription status / pending cancellation。复用 getJson 工具。"
```

---

## Task 6: 实现 `mergeIntoSnapshot` + `render.ts`（双轨制核心）

**Files:**
- Modify: `src/cursorApi.ts` — 实现 `mergeIntoSnapshot` + `detectBillingModel` + `detectTier`
- Create: `src/render.ts` — 双 model 状态栏渲染纯函数
- Create: `tests/fixtures/usd-ultra-mid-cycle.json`
- Create: `tests/fixtures/usd-pro-near-limit.json`
- Create: `tests/fixtures/usd-free-no-limit.json`
- Create: `tests/fixtures/usd-over-limit.json`
- Create: `tests/fixtures/legacy-pro-fresh.json`
- Create: `tests/fixtures/legacy-business-mid.json`
- Create: `tests/render.test.js`

**目标：** 双轨制核心 — 把三接口 raw 数据合并成统一 view-model；按 `billingModel` 路由到对应渲染分支。

- [ ] **Step 1: 创建 6 个 fixture**

`tests/fixtures/usd-ultra-mid-cycle.json`：

```json
{
  "legacy": null,
  "usage": {
    "billingCycleStart": "1776986902000",
    "billingCycleEnd":   "1779578902000",
    "planUsage": { "limit": 40000, "remaining": 35770, "totalPercentUsed": 10.575 }
  },
  "stripe": {
    "membershipType": "ultra", "individualMembershipType": "ultra",
    "subscriptionStatus": "active", "isTeamMember": false,
    "isYearlyPlan": false, "customerBalance": 0,
    "pendingCancellationDate": null, "lastPaymentFailed": false
  }
}
```

`tests/fixtures/usd-pro-near-limit.json`：

```json
{
  "legacy": null,
  "usage": {
    "billingCycleStart": "1776986902000",
    "billingCycleEnd":   "1779578902000",
    "planUsage": { "limit": 2000, "remaining": 200, "totalPercentUsed": 90 }
  },
  "stripe": {
    "membershipType": "pro", "individualMembershipType": "pro",
    "subscriptionStatus": "active", "isTeamMember": false,
    "isYearlyPlan": false, "customerBalance": 0,
    "pendingCancellationDate": null, "lastPaymentFailed": false
  }
}
```

`tests/fixtures/usd-free-no-limit.json`：

```json
{
  "legacy": null,
  "usage": {
    "billingCycleStart": "1776986902000",
    "billingCycleEnd":   "1779578902000",
    "planUsage": { "totalPercentUsed": 35 }
  },
  "stripe": {
    "membershipType": "free",
    "subscriptionStatus": "active", "isTeamMember": false,
    "isYearlyPlan": false, "customerBalance": 0,
    "pendingCancellationDate": null, "lastPaymentFailed": false
  }
}
```

`tests/fixtures/usd-over-limit.json`：

```json
{
  "legacy": null,
  "usage": {
    "billingCycleStart": "1776986902000",
    "billingCycleEnd":   "1779578902000",
    "planUsage": { "limit": 7000, "remaining": -1000, "totalPercentUsed": 114.28 }
  },
  "stripe": {
    "membershipType": "pro_plus", "individualMembershipType": "pro_plus",
    "subscriptionStatus": "active", "isTeamMember": false,
    "isYearlyPlan": false, "customerBalance": 0,
    "pendingCancellationDate": null, "lastPaymentFailed": false
  }
}
```

`tests/fixtures/legacy-pro-fresh.json`（**老 Pro 账号 0/500**）：

```json
{
  "legacy": {
    "gpt-4": { "numRequests": 0, "numRequestsTotal": 0, "numTokens": 0, "maxRequestUsage": 500, "maxTokenUsage": null },
    "gpt-3.5-turbo": { "numRequests": 0, "numRequestsTotal": 0, "numTokens": 0, "maxRequestUsage": null, "maxTokenUsage": null },
    "startOfMonth": "2026-04-01T00:00:00.000Z"
  },
  "usage": null,
  "stripe": {
    "membershipType": "pro", "individualMembershipType": "pro",
    "subscriptionStatus": "active", "isTeamMember": false,
    "isYearlyPlan": false, "customerBalance": 0,
    "pendingCancellationDate": null, "lastPaymentFailed": false
  }
}
```

`tests/fixtures/legacy-business-mid.json`（**老 Business 账号 1200/2000**）：

```json
{
  "legacy": {
    "gpt-4": { "numRequests": 1200, "numRequestsTotal": 1200, "numTokens": 0, "maxRequestUsage": 2000, "maxTokenUsage": null },
    "gpt-3.5-turbo": { "numRequests": 0, "numRequestsTotal": 0, "numTokens": 0, "maxRequestUsage": null, "maxTokenUsage": null },
    "startOfMonth": "2026-04-01T00:00:00.000Z"
  },
  "usage": null,
  "stripe": null
}
```

- [ ] **Step 2: 写失败的测试**

创建 `tests/render.test.js`：

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');

function load(name) {
  const p = path.join(__dirname, '..', 'out', `${name}.js`);
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
  // request_count 模型（老）
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

  // usd_credit 模型（新）
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
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npm run compile && node --test tests/render.test.js
```

预期：13 个测试全部 FAIL（`mergeIntoSnapshot` 抛 `not implemented`，`out/render.js` 不存在）。

- [ ] **Step 4: 在 `src/cursorApi.ts` 实现 `detectBillingModel` + `detectTier` + `mergeIntoSnapshot`**

替换 `mergeIntoSnapshot` 占位实现，并新增辅助函数：

```typescript
import type {
  PlanTier, PlanInfo, CreditUsage, LegacyRequestUsage,
  AccountSnapshot, SnapshotWarning, SubscriptionStatus, BillingModel,
} from './types';

export function detectBillingModel(
  legacy: LegacyUsageRaw | null,
  usage: CurrentPeriodUsageRaw | null,
): BillingModel {
  const legacyMax = legacy?.['gpt-4']?.maxRequestUsage;
  const legacyUsed = legacy?.['gpt-4']?.numRequests;
  if (typeof legacyMax === 'number' && legacyMax > 0
      && typeof legacyUsed === 'number') {
    return 'request_count';
  }
  if (usage) {
    const limit = usage.planUsage?.limit;
    const pct = usage.planUsage?.totalPercentUsed;
    if ((typeof limit === 'number' && limit > 0)
        || (typeof pct === 'number' && Number.isFinite(pct))) {
      return 'usd_credit';
    }
  }
  return 'unknown';
}

export function detectTier(stripe: StripeStatusRaw | null): PlanTier {
  if (!stripe) return 'unknown';
  if (stripe.isTeamMember) return 'team';
  const m = (stripe.individualMembershipType ?? stripe.membershipType ?? '').toLowerCase();
  if (m === 'ultra') return 'ultra';
  if (m === 'pro_plus' || m === 'pro+') return 'pro_plus';
  if (m === 'pro') return 'pro';
  if (m === 'free' || m === '') return 'free';
  return 'unknown';
}

export function planLabel(tier: PlanTier): string {
  switch (tier) {
    case 'free': return 'Free';
    case 'pro': return 'Pro';
    case 'pro_plus': return 'Pro+';
    case 'ultra': return 'Ultra';
    case 'team': return 'Team';
    case 'unknown': return 'Cursor';
  }
}

function normalizeStatus(s: string | undefined): SubscriptionStatus {
  switch ((s ?? '').toLowerCase()) {
    case 'active': return 'active';
    case 'trialing': return 'trialing';
    case 'cancelled': case 'canceled': return 'cancelled';
    case 'past_due': return 'past_due';
    default: return 'unknown';
  }
}

function buildLegacyUsage(legacy: LegacyUsageRaw): LegacyRequestUsage {
  const gpt4 = legacy['gpt-4']!;
  const used = gpt4.numRequests ?? 0;
  const max = gpt4.maxRequestUsage ?? 0;
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const cycleStart = new Date(legacy.startOfMonth);
  const cycleEnd = new Date(cycleStart);
  cycleEnd.setMonth(cycleEnd.getMonth() + 1);
  return { used, max, percentUsed: pct, cycleStart, cycleEnd };
}

function buildCreditUsage(usage: CurrentPeriodUsageRaw): CreditUsage | undefined {
  const limit = typeof usage.planUsage.limit === 'number' && Number.isFinite(usage.planUsage.limit)
    ? usage.planUsage.limit : undefined;
  const remaining = typeof usage.planUsage.remaining === 'number'
    ? usage.planUsage.remaining : undefined;
  const used = (limit !== undefined && remaining !== undefined) ? limit - remaining : 0;
  const percent = typeof usage.planUsage.totalPercentUsed === 'number' && Number.isFinite(usage.planUsage.totalPercentUsed)
    ? usage.planUsage.totalPercentUsed
    : (limit && limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0);
  return {
    usedCents: used,
    limitCents: limit,
    percentUsed: percent,
    cycleStart: new Date(parseInt(usage.billingCycleStart, 10)),
    cycleEnd: new Date(parseInt(usage.billingCycleEnd, 10)),
  };
}

export function mergeIntoSnapshot(
  legacyOutcome: FetchOutcome<LegacyUsageRaw>,
  usageOutcome: FetchOutcome<CurrentPeriodUsageRaw>,
  stripeOutcome: FetchOutcome<StripeStatusRaw>,
): AccountSnapshot {
  const legacy = legacyOutcome.ok ? legacyOutcome.data : null;
  const usage = usageOutcome.ok ? usageOutcome.data : null;
  const stripe = stripeOutcome.ok ? stripeOutcome.data : null;

  const billingModel = detectBillingModel(legacy, usage);
  const tier = detectTier(stripe);

  const plan: PlanInfo = {
    tier,
    label: planLabel(tier),
    isYearly: !!stripe?.isYearlyPlan,
    subscriptionStatus: normalizeStatus(stripe?.subscriptionStatus),
    pendingCancellationDate: stripe?.pendingCancellationDate ?? null,
  };

  let creditUsage: CreditUsage | undefined;
  let legacyRequestUsage: LegacyRequestUsage | undefined;
  if (billingModel === 'request_count' && legacy) {
    legacyRequestUsage = buildLegacyUsage(legacy);
  } else if (billingModel === 'usd_credit' && usage) {
    creditUsage = buildCreditUsage(usage);
  }

  const prepaid = stripe && typeof stripe.customerBalance === 'number' && stripe.customerBalance < 0
    ? Math.abs(stripe.customerBalance)
    : 0;

  const warnings: SnapshotWarning[] = [];
  const anyUnauthorized = (!legacyOutcome.ok && legacyOutcome.reason === 'unauthorized')
    || (!usageOutcome.ok && usageOutcome.reason === 'unauthorized')
    || (!stripeOutcome.ok && stripeOutcome.reason === 'unauthorized');
  if (anyUnauthorized) warnings.push('token_expired');

  if (legacyRequestUsage && legacyRequestUsage.percentUsed >= 100) warnings.push('over_limit');
  if (creditUsage && creditUsage.percentUsed >= 100) warnings.push('over_limit');
  if (stripe?.lastPaymentFailed) warnings.push('payment_failed');
  if (stripe?.pendingCancellationDate) warnings.push('pending_cancellation');
  if (plan.subscriptionStatus === 'trialing') warnings.push('trialing');

  const partial = {
    legacy: (legacyOutcome.ok ? 'ok' : 'failed') as 'ok' | 'failed',
    usage:  (usageOutcome.ok  ? 'ok' : 'failed') as 'ok' | 'failed',
    stripe: (stripeOutcome.ok ? 'ok' : 'failed') as 'ok' | 'failed',
  };
  if (partial.legacy === 'failed' && partial.usage === 'failed') warnings.push('partial_data');
  else if (partial.stripe === 'failed') warnings.push('partial_data');

  return {
    fetchedAt: Date.now(),
    billingModel,
    plan,
    creditUsage,
    legacyRequestUsage,
    prepaidBalanceCents: prepaid,
    warnings,
    partial,
  };
}
```

- [ ] **Step 5: 创建 `src/render.ts`**

```typescript
import type { AccountSnapshot, BillingModel } from './types';

export type StatusBarFormat = 'percent' | 'amount' | 'amount_with_reset' | 'amount_with_plan';

export interface Thresholds {
  caution: number;
  warning: number;
}

export function trafficLight(percent: number | undefined, t: Thresholds): string {
  if (percent == null) return '\u{1F535}';
  if (percent >= 100) return '\u{1F534}';
  if (percent >= t.warning) return '\u{1F534}';
  if (percent >= t.caution) return '\u{1F7E1}';
  return '\u{1F7E2}';
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDollarsTrim(cents: number): string {
  const v = cents / 100;
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

function daysUntil(date: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86400000));
}

function renderRequestCount(s: AccountSnapshot, format: StatusBarFormat, t: Thresholds): string {
  const u = s.legacyRequestUsage!;
  const icon = trafficLight(u.percentUsed, t);
  switch (format) {
    case 'percent': return `${icon} ${Math.round(u.percentUsed)}%`;
    case 'amount': return `${icon} ${u.used}/${u.max}`;
    case 'amount_with_reset': return `${icon} ${u.used}/${u.max} \u00B7${daysUntil(u.cycleEnd)}d`;
    case 'amount_with_plan': return `${icon} ${s.plan.label} ${u.used}/${u.max}`;
  }
}

function renderUsdCredit(s: AccountSnapshot, format: StatusBarFormat, t: Thresholds): string {
  const u = s.creditUsage;
  const icon = trafficLight(u?.percentUsed, t);
  const limit = u?.limitCents;
  const fallbackText = `${icon} ${s.plan.label}`;
  switch (format) {
    case 'percent': {
      if (u == null) return fallbackText;
      return `${icon} ${Math.round(u.percentUsed)}%`;
    }
    case 'amount': {
      if (u && limit) return `${icon} ${formatDollars(u.usedCents)}/${formatDollarsTrim(limit)}`;
      if (u) return `${icon} ${s.plan.label} ${Math.round(u.percentUsed)}%`;
      return fallbackText;
    }
    case 'amount_with_reset': {
      if (u && limit) {
        return `${icon} ${formatDollars(u.usedCents)}/${formatDollarsTrim(limit)} \u00B7${daysUntil(u.cycleEnd)}d`;
      }
      return fallbackText;
    }
    case 'amount_with_plan': {
      if (u && limit) return `${icon} ${s.plan.label} ${formatDollars(u.usedCents)}/${formatDollarsTrim(limit)}`;
      return fallbackText;
    }
  }
}

function renderUnknown(s: AccountSnapshot, _format: StatusBarFormat, t: Thresholds): string {
  return `${trafficLight(undefined, t)} ${s.plan.label}`;
}

export function renderStatusBarText(
  snapshot: AccountSnapshot,
  format: StatusBarFormat,
  thresholds: Thresholds,
): string {
  switch (snapshot.billingModel as BillingModel) {
    case 'request_count': return renderRequestCount(snapshot, format, thresholds);
    case 'usd_credit':    return renderUsdCredit(snapshot, format, thresholds);
    case 'unknown':       return renderUnknown(snapshot, format, thresholds);
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npm run compile && node --test tests/render.test.js
```

预期：13 个测试 PASS。如果失败先看 `legacy-business-mid` 的 60% 计算 (`1200/2000 = 60`) 是否正确。

- [ ] **Step 7: Commit**

```bash
git add src/cursorApi.ts src/render.ts \
        tests/fixtures/ tests/render.test.js
git commit -m "feat: 双轨制核心 — mergeIntoSnapshot + render 纯函数

detectBillingModel 按「老优先」策略识别账号：
- legacy.gpt-4.maxRequestUsage > 0  → request_count
- usage.planUsage.limit > 0          → usd_credit
- 否则                                → unknown

mergeIntoSnapshot 把三接口结果合并成统一 AccountSnapshot，
按 billingModel 填充 legacyRequestUsage 或 creditUsage。
render.ts 为两种 model 各自实现 4 档模板。

13 个表驱动测试覆盖：
- 4 个 legacy 用例（含 amount/percent/amount_with_plan）
- 6 个 USD 用例（含 ultra/pro/free/over-limit + 3 种格式）
- partial / unauthorized / 老优先识别 边缘场景"
```

---

## Task 7: 重写 `extension.ts` 接入新管线

**Files:**
- Modify: `src/extension.ts` — 完全替换 `fetchUsageFromAPI` / `refreshUsage` / `updateStatusBar` / `createTooltip`
- Modify: `src/cursorApi.ts` — 新增 `fetchAccountSnapshot` 顶层入口

**目标：** 让 `extension.ts` 调用新的 `fetchAccountSnapshot`，状态栏走 `render.ts`，并接入新的 settings。

- [ ] **Step 1: 在 `cursorApi.ts` 末尾追加 `fetchAccountSnapshot`**

```typescript
export async function fetchAccountSnapshot(
  userId: string,
  token: string,
  log: (m: string) => void = () => {},
): Promise<AccountSnapshot> {
  const [legacy, usage, stripe] = await Promise.all([
    fetchLegacyUsage(userId, token),
    fetchCurrentPeriodUsage(token),
    fetchStripeStatus(userId, token),
  ]);
  if (!legacy.ok) log(`legacy failed: ${legacy.reason} - ${legacy.message}`);
  if (!usage.ok)  log(`usage failed: ${usage.reason} - ${usage.message}`);
  if (!stripe.ok) log(`stripe failed: ${stripe.reason} - ${stripe.message}`);
  return mergeIntoSnapshot(legacy, usage, stripe);
}
```

- [ ] **Step 2: 重写 `src/extension.ts` 主体**

完全替换文件内容（保留顶部 import 与 outputChannel 概念）：

```typescript
import * as vscode from 'vscode';
import { getUserId, getAccessToken, clearCachedAccessToken } from './auth';
import { fetchAccountSnapshot } from './cursorApi';
import { renderStatusBarText, type StatusBarFormat, type Thresholds } from './render';
import type { AccountSnapshot } from './types';

let statusBarItem: vscode.StatusBarItem;
let refreshInterval: NodeJS.Timeout | undefined;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  console.log('Cursor Usage Tracker activated');

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.tooltip = 'Cursor Usage';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursor-usage-tracker.refresh', () => refreshUsage()),
    vscode.commands.registerCommand('cursor-usage-tracker.showLogs', () => ensureOutputChannel().show()),
  );

  refreshUsage();
  setupAutoRefresh();

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('cursorUsageTracker')) {
      setupAutoRefresh();
      refreshUsage();
    }
  });
}

function ensureOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Cursor Usage Tracker');
  return outputChannel;
}

function log(message: string) {
  const ts = new Date().toLocaleTimeString();
  ensureOutputChannel().appendLine(`[${ts}] ${message}`);
  console.log(`[Cursor Usage Tracker] ${message}`);
}

function setupAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  const cfg = vscode.workspace.getConfiguration('cursorUsageTracker');
  const interval = cfg.get<number>('refreshInterval', 300) * 1000;
  refreshInterval = setInterval(() => refreshUsage(), interval);
}

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('cursorUsageTracker');
  return {
    showInStatusBar: cfg.get<boolean>('showInStatusBar', true),
    format: cfg.get<StatusBarFormat>('statusBarFormat', 'amount'),
    thresholds: {
      caution: cfg.get<number>('cautionThreshold', 40),
      warning: cfg.get<number>('warningThreshold', 70),
    } as Thresholds,
    showOverLimitToast: cfg.get<boolean>('showOverLimitToast', false),
  };
}

async function refreshUsage() {
  log('========== Starting refresh ==========');
  const config = readConfig();
  if (!config.showInStatusBar) {
    statusBarItem.hide();
    return;
  }
  statusBarItem.text = '$(sync~spin) Loading...';
  statusBarItem.show();

  const userId = await getUserId(log);
  if (!userId) {
    setErrorState('No ID', 'Unable to find Cursor user ID, click for logs');
    return;
  }

  const token = await getAccessToken(false, log);
  if (!token) {
    setErrorState('No Token', 'Unable to read Cursor accessToken, click for logs');
    return;
  }

  let snapshot = await fetchAccountSnapshot(userId, token, log);

  if (snapshot.warnings.includes('token_expired')) {
    log('token_expired detected, refreshing token and retrying once');
    clearCachedAccessToken();
    const fresh = await getAccessToken(true, log);
    if (fresh) {
      snapshot = await fetchAccountSnapshot(userId, fresh, log);
    }
  }

  applySnapshot(snapshot, config);
  log(`========== Refresh completed (model=${snapshot.billingModel}, plan=${snapshot.plan.tier}) ==========`);
}

function setErrorState(text: string, tip: string) {
  statusBarItem.text = `$(warning) ${text}`;
  statusBarItem.tooltip = tip;
  statusBarItem.command = 'cursor-usage-tracker.showLogs';
  statusBarItem.show();
}

let lastOverLimitToastFor: number | null = null;

function applySnapshot(snapshot: AccountSnapshot, config: ReturnType<typeof readConfig>) {
  const allFailed = snapshot.partial.legacy === 'failed'
    && snapshot.partial.usage === 'failed'
    && snapshot.partial.stripe === 'failed';
  if (allFailed) {
    if (snapshot.warnings.includes('token_expired')) {
      setErrorState('Re-login', 'Cursor session expired, click to view logs');
    } else {
      setErrorState('Network', 'All Cursor APIs failed, click to view logs');
    }
    return;
  }

  let text = renderStatusBarText(snapshot, config.format, config.thresholds);
  const someFailed = snapshot.partial.legacy === 'failed'
    || snapshot.partial.usage === 'failed'
    || snapshot.partial.stripe === 'failed';
  if (someFailed && snapshot.billingModel !== 'unknown') {
    text += ' \u2026';
  }
  statusBarItem.text = text;
  statusBarItem.tooltip = buildTooltip(snapshot);
  statusBarItem.command = 'cursor-usage-tracker.showLogs';
  statusBarItem.backgroundColor = undefined;
  statusBarItem.show();

  if (config.showOverLimitToast && snapshot.warnings.includes('over_limit')) {
    const cycleKey = snapshot.creditUsage?.cycleStart.getTime()
      ?? snapshot.legacyRequestUsage?.cycleStart.getTime()
      ?? null;
    if (cycleKey !== lastOverLimitToastFor) {
      vscode.window.showWarningMessage(
        `Cursor usage exceeded plan limit: ${text}. Visit cursor.com/dashboard to manage.`,
      );
      lastOverLimitToastFor = cycleKey;
    }
  }
}

function buildTooltip(s: AccountSnapshot): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;

  const planLine = s.plan.isYearly ? `${s.plan.label} (Yearly)` : s.plan.label;
  md.appendMarkdown(`### ${planLine} \u00B7 ${s.plan.subscriptionStatus}\n\n`);

  if (s.billingModel === 'request_count' && s.legacyRequestUsage) {
    const u = s.legacyRequestUsage;
    const pct = Math.round(u.percentUsed);
    const bars = 10;
    const filled = Math.min(bars, Math.max(0, Math.round((pct / 100) * bars)));
    const bar = '#'.repeat(filled) + '-'.repeat(bars - filled);
    md.appendMarkdown(`**Used:** ${u.used} / ${u.max} (${pct}%)\n\n`);
    md.appendMarkdown(`\`[${bar}] ${pct}%\`\n\n`);
    md.appendMarkdown(`**Cycle:** ${u.cycleStart.toLocaleDateString()} \u2192 ${u.cycleEnd.toLocaleDateString()}\n`);
    const days = Math.max(0, Math.ceil((u.cycleEnd.getTime() - Date.now()) / 86400000));
    md.appendMarkdown(`Resets in **${days} days**\n\n`);
  } else if (s.billingModel === 'usd_credit' && s.creditUsage) {
    const u = s.creditUsage;
    const used = (u.usedCents / 100).toFixed(2);
    const limit = u.limitCents != null ? `$${(u.limitCents / 100)}` : '\u2014';
    const pct = Math.round(u.percentUsed);
    const bars = 10;
    const filled = Math.min(bars, Math.max(0, Math.round((pct / 100) * bars)));
    const bar = '#'.repeat(filled) + '-'.repeat(bars - filled);
    md.appendMarkdown(`**Usage:** $${used} / ${limit} (${pct}%)\n\n`);
    md.appendMarkdown(`\`[${bar}] ${pct}%\`\n\n`);
    md.appendMarkdown(`**Cycle:** ${u.cycleStart.toLocaleDateString()} \u2192 ${u.cycleEnd.toLocaleDateString()}\n`);
    const days = Math.max(0, Math.ceil((u.cycleEnd.getTime() - Date.now()) / 86400000));
    md.appendMarkdown(`Resets in **${days} days**\n\n`);
  }

  if (s.prepaidBalanceCents > 0) {
    md.appendMarkdown(`**Prepaid balance:** $${(s.prepaidBalanceCents / 100).toFixed(2)}\n\n`);
  }

  if (s.warnings.length > 0) {
    md.appendMarkdown(`---\n**Warnings:**\n`);
    for (const w of s.warnings) {
      md.appendMarkdown(`- ${describeWarning(w, s)}\n`);
    }
  }

  md.appendMarkdown(`\n---\n*Billing model: \`${s.billingModel}\`*`);
  return md;
}

function describeWarning(w: AccountSnapshot['warnings'][number], s: AccountSnapshot): string {
  switch (w) {
    case 'token_expired': return 'Session expired, click to view logs';
    case 'over_limit': return 'Usage exceeded plan limit';
    case 'payment_failed': return 'Last payment failed, check Stripe billing';
    case 'pending_cancellation': return `Subscription cancels on ${s.plan.pendingCancellationDate}`;
    case 'trialing': return 'Trial period active';
    case 'partial_data': return 'Some data unavailable, will retry on next refresh';
  }
}

export function deactivate() {
  if (refreshInterval) clearInterval(refreshInterval);
}
```

- [ ] **Step 3: 编译并通过类型检查**

```bash
npm run compile
```

预期：编译成功。

- [ ] **Step 4: 用真实账号烟测**

```bash
node test-api.js
```

预期：能拿到 token / userId（test-api.js 仍调老接口，本步只是验证 token 提取链路没破）。

然后在 VSCode 里 F5 启动 Extension Development Host，观察状态栏：
- 你 Ultra 账号 + amount 模板 → 期望 `🟢 $0.00/$400`（USD 模型）
- 切换到 amount_with_plan → 期望 `🟢 Ultra $0.00/$400`
- 老 Pro 账号同事跑应该看到 `🟢 0/500`（request_count 模型）

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/cursorApi.ts
git commit -m "feat: extension.ts 切换到新管线，双轨制自动适配

- fetchAccountSnapshot 三接口并行
- 状态栏走 render.ts 纯函数，按 billingModel 自动选模板
- 401 自动清缓存重试一次
- partial 数据用 … 后缀提示
- tooltip 双 model 各自渲染 + 末尾标注 billing model
- showOverLimitToast 配置控制是否弹超额 toast
- removed: 老的 fetchUsageFromAPI/UsageData/createTooltip"
```

---

## Task 8: 配置 schema + README + CHANGELOG + 版本号

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `README_CN.md`
- Create: `CHANGELOG.md`
- Modify: `test-api.js` — 删除已迁移到 `tests/` 的 retry 测试块

**目标：** 让 marketplace 用户能看到新 settings、知道双轨制，并记录变更。

- [ ] **Step 1: 更新 `package.json`**

修改 `version` 为 `1.1.0`，并替换 `contributes.configuration.properties` 为：

```json
{
  "cursorUsageTracker.refreshInterval": {
    "type": "number",
    "default": 300,
    "description": "自动刷新间隔(秒)，默认 5 分钟"
  },
  "cursorUsageTracker.showInStatusBar": {
    "type": "boolean",
    "default": true,
    "description": "是否在状态栏显示配额"
  },
  "cursorUsageTracker.statusBarFormat": {
    "type": "string",
    "enum": ["percent", "amount", "amount_with_reset", "amount_with_plan"],
    "enumDescriptions": [
      "仅百分比，例如 🟢 11%",
      "金额或次数，例如 🟢 $42.30/$400 或 🟢 0/500 (默认)",
      "金额/次数 + 周期重置倒计时，例如 🟢 $42.30/$400 ·7d",
      "金额/次数 + 计划名，例如 🟢 Ultra $42.30/$400"
    ],
    "default": "amount",
    "description": "状态栏显示格式（双轨制：自动按账号选金额或次数）"
  },
  "cursorUsageTracker.warningThreshold": {
    "type": "number",
    "default": 70,
    "minimum": 0,
    "maximum": 100,
    "description": "红灯阈值（百分比），用量达到该值时显示红色警告"
  },
  "cursorUsageTracker.cautionThreshold": {
    "type": "number",
    "default": 40,
    "minimum": 0,
    "maximum": 100,
    "description": "黄灯阈值（百分比），用量达到该值时显示黄色提示"
  },
  "cursorUsageTracker.showOverLimitToast": {
    "type": "boolean",
    "default": false,
    "description": "超额时弹出系统通知（默认关，避免打扰）"
  }
}
```

- [ ] **Step 2: 更新 `README_CN.md` 增加双轨制说明段**

在 README_CN.md 顶部"功能"或"特性"段后追加：

```markdown
## 支持的账号类型（双轨制）

本插件自动识别账号属于哪种 Cursor 计费模型并选对应展示：

### 请求次数模型（老账号，500/2000 次/月）

| 账号 | 显示示例 |
|---|---|
| Pro 老账号 | `🟢 0/500` |
| Business 老账号 | `🟡 1200/2000` |

### USD Credit 模型（新账号，2025 末迁移）

| 账号 | 显示示例 |
|---|---|
| Free | `🔵 Free` |
| Pro ($20/月) | `🟢 $0.00/$20` |
| Pro+ ($60/月, $70 included) | `🟢 $0.00/$70` |
| Ultra ($200/月, $400 included) | `🟢 $0.00/$400` |
| Team 成员（个人视角） | `🟢 $0.00/$XX` |

> 「老优先」策略：若老接口仍返回有效次数（`maxRequestUsage > 0`），优先按请求次数展示；否则切到 USD credit。老用户体验完全不变。

> 数据来源为 Cursor 浏览器同款的内部接口，未官方公开，可能随版本变化。

## 状态栏格式

可在 settings 里通过 `cursorUsageTracker.statusBarFormat` 选 4 种模板：

- `percent` — 仅百分比（如 `🟢 11%`，两种模型通用）
- `amount`（默认）— 金额或次数（USD 账号 `🟢 $42.30/$400`，老账号 `🟢 0/500`）
- `amount_with_reset` — 加重置倒计时（`🟢 $42.30/$400 ·7d`）
- `amount_with_plan` — 加计划名（`🟢 Ultra $42.30/$400`）
```

`README.md` 同步英文版本（结构一样）。

- [ ] **Step 3: 创建 `CHANGELOG.md`**

```markdown
# Changelog

## 1.1.0 — 2026-04-24

### 新增

- **双轨制**：同时支持「请求次数」与「USD credit」两种 Cursor 计费模型
- **自动账号识别**：插件按「老优先」策略自动判断账号类型
  - 老接口 `maxRequestUsage > 0` → 显示次数（保留 v1.0.x 体验）
  - 否则 → 显示 USD（适配 Pro / Pro+ / Ultra / Free / Team）
- **4 档显示模板**：`percent` / `amount` / `amount_with_reset` / `amount_with_plan`
- **可配置阈值**：`warningThreshold` (默认 70) / `cautionThreshold` (默认 40)
- **超额 toast**：可选 `showOverLimitToast`，默认关
- **三接口并行**：legacy + GetCurrentPeriodUsage + stripe，任一失败仍能展示部分数据
- **细化错误状态**：401 自动清 token 重试 / 网络故障专门提示 / partial 数据用 `…` 后缀

### 变更

- 代码拆分为 `auth.ts` / `cursorApi.ts` / `render.ts` / `extension.ts` / `types.ts`
- 测试迁移到 `tests/` 目录，新增 fixture 表驱动用例（4 USD + 2 legacy）
- v1.0.x 调用 `/api/usage` 的逻辑搬到 `cursorApi.ts::fetchLegacyUsage`，作为双轨制中的 legacy 数据源继续保留

### 兼容性

- **老用户体验完全无变化**。「老优先」策略保证 `maxRequestUsage > 0` 的账号显示与 v1.0.x 完全一致
- 旧 settings 全保留，新 settings 走默认值，无需用户操作

### 已知限制

- Free 账号 fixture 来自社区文档，第一次跑 Free 账号可能需要微调
- Enterprise 账号需要 Admin API Key，本版本不支持
```

- [ ] **Step 4: 简化 `test-api.js`**

删除 `test-api.js` 中 `if (process.env.NODE_TEST_CONTEXT)` 整个块（4 个测试已搬迁到 `tests/`），保留 `main()` + `getUserId/getAccessToken/fetchUsage` 这部分作为「老接口快速验证脚本」。在文件顶部加一行注释：

```javascript
// 这是老 /api/usage 接口的快速验证脚本，仅供调试用。
// 单元测试请运行: node --test tests/
```

- [ ] **Step 5: 跑全部测试 + 编译**

```bash
npm run compile && node --test tests/
```

预期：~21 个测试全部通过（5 auth + 3 legacy + 3 usage + 2 stripe + 13 render = 26 实际 = 包括 partial/unauthorized/老优先识别）。

- [ ] **Step 6: 打包验证 vsix**

```bash
npm run package
ls -la cursor-usage-tracker-1.1.0.vsix
```

预期：生成 `cursor-usage-tracker-1.1.0.vsix`。

- [ ] **Step 7: Commit**

```bash
git add package.json README.md README_CN.md CHANGELOG.md test-api.js
git commit -m "chore: bump 1.1.0 + 新 settings schema + README + CHANGELOG (双轨制)

- package.json: 4 个新 settings (statusBarFormat / 两阈值 / toast 开关)
- README/README_CN: 新增双轨制说明 + 两种账号类型展示对照表
- CHANGELOG.md: 1.1.0 完整变更说明，强调老用户体验不变
- test-api.js: 移除已搬迁到 tests/ 的 retry 测试，保留接口验证脚本"
```

---

## Self-Review Checklist

跑完后对照 spec 章节自检：

- ✅ §4 数据源 — Task 3/4/5 实现三个接口
- ✅ §5 架构 — Task 1/2 拆 auth.ts + cursorApi.ts + types.ts，Task 6/7 实现 render.ts + 重写 extension.ts
- ✅ §5.3 view-model — Task 2 定义 `AccountSnapshot`（含 `billingModel` + `legacyRequestUsage` + `creditUsage`），Task 6 实现合并
- ✅ §6 多账号识别 — Task 6 `detectBillingModel`（老优先）+ `detectTier`，6 fixture 覆盖 ultra/pro/free/over-limit/legacy-pro/legacy-business
- ✅ §7 状态栏渲染 — Task 6 `render.ts`，按 billingModel 路由到 renderRequestCount / renderUsdCredit / renderUnknown
- ✅ §7.3 tooltip — Task 7 `buildTooltip` 双分支
- ✅ §8 错误矩阵 — Task 7 `applySnapshot` 处理 401/network/over_limit/partial（双 model）
- ✅ §9 配置 — Task 8 package.json（无 useLegacyApi 开关，自动识别）
- ✅ §10 测试 — Task 1/3/4/5/6 测试用例
- ✅ §11 迁移 — Task 8 README/CHANGELOG/版本号，强调"老用户体验不变"
- ⚠️ Trial / pending_cancellation 没专门 fixture（warning 逻辑已实现但未跑过）
- ⚠️ pro_plus 的 `membershipType` 实际值未实测（detectTier 同时处理 `pro_plus` 和 `pro+`）
- ⚠️ "老优先 + 同时返回有效数据" 场景已加测试 (`detectBillingModel: 老优先`)，但生产环境实际能否同时拿到两份数据待观察

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-24-multi-account-credit-adaptation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每 task 派一个新 subagent，task 间复核，迭代快

**2. Inline Execution** — 在当前会话里按 task 1→8 顺序执行，每 1-2 个 task checkpoint 一次
