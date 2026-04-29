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
  autoPercentUsed?: number;
  apiPercentUsed?: number;
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
