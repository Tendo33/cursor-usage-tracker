# Changelog

## 1.1.1 — 2026-04-29

### 修复

- USD credit tooltip 新增分路占比展示：`API xx% · Auto xx%`
- 保留并透传 Cursor `planUsage.autoPercentUsed` / `planUsage.apiPercentUsed`
- 补充测试，确保 total / api / auto 占比字段被正确写入 snapshot

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

## 1.0.3

详见 README 「更新记录」段。
