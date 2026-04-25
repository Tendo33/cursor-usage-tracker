# Cursor Usage Tracker v1.1 — 双轨制（请求次数 + USD credit）多账号自适应

> 来源：2026-04-24 brainstorming 会话（v2，加入双轨制）
> 状态：✅ 已完成澄清，待实施

## 1. 背景与问题

Cursor 在 2025 年末统一了所有付费个人计划的计费模型，从「按请求次数（GPT-4 500 次/月、Business 2000 次）」迁移到「按 USD credit（Pro $20、Pro+ $70、Ultra $400 included）」。

**关键现实**：迁移并不彻底。
- 仍有大量历史账号（包括少量个人 Pro、教育版、特殊套餐）保留在请求次数模型，老接口 `/api/usage` 返回 `gpt-4.maxRequestUsage > 0`。
- 新账号（含目前所有新订阅的 Pro / Pro+ / Ultra / Free / Team 成员）走 USD credit 模型，老接口对其返回 null。

本插件 v1.0.x 仅识别请求次数模型；用户当前账号是 Ultra，状态栏显示成 `🟢 N/A/N/A`。但作为面向「所有人」的插件，**不能直接抛弃老用户**。

## 2. 目标

- ✅ **双轨制**：同时支持请求次数 + USD credit 两种计费模型
- ✅ **自动识别**：插件自动判断当前账号属于哪种模型并选对应展示
- ✅ **老优先策略**：若老接口仍返回有效数据（`maxRequestUsage > 0`），优先按请求次数展示，保护老用户体验不变
- ✅ 覆盖账号：Free / Pro / Pro+ / Ultra / Team（个人视角）+ 历史请求次数账号
- ✅ 状态栏 4 档可配模板，对两种模型都给出渲染规则
- ✅ 错误处理细化（401 / 超额 / 网络故障）
- ✅ 三接口并行容错，任一接口失败不导致空白
- ✅ 轻度模块拆分提升可测性
- ✅ 表驱动测试覆盖 4 种 USD 账号 + 2 种 legacy 账号 fixture

## 3. 非目标

- ❌ Team 池子聚合视角
- ❌ Enterprise（要求用户配 Admin API Key）
- ❌ 历史发票 / 趋势图（YAGNI）

## 4. 数据源（三接口并行）

### 4.1 老接口 — `/api/usage`（保留，供请求次数模型用户）

```http
GET https://cursor.com/api/usage?user=<userId>
Cookie: WorkosCursorSessionToken=<userId>%3A%3A<accessToken>
```

返回（v1.0.x 已使用，无需更改逻辑）：

```jsonc
{
  "gpt-4": {
    "numRequests": 0,           // 已用次数
    "numRequestsTotal": 0,
    "numTokens": 0,
    "maxRequestUsage": 500,     // 上限。null = 该账号已迁移到 USD credit
    "maxTokenUsage": null
  },
  "gpt-3.5-turbo": { ... },
  "startOfMonth": "2026-04-01T00:00:00.000Z"
}
```

### 4.2 新主接口 — `GetCurrentPeriodUsage`

```http
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
Authorization: Bearer <accessToken>
Connect-Protocol-Version: 1
Content-Type: application/json

{}
```

返回（cents、unix-ms 字符串）：

```jsonc
{
  "billingCycleStart": "1776986902000",
  "billingCycleEnd":   "1779578902000",
  "planUsage": {
    "limit":            40000,
    "remaining":        40000,
    "totalPercentUsed": 0
  },
  "spendLimitUsage": { "limitType": "user" }
}
```

### 4.3 辅助接口 — `/api/auth/stripe`

```http
GET https://cursor.com/api/auth/stripe
Cookie: WorkosCursorSessionToken=<userId>%3A%3A<accessToken>
```

```jsonc
{
  "membershipType": "ultra",
  "subscriptionStatus": "active",
  "isTeamMember": false,
  "isYearlyPlan": false,
  "customerBalance": 0,
  "pendingCancellationDate": null,
  "lastPaymentFailed": false
}
```

### 4.4 调用策略

`Promise.allSettled([fetchLegacy, fetchUsage, fetchStripe])` 三接口并行，由 `mergeIntoSnapshot()` 按以下优先级合成统一 view-model：

1. **请求次数模型识别**（老优先）：若 `legacy['gpt-4'].maxRequestUsage > 0` → `billingModel = 'request_count'`
2. **USD credit 模型识别**：上一步未命中且 `usage.planUsage.limit > 0` → `billingModel = 'usd_credit'`
3. **Free 账号**：上两步都没命中且 `usage.planUsage.totalPercentUsed` 是有限数 → `billingModel = 'usd_credit'`（Free 也走 USD 渲染，只是没 limit）
4. **未知**：以上都没命中 → `billingModel = 'unknown'`，状态栏显示 plan label fallback

任一接口失败 → 在 `partial` 字段标记，剩余接口仍能合成可用 snapshot。

## 5. 架构

### 5.1 文件结构

```text
src/
├── extension.ts        # 入口 + 生命周期 + 状态栏接入（约 280 行）
├── auth.ts             # User ID 解析 + accessToken 读取 + cookie 拼装
├── cursorApi.ts        # 三接口客户端 + view-model 合并
├── render.ts           # 状态栏纯函数（双 model 渲染）
├── types.ts            # 共享类型
└── sql.js.d.ts         # 已有，保留

tests/
├── fixtures/
│   ├── usd-ultra-mid-cycle.json       # USD: Ultra 11%
│   ├── usd-pro-near-limit.json        # USD: Pro 90%
│   ├── usd-free-no-limit.json         # USD: Free 无 limit
│   ├── usd-over-limit.json            # USD: Pro+ 114%
│   ├── legacy-pro-fresh.json          # 请求次数: Pro 0/500
│   ├── legacy-business-mid.json       # 请求次数: Business 1200/2000
│   └── legacy-token-expired.json      # 请求次数: 401
├── auth.test.js
├── cursorApi.fetch.test.js
├── cursorApi.stripe.test.js
├── cursorApi.legacy.test.js
└── render.test.js
```

### 5.2 模块依赖（单向）

```text
extension.ts ──→ render.ts ──→ types.ts
       └────→ cursorApi.ts ──→ auth.ts
                     └──────→ types.ts
```

`cursorApi.ts` 不依赖 `vscode`，便于单测。

### 5.3 统一 view-model

```typescript
export type BillingModel = 'request_count' | 'usd_credit' | 'unknown';

export type PlanTier = 'free' | 'pro' | 'pro_plus' | 'ultra' | 'team' | 'unknown';

export type SnapshotWarning =
  | 'token_expired'
  | 'over_limit'
  | 'payment_failed'
  | 'pending_cancellation'
  | 'trialing'
  | 'partial_data';

export interface PlanInfo {
  tier: PlanTier;
  label: string;                         // "Ultra" / "Pro+" / "Free" / etc.
  isYearly: boolean;
  subscriptionStatus: 'active' | 'trialing' | 'cancelled' | 'past_due' | 'unknown';
  pendingCancellationDate: string | null;
}

export interface CreditUsage {
  usedCents: number;
  limitCents?: number;                   // Free 没有
  percentUsed: number;
  cycleStart: Date;
  cycleEnd: Date;
}

export interface LegacyRequestUsage {
  used: number;                          // numRequests
  max: number;                           // maxRequestUsage
  percentUsed: number;                   // 派生
  cycleStart: Date;                      // startOfMonth
  cycleEnd: Date;                        // startOfMonth + 1 month
}

export interface AccountSnapshot {
  fetchedAt: number;
  billingModel: BillingModel;
  plan: PlanInfo;
  creditUsage?: CreditUsage;             // billingModel === 'usd_credit'
  legacyRequestUsage?: LegacyRequestUsage; // billingModel === 'request_count'
  prepaidBalanceCents: number;
  warnings: SnapshotWarning[];
  partial: {
    legacy: 'ok' | 'failed';
    usage: 'ok' | 'failed';
    stripe: 'ok' | 'failed';
  };
}
```

## 6. 多账号识别

```typescript
function detectBillingModel(
  legacy: LegacyUsageRaw | null,
  usage: CurrentPeriodUsageRaw | null,
): BillingModel {
  // 老优先：老接口报有效次数 → request_count
  const legacyMax = legacy?.['gpt-4']?.maxRequestUsage;
  const legacyUsed = legacy?.['gpt-4']?.numRequests;
  if (typeof legacyMax === 'number' && legacyMax > 0
      && typeof legacyUsed === 'number') {
    return 'request_count';
  }
  // 否则看新接口
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

function detectTier(stripe: StripeStatusRaw | null): PlanTier {
  if (!stripe) return 'unknown';
  if (stripe.isTeamMember) return 'team';
  const m = (stripe.individualMembershipType ?? stripe.membershipType ?? '').toLowerCase();
  if (m === 'ultra') return 'ultra';
  if (m === 'pro_plus' || m === 'pro+') return 'pro_plus';
  if (m === 'pro') return 'pro';
  if (m === 'free' || m === '') return 'free';
  return 'unknown';
}
```

## 7. 状态栏渲染

### 7.1 双模型 4 档模板对照

| `statusBarFormat` | `request_count`（老） | `usd_credit`（新 USD） | `unknown` |
|---|---|---|---|
| `percent` | `🟢 0%` | `🟢 11%` | `🟢 Cursor` |
| `amount`（默认） | `🟢 0/500` | `🟢 $42.30/$400` | `🟢 Cursor` |
| `amount_with_reset` | `🟢 0/500 ·7d` | `🟢 $42.30/$400 ·7d` | `🟢 Cursor ·7d` |
| `amount_with_plan` | `🟢 Pro 0/500` | `🟢 Ultra $42.30/$400` | `🟢 Cursor` |

注意：`amount` 模板对老用户**完全保留 v1.0.x 显示**（`🟢 0/500`），不破坏现有体验。Free 账号（USD 但无 limit）退化为 `🔵 Free`。

### 7.2 交通灯（两模型共享）

```typescript
function trafficLight(percent: number | undefined, t: { caution: number; warning: number }): string {
  if (percent == null) return '🔵';
  if (percent >= 100) return '🔴';
  if (percent >= t.warning) return '🔴';
  if (percent >= t.caution) return '🟡';
  return '🟢';
}
```

### 7.3 Tooltip

按 `billingModel` 分两套：

**`request_count` tooltip**（保留 v1.0.x 风格）：
```
### Pro · active
Used: 0 / 500 (0%)
[----------] 0%
Cycle: Apr 1 → May 1 (resets in 7d)
```

**`usd_credit` tooltip**：
```
### Ultra · active
Usage: $42.30 / $400 (11%)
[#---------] 11%
Cycle: Mar 22 → Apr 22 (resets in 7d)
Prepaid balance: $5.00         ← 仅 customerBalance < 0 时
---
Warnings:
- ...
```

## 8. 错误处理矩阵

| 触发条件 | 检测点 | StatusBar | Tooltip | 自动动作 |
|---|---|---|---|---|
| 任一接口 401 | usage/legacy/stripe | `$(warning) Re-login` | "Token 过期" | 清缓存 token + 重试 1 次 |
| 请求次数超额 | `legacyRequestUsage.percentUsed >= 100` | `🔴 X/Y` | 超额警告 | 可选 toast |
| USD 超额 | `creditUsage.percentUsed >= 100` | `🔴 $X/$Y` | 超额警告 | 可选 toast |
| 三接口全失败 | allSettled 全 rejected | `$(error) Network` | 错误详情 | 现有 retry (3 次指数退避) |
| 部分降级 | allSettled 部分成功 | 正常 + `…` 后缀 | 标注哪些失败 | 下次刷新自动恢复 |
| Trial | `subscriptionStatus === 'trialing'` | `🟢 Trial · X/Y` | trial 信息 | warning |
| Pending cancel | `pendingCancellationDate` | 正常 | "Cancels on YYYY-MM-DD" | warning |

## 9. 配置项

```jsonc
{
  "cursorUsageTracker.refreshInterval":     { "type": "number", "default": 300 },         // 已有
  "cursorUsageTracker.showInStatusBar":     { "type": "boolean", "default": true },        // 已有
  "cursorUsageTracker.statusBarFormat":     {
    "type": "string",
    "enum": ["percent","amount","amount_with_reset","amount_with_plan"],
    "default": "amount"
  },
  "cursorUsageTracker.warningThreshold":    { "type": "number", "default": 70, "minimum": 0, "maximum": 100 },
  "cursorUsageTracker.cautionThreshold":    { "type": "number", "default": 40, "minimum": 0, "maximum": 100 },
  "cursorUsageTracker.showOverLimitToast":  { "type": "boolean", "default": false }
}
```

**没有** 加 `useLegacyApi` 开关，因为「老优先」策略对老用户而言行为完全等同于 v1.0.x，无需用户感知。

## 10. 测试

### 10.1 表驱动渲染测试

`tests/render.test.js`（关键用例）：

```javascript
const cases = [
  // request_count 模型（老）
  { fixture: 'legacy-pro-fresh.json',     format: 'amount', expectModel: 'request_count', expectText: /^🟢 0\/500$/ },
  { fixture: 'legacy-business-mid.json',  format: 'amount', expectModel: 'request_count', expectText: /^🟡 1200\/2000$/ },
  { fixture: 'legacy-pro-fresh.json',     format: 'amount_with_plan', expectText: /^🟢 Pro 0\/500$/ },

  // usd_credit 模型（新）
  { fixture: 'usd-ultra-mid-cycle.json',  format: 'amount', expectModel: 'usd_credit', expectText: /^🟡 \$42\.30\/\$400$/ },
  { fixture: 'usd-pro-near-limit.json',   format: 'amount', expectModel: 'usd_credit', expectText: /^🔴 \$18\.00\/\$20$/ },
  { fixture: 'usd-free-no-limit.json',    format: 'amount', expectModel: 'usd_credit', expectText: /^🔵 Free$/ },
  { fixture: 'usd-over-limit.json',       format: 'amount', expectModel: 'usd_credit', expectText: /^🔴 / },

  // percent 通用
  { fixture: 'usd-ultra-mid-cycle.json',  format: 'percent', expectText: /^🟢 11%$/ },
  { fixture: 'legacy-business-mid.json',  format: 'percent', expectText: /^🟡 60%$/ },
];
```

### 10.2 已有测试保留 + 迁移

- TLS retry 重试逻辑测试（迁到 `tests/retry.test.js`）
- workflow 检查测试（保留在 `test-api.js` 或迁到 `tests/`）

### 10.3 验收命令

```bash
npm run compile && node --test tests/
```

预期：~22 测试通过（5 auth + 3 usage + 2 stripe + 2 legacy + 9 render + 1 partial）

## 11. 迁移与发版

- `package.json` version 升到 `1.1.0`
- **老用户体验完全无变化**（auto 模式、老优先策略保证显示和 v1.0.x 完全一致）
- 新 settings 走默认值，无需用户操作
- README / README_CN 增补：双轨制说明 + 4 档模板说明
- CHANGELOG 新增 1.1.0 条目，强调"非破坏性升级，老账号显示不变"

## 12. 风险

- **逆向接口可能变更**：Cursor 官方未公开 `GetCurrentPeriodUsage`，README 标注"数据来源为浏览器同款逆向接口，可能随版本失效"
- **三接口并行的请求成本**：每次刷新 3 次 HTTP，5 分钟一次 → 36 次/小时，远低于任何 rate limit
- **老接口未来下线**：Cursor 可能停掉 `/api/usage`。届时 `detectBillingModel` 第一步永远返回 false，自动 fallback 到 USD 模型，无感降级
- **Free 账号 fixture 来自社区文档**：第一次跑 Free 账号时 `limitCents` undefined 行为可能需要微调
- **请求次数账号现在是少数派**：fixture 设计基于 v1.0.x 老代码里的 `UsageData` 类型推断；上线后留意是否有遗漏字段

## 13. 实施清单（高层）

详见 `docs/superpowers/plans/2026-04-24-multi-account-credit-adaptation.md`。

8 个 task（v2 比 v1 多 1 个 — 增加 legacy 接口客户端独立 task），每个 2–5 分钟，含完整 TDD 步骤：

1. 抽取 `auth.ts`（不改行为，纯重构 + 单测）
2. 新建 `types.ts` + `cursorApi.ts` 骨架
3. **新增**：实现 `fetchLegacyUsage` + 单测（老接口移到 cursorApi.ts）
4. 实现 `fetchCurrentPeriodUsage` + 单测
5. 实现 `fetchStripeStatus` + 单测
6. 实现 `mergeIntoSnapshot`（含 `detectBillingModel`）+ `render.ts` + 表驱动测试（双模型 fixture）
7. 重写 `extension.ts` 渲染部分 + 接入新配置
8. 更新 package.json 配置 + README + CHANGELOG + 版本号
