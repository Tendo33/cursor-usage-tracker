import * as https from 'https';
import * as http from 'http';
import { buildSessionCookie } from './auth';
import type {
  AccountSnapshot,
  BillingModel,
  CreditUsage,
  CurrentPeriodUsageRaw,
  FetchOutcome,
  LegacyRequestUsage,
  LegacyUsageRaw,
  PlanInfo,
  PlanTier,
  RetryAsyncOptions,
  SnapshotWarning,
  StripeStatusRaw,
  SubscriptionStatus,
} from './types';

const PROD_LEGACY_URL = 'https://cursor.com/api/usage';
const PROD_STRIPE_URL = 'https://cursor.com/api/auth/stripe';
const PROD_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

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

async function getJson<T>(
  url: string,
  headers: Record<string, string>,
): Promise<FetchOutcome<T>> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
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
      (res) => {
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

async function postJson<T>(
  url: string,
  body: object,
  headers: Record<string, string>,
): Promise<FetchOutcome<T>> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
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
      (res) => {
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

async function fetchLegacyUsageWithBase(
  userId: string,
  token: string,
  base: string,
): Promise<FetchOutcome<LegacyUsageRaw>> {
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

async function fetchStripeStatusWithBase(userId: string, token: string, base: string): Promise<FetchOutcome<StripeStatusRaw>> {
  const url = base === PROD_STRIPE_URL ? PROD_STRIPE_URL : `${base}/api/auth/stripe`;
  return getJson<StripeStatusRaw>(url, {
    Cookie: buildSessionCookie(userId, token),
  });
}

export async function fetchStripeStatus(userId: string, token: string): Promise<FetchOutcome<StripeStatusRaw>> {
  return fetchStripeStatusWithBase(userId, token, PROD_STRIPE_URL);
}
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

function safeMs(s: string | undefined): number | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function buildLegacyUsage(legacy: LegacyUsageRaw): LegacyRequestUsage {
  const gpt4 = legacy['gpt-4']!;
  const used = gpt4.numRequests ?? 0;
  const max = gpt4.maxRequestUsage ?? 0;
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const cycleStart = new Date(legacy.startOfMonth);
  // 注意：必须用 UTC 方法推导下个周期开始，否则在 UTC- 时区会因
  // 本地日期回退一天 + setMonth 越界回滚而比预期多 1 天。
  const cycleEnd = new Date(Date.UTC(
    cycleStart.getUTCFullYear(),
    cycleStart.getUTCMonth() + 1,
    cycleStart.getUTCDate(),
    cycleStart.getUTCHours(),
    cycleStart.getUTCMinutes(),
    cycleStart.getUTCSeconds(),
  ));
  return { used, max, percentUsed: pct, cycleStart, cycleEnd };
}

function buildCreditUsage(usage: CurrentPeriodUsageRaw): CreditUsage | undefined {
  const pu = usage.planUsage;
  const limit = typeof pu.limit === 'number' && Number.isFinite(pu.limit)
    ? pu.limit : undefined;
  const remaining = typeof pu.remaining === 'number' && Number.isFinite(pu.remaining)
    ? pu.remaining : undefined;
  const explicitUsed = typeof pu.used === 'number' && Number.isFinite(pu.used)
    ? pu.used : undefined;
  const pctFromApi = typeof pu.totalPercentUsed === 'number' && Number.isFinite(pu.totalPercentUsed)
    ? pu.totalPercentUsed
    : undefined;

  // 已用量：优先服务端 used；否则 limit−remaining；若 Ultra 等套餐不再下发 remaining，
  // 仅用 limit 与 totalPercentUsed 反推金额，避免 $0.00 与 30% 同时出现。
  let usedCents = 0;
  if (explicitUsed !== undefined) {
    usedCents = explicitUsed;
  } else if (limit !== undefined && remaining !== undefined) {
    usedCents = limit - remaining;
  } else if (limit !== undefined && limit > 0 && pctFromApi !== undefined) {
    usedCents = Math.round((limit * pctFromApi) / 100);
  }

  const percent = pctFromApi !== undefined
    ? pctFromApi
    : (limit && limit > 0 ? Math.max(0, Math.min(100, (usedCents / limit) * 100)) : 0);
  const autoPercent = typeof pu.autoPercentUsed === 'number'
    && Number.isFinite(pu.autoPercentUsed)
    ? pu.autoPercentUsed
    : undefined;
  const apiPercent = typeof pu.apiPercentUsed === 'number'
    && Number.isFinite(pu.apiPercentUsed)
    ? pu.apiPercentUsed
    : undefined;
  // 防御异常 timestamp（缺失/空串/非数字）：宁可不展示日期，也不让 UI 出现 ·NaNd
  const startMs = safeMs(usage.billingCycleStart);
  const endMs = safeMs(usage.billingCycleEnd);
  const cycleStart = startMs !== undefined ? new Date(startMs) : new Date(0);
  const cycleEnd = endMs !== undefined ? new Date(endMs) : new Date(0);
  return {
    usedCents: usedCents,
    limitCents: limit,
    percentUsed: percent,
    autoPercentUsed: autoPercent,
    apiPercentUsed: apiPercent,
    cycleStart,
    cycleEnd,
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

async function withNetworkRetry<T>(
  channel: string,
  fetchFn: () => Promise<FetchOutcome<T>>,
  log: (m: string) => void,
): Promise<FetchOutcome<T>> {
  // 把 outcome.reason === 'network' 视为可重试错误（恢复 v1.0.3 行为：
  // 瞬时 TLS / socket hang up / ECONNRESET 在单次 refresh 内自动重试）。
  // 其余 reason（unauthorized / http / parse / timeout）一律视为终态，不重试。
  const RETRYABLE_TAG = '__retryable_network__:';
  try {
    return await retryAsync(
      async () => {
        const outcome = await fetchFn();
        if (!outcome.ok && outcome.reason === 'network') {
          throw new Error(RETRYABLE_TAG + outcome.message);
        }
        return outcome;
      },
      {
        maxAttempts: API_MAX_NETWORK_RETRIES,
        shouldRetry: (e) => e instanceof Error && e.message.startsWith(RETRYABLE_TAG),
        onRetry: (e, attempt, delay) => {
          const msg = e instanceof Error ? e.message.slice(RETRYABLE_TAG.length) : String(e);
          log(`${channel} retry ${attempt}/${API_MAX_NETWORK_RETRIES - 1} after ${delay}ms: ${msg}`);
        },
      },
    );
  } catch (e) {
    const msg = e instanceof Error
      ? (e.message.startsWith(RETRYABLE_TAG) ? e.message.slice(RETRYABLE_TAG.length) : e.message)
      : String(e);
    return { ok: false, reason: 'network', message: msg };
  }
}

export async function fetchAccountSnapshot(
  userId: string,
  token: string,
  log: (m: string) => void = () => {},
): Promise<AccountSnapshot> {
  const [legacy, usage, stripe] = await Promise.all([
    withNetworkRetry('legacy', () => fetchLegacyUsage(userId, token), log),
    withNetworkRetry('usage', () => fetchCurrentPeriodUsage(token), log),
    withNetworkRetry('stripe', () => fetchStripeStatus(userId, token), log),
  ]);
  if (!legacy.ok) log(`legacy failed: ${legacy.reason} - ${legacy.message}`);
  if (!usage.ok)  log(`usage failed: ${usage.reason} - ${usage.message}`);
  if (!stripe.ok) log(`stripe failed: ${stripe.reason} - ${stripe.message}`);
  return mergeIntoSnapshot(legacy, usage, stripe);
}

export const __test__ = {
  fetchLegacyUsageWithBase,
  fetchCurrentPeriodUsageWithBase,
  fetchStripeStatusWithBase,
  getJson,
  postJson,
  withNetworkRetry,
};
