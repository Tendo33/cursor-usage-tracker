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
  const t = date.getTime();
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(0, Math.ceil((t - Date.now()) / 86400000));
}

/** Tooltip 内 ASCII 条宽度（字符格） */
export const TOOLTIP_ASCII_BAR_SEGMENTS = 24;

/** 纯文本条形 `[###---] 30%`（用于等宽 code 块内排版） */
export function asciiUsageBarPlain(
  percent: number | undefined,
  segments: number = TOOLTIP_ASCII_BAR_SEGMENTS,
): string {
  const w = Math.max(4, Math.min(40, Math.floor(segments)));
  if (percent == null || !Number.isFinite(percent)) {
    return `[${'-'.repeat(w)}] —`;
  }
  const label = `${Math.round(percent)}%`;
  const forFill = Math.min(100, Math.max(0, percent));
  const filled = Math.min(w, Math.max(0, Math.round((forFill / 100) * w)));
  const bar = '#'.repeat(filled) + '-'.repeat(w - filled);
  return `[${bar}] ${label}`;
}

/** Markdown 一行：内联代码包裹的条形（老接口 tooltip 等） */
export function asciiUsageBarLine(
  percent: number | undefined,
  segments: number = TOOLTIP_ASCII_BAR_SEGMENTS,
): string {
  return `\`${asciiUsageBarPlain(percent, segments)}\``;
}

/**
 * USD 状态栏主指标：若 Cursor 返回 API 分路占比，则默认按 API（占比 + 折算金额）展示；
 * 否则退回 total（与旧版一致）。
 */
function usdStatusBarPrimary(u: NonNullable<AccountSnapshot['creditUsage']>): {
  trafficPercent: number | undefined;
  usedDisplayCents: number;
  statusPercentLabel: number;
} {
  const limit = u.limitCents;
  const hasLimit = typeof limit === 'number' && limit > 0;
  const api = u.apiPercentUsed;
  if (hasLimit && typeof api === 'number' && Number.isFinite(api)) {
    return {
      trafficPercent: api,
      usedDisplayCents: Math.round((limit * api) / 100),
      statusPercentLabel: Math.round(api),
    };
  }
  return {
    trafficPercent: hasLimit ? u.percentUsed : undefined,
    usedDisplayCents: u.usedCents,
    statusPercentLabel: Math.round(u.percentUsed),
  };
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
  const primary = u && hasLimit ? usdStatusBarPrimary(u) : null;
  const icon = trafficLight(primary?.trafficPercent, t);
  const fallbackText = `${icon} ${s.plan.label}`;
  switch (format) {
    case 'percent': {
      if (!hasLimit || u == null) return fallbackText;
      return `${icon} ${primary!.statusPercentLabel}%`;
    }
    case 'amount': {
      if (u && hasLimit && primary) {
        return `${icon} ${formatDollars(primary.usedDisplayCents)}/${formatDollarsTrim(limit!)}`;
      }
      return fallbackText;
    }
    case 'amount_with_reset': {
      if (u && hasLimit && primary) {
        return `${icon} ${formatDollars(primary.usedDisplayCents)}/${formatDollarsTrim(limit!)} \u00B7${daysUntil(u.cycleEnd)}d`;
      }
      return fallbackText;
    }
    case 'amount_with_plan': {
      if (u && hasLimit && primary) {
        return `${icon} ${s.plan.label} ${formatDollars(primary.usedDisplayCents)}/${formatDollarsTrim(limit!)}`;
      }
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
