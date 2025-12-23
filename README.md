# 🎯 Cursor Usage Tracker

<p align="center">
  <img src="https://img.shields.io/badge/Platform-VSCode%20%7C%20Cursor-blue?style=for-the-badge&logo=visual-studio-code" />
  <img src="https://img.shields.io/badge/Version-1.0.0-green?style=for-the-badge" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" />
</p>

> 🔋 在状态栏实时显示你的 Cursor 剩余配额

---

## ✨ 功能特性

- 📊 **状态栏实时显示** - 随时查看 Cursor 配额剩余请求次数
- 🎨 **现代仪表盘 UI** - 精美的 SVG 环形图配额详情面板
- 🔄 **自动刷新** - 可配置自动刷新间隔（默认 5 分钟）
- 🔔 **智能预警** - 配额低于 30%/10% 时状态栏变色提醒
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

   这会在项目根目录生成 `cursor-usage-tracker-1.0.0.vsix` 文件。

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
| 🟢 `150` | 正常状态（配额使用 < 30%），显示剩余请求数 |
| 🟡 `80` | 警告状态（配额使用 30%-70%） |
| 🔴 `20` | 危险状态（配额使用 > 70%），即将耗尽 |
| `$(sync~spin) 获取中...` | 正在获取数据 |
| `$(warning) 无 ID` | 未能获取用户 ID，请确保已登录 Cursor |

### 查看详细配额

**点击状态栏图标** 或 执行命令：

- `Ctrl+Shift+P` → 输入 `显示 Cursor 配额详情`

将打开一个现代化的仪表盘面板，展示：

- 📈 环形进度图（剩余配额可视化）
- 📊 已用/总量请求数
- 🔢 消耗的 Tokens 数
- 📅 距离配额重置剩余天数

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

## 🛠️ 开发

### 项目结构

```
cursor-usage-tracker/
├── src/
│   └── extension.ts    # 主要源码
├── out/                # 编译输出
│   ├── extension.js    # 打包后的扩展代码
│   └── sql-wasm.wasm   # SQLite WASM 文件
├── esbuild.mjs         # esbuild 打包配置
├── package.json        # 插件配置
└── README.md
```

### 常用命令

```bash
# 安装依赖
npm install

# 开发编译（使用 esbuild 打包）
npm run compile

# 监听模式（开发时使用）
npm run watch

# 生产模式编译（压缩代码）
npm run package:prod

# 打包 VSIX
npm run package
```

### 测试 API 连接

项目包含一个独立的测试脚本 `test-api.js`,可用于验证 Cursor API 连接:

```bash
# 运行测试脚本
node test-api.js
```

测试脚本将:
1. 自动读取用户 ID 和访问令牌
2. 构造正确的 API 请求
3. 显示响应状态和配额信息

适合用于调试认证问题或验证 API 可用性。

---

## ❓ 常见问题

### Q: 显示 "无 ID" 怎么办?
A: 请确保你已登录 Cursor 账号。插件会尝试从多个位置读取用户 ID,如果仍有问题:
1. 检查 `%APPDATA%\Cursor\sentry` 目录是否存在
2. 运行命令 `查看 Cursor Usage Tracker 日志` 查看详细错误信息
3. 尝试重启 Cursor

### Q: 显示 "失败" 或 401 错误?
A: 认证失败,可能原因:
1. `state.vscdb` 数据库中的 `accessToken` 已过期
2. 插件无法读取数据库文件,请确保 Cursor 已完全关闭其他窗口
3. 尝试重新登录 Cursor 账号

### Q: 数据不准确?
A: 配额数据来自 Cursor 官方 API,可能有数分钟延迟。使用 `刷新 Cursor 配额` 命令手动刷新。

### Q: 在 VSCode 中能用吗?
A: 技术上可以安装,但只有在 Cursor 客户端中才能正常工作,因为需要读取 Cursor 的本地配置文件。

### Q: macOS 是否支持?
A: 完全支持!插件会自动检测系统平台并使用对应的存储路径。

---

## 📄 开源协议

[MIT License](LICENSE) © SimonSun

---

<p align="center">
  <b>🌟 如果觉得有用，欢迎 Star！</b>
</p>
