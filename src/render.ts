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
  const limit = u?.limitCents;
  const hasLimit = typeof limit === 'number' && limit > 0;
  const icon = trafficLight(hasLimit ? u?.percentUsed : undefined, t);
  const fallbackText = `${icon} ${s.plan.label}`;
  switch (format) {
    case 'percent': {
      if (!hasLimit || u == null) return fallbackText;
      return `${icon} ${Math.round(u.percentUsed)}%`;
    }
    case 'amount': {
      if (u && hasLimit) return `${icon} ${formatDollars(u.usedCents)}/${formatDollarsTrim(limit!)}`;
      return fallbackText;
    }
    case 'amount_with_reset': {
      if (u && hasLimit) {
        return `${icon} ${formatDollars(u.usedCents)}/${formatDollarsTrim(limit!)} \u00B7${daysUntil(u.cycleEnd)}d`;
      }
      return fallbackText;
    }
    case 'amount_with_plan': {
      if (u && hasLimit) return `${icon} ${s.plan.label} ${formatDollars(u.usedCents)}/${formatDollarsTrim(limit!)}`;
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
