# 🎯 Cursor Usage Tracker

<p align="center">
  <img src="https://img.shields.io/badge/Platform-VSCode%20%7C%20Cursor-blue?style=for-the-badge&logo=visual-studio-code" />
  <img src="https://img.shields.io/badge/Version-1.0.1-green?style=for-the-badge" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" />
</p>

> 🔋 在状态栏实时显示你的 Cursor 剩余配额

---

# 仅针对 500 次请求的订阅用户，余额显示暂不支持

## ✨ 功能特性

- 📊 **状态栏实时显示** - 随时查看 Cursor 配额使用情况（已用/总量）
- 🎨 **悬浮提示详情** - 鼠标悬停状态栏查看详细配额信息
- 🔄 **自动刷新** - 可配置自动刷新间隔（默认 5 分钟）
- 🔔 **智能预警** - 配额使用超过 40%/70% 时状态栏变色提醒
- 🖥️ **跨平台支持** - Windows / macOS / Linux

---

## 📦 安装方式

### 方式一：从 VSIX 文件安装（推荐）

1. **打包插件**

   ```bash
   cd cursor-usage-tracker
   npm install
   npm run compile
   npm run package
   ```

   这会在项目根目录生成 `cursor-usage-tracker-1.0.1.vsix` 文件。

2. **安装到 Cursor / VSCode**

   - 打开 Cursor 或 VSCode
   - 按 `Ctrl+Shift+P` (Windows/Linux) 或 `Cmd+Shift+P` (macOS)
   - 输入 `Extensions: Install from VSIX...`
   - 选择刚才生成的 `.vsix` 文件
   - 重启编辑器

### 方式二：开发模式运行

1. **克隆并安装依赖**

   ```bash
   git clone https://github.com/Tendo33/cursor-usage-tracker.git
   cd cursor-usage-tracker
   npm install
   ```

2. **编译代码**

   ```bash
   npm run compile
   ```

3. **调试运行**
   
   - 在 VSCode/Cursor 中打开项目文件夹
   - 按 `F5` 启动调试
   - 会打开一个新的 Extension Development Host 窗口

---

## 🚀 使用方法

### 状态栏

安装后，在编辑器右下角状态栏会显示：

| 图标 | 含义 |
|------|------|
| 🟢 `0/500` | 正常状态（使用量 < 40%），显示 已用/总量 |
| 🟡 `250/500` | 警告状态（使用量 40%-70%） |
| 🔴 `400/500` | 危险状态（使用量 ≥ 70%），配额紧张 |
| `$(sync~spin) Loading...` | 正在获取数据 |
| `$(warning) No ID` | 未能获取用户 ID，请确保已登录 Cursor |

### 查看详细配额

**鼠标悬停状态栏图标** 可查看详细配额信息，包括请求数和 Token 消耗。

### 手动刷新

- `Ctrl+Shift+P` → 输入 `刷新 Cursor 配额`

---

## ⚙️ 配置选项

打开设置（`Ctrl+,`），搜索 `Cursor Usage Tracker`：

| 设置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `cursorUsageTracker.refreshInterval` | number | `300` | 自动刷新间隔（秒），默认 5 分钟 |
| `cursorUsageTracker.showInStatusBar` | boolean | `true` | 是否在状态栏显示配额 |

**JSON 配置示例：**

```json
{
  "cursorUsageTracker.refreshInterval": 180,
  "cursorUsageTracker.showInStatusBar": true
}
```

---

## 🔧 工作原理

### 认证流程

1. **获取用户 ID**：自动从 Cursor 本地存储读取用户 ID
   - 优先从新版 `sentry/scope_v3.json` 或 `sentry/session.json` 读取
   - 兼容旧版本的 `globalStorage/storage.json` 路径
   - 支持 OAuth ID 格式解析（如 `google-oauth2|user_xxx`）
   
2. **读取访问令牌**：使用 [sql.js](https://github.com/sql-js/sql.js/) 读取 SQLite 数据库
   - 从 `state.vscdb` 数据库提取 `cursorAuth/accessToken`
   - 令牌会被自动缓存以减少数据库访问频率
   
3. **API 请求**：携带会话 Cookie 调用官方 API
   ```
   GET https://cursor.com/api/usage?user={userId}
   Cookie: WorkosCursorSessionToken={userId}%3A%3A{accessToken}
   ```
   
4. **数据展示**：解析响应数据并实时更新状态栏和仪表盘

### 存储路径说明

**用户 ID 存储位置（按优先级）:**

| 系统 | 路径 |
|------|------|
| Windows | `%APPDATA%\Cursor\sentry\scope_v3.json` |
|  | `%APPDATA%\Cursor\sentry\session.json` |
|  | `%APPDATA%\Cursor\User\globalStorage\storage.json` (旧版) |
| macOS | `~/Library/Application Support/Cursor/sentry/*.json` |
|  | `~/Library/Application Support/Cursor/User/globalStorage/storage.json` (旧版) |
| Linux | `~/.config/Cursor/sentry/*.json` |
|  | `~/.config/Cursor/User/globalStorage/storage.json` (旧版) |

**访问令牌存储位置（SQLite 数据库）:**

| 系统 | 数据库文件路径 |
|------|------|
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

---

## 📄 开源协议

[MIT License](LICENSE) © SimonSun

---

<p align="center">
  <b>🌟 如果觉得有用，欢迎 Star！</b>
</p>
