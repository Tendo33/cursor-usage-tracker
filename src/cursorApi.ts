import * as https from 'https';
import * as http from 'http';
import { buildSessionCookie } from './auth';
import type {
  AccountSnapshot,
  CurrentPeriodUsageRaw,
  FetchOutcome,
  LegacyUsageRaw,
  RetryAsyncOptions,
  StripeStatusRaw,
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
export function mergeIntoSnapshot(
  _legacy: FetchOutcome<LegacyUsageRaw>,
  _usage: FetchOutcome<CurrentPeriodUsageRaw>,
  _stripe: FetchOutcome<StripeStatusRaw>,
): AccountSnapshot {
  throw new Error('not implemented');
}

export const __test__ = {
  fetchLegacyUsageWithBase,
  fetchCurrentPeriodUsageWithBase,
  fetchStripeStatusWithBase,
  getJson,
  postJson,
};
