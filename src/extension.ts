import * as vscode from 'vscode';
import { getUserId, getAccessToken, clearCachedAccessToken } from './auth';
import { fetchAccountSnapshot } from './cursorApi';
import {
  asciiUsageBarLine,
  asciiUsageBarPlain,
  normalizeRefreshSeconds,
  normalizeThresholds,
  renderStatusBarText,
  type StatusBarFormat,
} from './render';
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

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorUsageTracker')) {
        setupAutoRefresh();
        refreshUsage();
      }
    }),
    { dispose: () => { if (refreshInterval) clearInterval(refreshInterval); } },
  );
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
  const interval = normalizeRefreshSeconds(cfg.get<number>('refreshInterval', 300)) * 1000;
  refreshInterval = setInterval(() => refreshUsage(), interval);
}

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('cursorUsageTracker');
  return {
    showInStatusBar: cfg.get<boolean>('showInStatusBar', true),
    format: cfg.get<StatusBarFormat>('statusBarFormat', 'amount'),
    thresholds: normalizeThresholds(
      cfg.get<number>('cautionThreshold', 40),
      cfg.get<number>('warningThreshold', 70),
    ),
    showOverLimitToast: cfg.get<boolean>('showOverLimitToast', false),
  };
}

let refreshInFlight: Promise<void> | null = null;

/**
 * Single-flight wrapper: the timer, config changes and the manual command can
 * all trigger a refresh. Without this, overlapping runs could finish out of
 * order (an older, slower response overwriting a newer one), and any thrown
 * error became an unhandled rejection that left the bar stuck on "Loading...".
 */
function refreshUsage(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshUsage()
    .catch((err) => {
      log(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      setErrorState('Error', 'Refresh failed, click for logs');
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

async function doRefreshUsage() {
  log('========== Starting refresh ==========');
  const config = readConfig();
  if (!config.showInStatusBar) {
    statusBarItem.hide();
    return;
  }
  // Only show the spinner on the very first load; afterwards keep the last value visible
  if (!lastGood) {
    statusBarItem.text = '$(sync~spin) Loading...';
  }
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

const OWN_COMMANDS = ['cursor-usage-tracker.refresh', 'cursor-usage-tracker.showLogs'];

let lastGood: { text: string; snapshot: AccountSnapshot; at: Date } | null = null;

function setErrorState(text: string, tip: string) {
  if (lastGood) {
    // Keep the last good numbers instead of wiping them out on a transient failure
    statusBarItem.text = `${lastGood.text} $(warning)`;
    statusBarItem.tooltip = buildTooltip(lastGood.snapshot, lastGood.at, `${text}: ${tip}`);
  } else {
    statusBarItem.text = `$(warning) ${text}`;
    statusBarItem.tooltip = tooltipWithActions(new vscode.MarkdownString(`${tip}\n\n`));
  }
  statusBarItem.command = 'cursor-usage-tracker.refresh';
  statusBarItem.show();
}

function tooltipWithActions(md: vscode.MarkdownString): vscode.MarkdownString {
  md.isTrusted = { enabledCommands: OWN_COMMANDS };
  md.supportThemeIcons = true;
  md.appendMarkdown(
    '[$(refresh) Refresh](command:cursor-usage-tracker.refresh) \u00B7 '
    + '[$(output) Logs](command:cursor-usage-tracker.showLogs) \u00B7 '
    + '[$(link-external) Dashboard](https://cursor.com/dashboard)',
  );
  return md;
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
  const now = new Date();
  lastGood = { text, snapshot, at: now };
  statusBarItem.text = text;
  statusBarItem.tooltip = buildTooltip(snapshot, now);
  statusBarItem.command = 'cursor-usage-tracker.refresh';
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

function buildTooltip(s: AccountSnapshot, updatedAt: Date, refreshError?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();

  const planLine = s.plan.isYearly ? `${s.plan.label} (Yearly)` : s.plan.label;
  md.appendMarkdown(`### ${planLine} \u00B7 ${s.plan.subscriptionStatus}\n\n`);

  if (s.billingModel === 'request_count' && s.legacyRequestUsage) {
    const u = s.legacyRequestUsage;
    const pct = Math.round(u.percentUsed);
    md.appendMarkdown(`**Used:** ${u.used} / ${u.max} (${pct}%)\n\n`);
    md.appendMarkdown(`${asciiUsageBarLine(u.percentUsed)}\n\n`);
    md.appendMarkdown(`**Renews:** ${u.cycleEnd.toLocaleDateString()}\n\n`);
  } else if (s.billingModel === 'usd_credit' && s.creditUsage) {
    const u = s.creditUsage;
    const limit = u.limitCents != null ? `$${(u.limitCents / 100)}` : '\u2014';
    const totalPct = Math.round(u.percentUsed);
    const usedTotal = (u.usedCents / 100).toFixed(2);
    const labelW = 20;
    const pad = (t: string) => (t.length >= labelW ? t : t + ' '.repeat(labelW - t.length));
    const row = (title: string, pct: number | undefined) =>
      `${pad(title)}\n${asciiUsageBarPlain(pct)}`;
    const lines: string[] = [];
    if (u.limitCents != null && u.limitCents > 0) {
      lines.push(`Included pool  $${usedTotal} / ${limit}  (total ${totalPct}%)`, '');
    }
    lines.push(row('Total', u.percentUsed), '', row('Auto + Composer', u.autoPercentUsed), '', row('API', u.apiPercentUsed));
    md.appendMarkdown('```text\n');
    md.appendMarkdown(lines.join('\n'));
    md.appendMarkdown(`\n\`\`\`\n\n**Renews:** ${u.cycleEnd.toLocaleDateString()}\n\n`);
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

  md.appendMarkdown(`---\n_Updated ${updatedAt.toLocaleTimeString()}_`);
  if (refreshError) {
    md.appendMarkdown(` \u00B7 $(warning) Last refresh failed: ${escapeMd(refreshError)}`);
  }
  md.appendMarkdown('\n\n');
  return tooltipWithActions(md);
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

function escapeMd(text: string): string {
  return text.replace(/[\\`*_[\]()<>#|]/g, '\\$&');
}

export function deactivate() {
  if (refreshInterval) clearInterval(refreshInterval);
}
