# Cursor Usage Tracker

<p align="center">
  <img src="https://img.shields.io/badge/Platform-VSCode%20%7C%20Cursor-blue?style=for-the-badge&logo=visual-studio-code" />
  <img src="https://img.shields.io/badge/Version-1.0.2-green?style=for-the-badge" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" />
</p>

在状态栏实时显示 Cursor 配额使用情况（请求数与 Tokens）。

## 说明

当前主要面向 `GPT-4 500 requests/month` 配额场景。

## 功能

- 状态栏实时显示已用/总量
- 悬停查看详细配额（请求数、Token、重置时间）
- 自动刷新（默认 5 分钟）
- 使用率分级提示（<40%、40%-70%、>=70%）
- 跨平台支持（Windows / macOS / Linux）

## 安装

### 方式一：从 VSIX 安装（推荐）

1. 打包插件

```bash
npm install
npm run compile
npm run package
```

会在项目根目录生成 `cursor-usage-tracker-1.0.2.vsix`。

2. 在 Cursor / VSCode 安装

- 打开命令面板：`Ctrl+Shift+P`（macOS: `Cmd+Shift+P`）
- 执行 `Extensions: Install from VSIX...`
- 选择生成的 `.vsix` 文件
- 重启编辑器

### 方式二：开发模式运行

```bash
git clone https://github.com/Tendo33/cursor-usage-tracker.git
cd cursor-usage-tracker
npm install
npm run compile
```

然后在 VSCode/Cursor 中按 `F5` 启动 Extension Development Host。

## 使用

安装后状态栏会显示类似：

- `🟢 120/500`：低使用率
- `🟡 260/500`：中等使用率
- `🔴 410/500`：高使用率
- `$(sync~spin) Loading...`：刷新中
- `$(warning) No ID`：未读取到用户 ID

## 配置

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `cursorUsageTracker.refreshInterval` | number | `300` | 自动刷新间隔（秒） |
| `cursorUsageTracker.showInStatusBar` | boolean | `true` | 是否在状态栏显示 |

示例：

```json
{
  "cursorUsageTracker.refreshInterval": 180,
  "cursorUsageTracker.showInStatusBar": true
}
```

## 工作原理

1. 从本地配置读取 `userId`（优先读取 sentry 路径）
2. 从 `state.vscdb` 读取 `cursorAuth/accessToken`
3. 通过 Cookie 调用：

```text
GET https://cursor.com/api/usage?user={userId}
Cookie: WorkosCursorSessionToken={userId}%3A%3A{accessToken}
```

4. 解析结果并更新状态栏

## 大数据库兼容（1.0.2）

当 `state.vscdb` 大于等于 2 GiB 时，Node.js 的 `readFileSync` 会触发 `ERR_FS_FILE_TOO_LARGE`。

从 `1.0.2` 开始：

- 小于 2 GiB：继续使用 `sql.js`
- 大于等于 2 GiB：自动切换 Python `sqlite3` 回退读取（依次尝试 `python` / `py` / `python3`）

如果本机没有可用 Python，可安装 Python 3 后重试。

## 存储路径

### 用户 ID（按优先级）

- Windows: `%APPDATA%\Cursor\sentry\scope_v3.json`
- Windows: `%APPDATA%\Cursor\sentry\session.json`
- Windows(旧): `%APPDATA%\Cursor\User\globalStorage\storage.json`
- macOS: `~/Library/Application Support/Cursor/sentry/*.json`
- Linux: `~/.config/Cursor/sentry/*.json`

### Access Token（SQLite）

- Windows: `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
- macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Linux: `~/.config/Cursor/User/globalStorage/state.vscdb`

## Changelog

### 1.0.2

- 修复 `state.vscdb >= 2 GiB` 时读取失败（`ERR_FS_FILE_TOO_LARGE`）
- 新增大库自动 fallback（Python sqlite3）
- 优化日志与容错行为

### 1.0.1

- 初始发布版本

## License

[MIT](LICENSE)
