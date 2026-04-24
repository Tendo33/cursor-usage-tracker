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
