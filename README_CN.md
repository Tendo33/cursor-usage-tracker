# Cursor Usage Tracker

<p align="center">
  <strong>一个在状态栏直接显示 Cursor 配额使用情况的 VS Code / Cursor 扩展。</strong><br>
  不用再靠猜，也不用翻日志；已用多少、还剩多少，一眼就能看到。
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/README-English-0F172A?style=for-the-badge" alt="English README"></a>
  <img src="https://img.shields.io/badge/Platform-Cursor%20%7C%20VS%20Code-2563EB?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Platform">
  <img src="https://img.shields.io/badge/Version-1.0.3-16A34A?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/License-MIT-EAB308?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/SQLite-2GiB%2B%20Fallback-7C3AED?style=for-the-badge" alt="Large SQLite fallback">
</p>

<p align="center">
  <a href="#快速开始"><img src="https://img.shields.io/badge/快速开始-5分钟-2563EB?style=flat-square" alt="Quick Start"></a>
  <a href="#截图预留"><img src="https://img.shields.io/badge/截图-已预留-16A34A?style=flat-square" alt="Screenshots"></a>
  <a href="#工作原理"><img src="https://img.shields.io/badge/工作原理-讲清楚-0F766E?style=flat-square" alt="How It Works"></a>
  <a href="#常见问题"><img src="https://img.shields.io/badge/排障-已包含-F97316?style=flat-square" alt="Troubleshooting"></a>
</p>

这个项目是给重度 Cursor 用户准备的。很多人并不是不关心配额，而是总要等到快用完了才意识到问题来了。这个扩展把最关键的数字放回编辑器状态栏里：比如 `🟢 120/500`。你把鼠标悬停上去，还能看到请求数、Token 使用量和预计重置时间。

> [!IMPORTANT]
> 这不是官方 Cursor 扩展。它的做法是读取你本机上的 Cursor 本地数据，再请求 `https://cursor.com/api/usage` 获取配额信息。

## 目录

- [Cursor Usage Tracker](#cursor-usage-tracker)
  - [目录](#目录)
  - [截图预留](#截图预留)
  - [这个项目解决了什么问题](#这个项目解决了什么问题)
  - [功能亮点](#功能亮点)
  - [快速开始](#快速开始)
    - [方式一：通过 VSIX 安装](#方式一通过-vsix-安装)
    - [方式二：开发模式运行](#方式二开发模式运行)
  - [你会看到什么](#你会看到什么)
  - [配置项](#配置项)
  - [工作原理](#工作原理)
  - [存储路径](#存储路径)
    - [用户 ID 查找路径](#用户-id-查找路径)
    - [Access Token 查找路径](#access-token-查找路径)
  - [常见问题](#常见问题)
    - [状态栏显示 `No ID`](#状态栏显示-no-id)
    - [状态栏显示 `Failed`](#状态栏显示-failed)
    - [大数据库 fallback 没生效](#大数据库-fallback-没生效)
  - [项目结构](#项目结构)
  - [开发](#开发)
  - [更新记录](#更新记录)
    - [1.0.3](#103)
    - [1.0.2](#102)
    - [1.0.1](#101)
  - [License](#license)

## 截图预留

![Main status bar view](assets/main-status-bar.png)

## 这个项目解决了什么问题

Cursor 配额这件事，平时不看还好，一旦要用的时候往往已经接近上限了。这个扩展做的事情很直接：把配额使用情况持续放在你眼前，不需要反复打开网页、翻本地文件，或者等请求失败了才知道出问题。

另外它还处理了一个比较烦、但真实存在的边缘场景：`state.vscdb` 过大。自 `1.0.2` 起，如果 Node.js 在读取 2 GiB 及以上的 SQLite 文件时命中 `ERR_FS_FILE_TOO_LARGE`，扩展会自动切到 Python `sqlite3` 回退方案，不至于直接失效。

## 功能亮点

- 状态栏实时显示请求使用情况
- 通过颜色区分低、中、高使用率
- 悬停即可查看请求数、Token 和重置时间
- 默认每 5 分钟自动刷新
- 自动从本地 Cursor 存储中查找用户 ID
- 自动从 `state.vscdb` 读取 `accessToken`
- 支持超大 SQLite 文件的自动 fallback
- 配置简单，不依赖额外服务

## 快速开始

### 方式一：通过 VSIX 安装

先在本地打包扩展：

```bash
npm install
npm run compile
npm run package
```

打包完成后，项目根目录会生成类似 `cursor-usage-tracker-1.0.3.vsix` 的文件。

然后在 Cursor 或 VS Code 中安装：

1. 打开命令面板：Windows / Linux 用 `Ctrl+Shift+P`，macOS 用 `Cmd+Shift+P`
2. 执行 `Extensions: Install from VSIX...`
3. 选择刚生成的 `.vsix` 文件
4. 如有需要，重启编辑器

### 方式二：开发模式运行

```bash
git clone https://github.com/Tendo33/cursor-usage-tracker.git
cd cursor-usage-tracker
npm install
npm run compile
```

然后在 VS Code 或 Cursor 中按 `F5`，启动 Extension Development Host。

## 你会看到什么

扩展启动后，状态栏可能出现这些状态：

- `🟢 120/500`：使用率较低
- `🟡 260/500`：使用率中等
- `🔴 410/500`：使用率较高
- `$(sync~spin) Loading...`：正在拉取数据
- `$(warning) No ID`：没有在本地读到用户 ID
- `$(error) Failed`：接口请求失败

鼠标悬停后会显示：

- 已使用请求数
- 总请求上限
- Token 使用量（百万为单位）
- 预计距离重置还有多少天

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `cursorUsageTracker.refreshInterval` | `number` | `300` | 自动刷新间隔，单位为秒 |
| `cursorUsageTracker.showInStatusBar` | `boolean` | `true` | 是否在状态栏显示配额信息 |

示例：

```json
{
  "cursorUsageTracker.refreshInterval": 180,
  "cursorUsageTracker.showInStatusBar": true
}
```

## 工作原理

这个扩展做的事情其实很朴素，主要分三步：

1. 从本地 Cursor 存储里找出用户 ID，优先检查新的 `sentry` 路径。
2. 从 Cursor 的 `state.vscdb` 中读取 `cursorAuth/accessToken`。
3. 带着这两项信息去请求用量接口，再把结果渲染到状态栏。

请求形式如下：

```text
GET https://cursor.com/api/usage?user={userId}
Cookie: WorkosCursorSessionToken={userId}%3A%3A{accessToken}
```

对于普通大小的数据库，扩展会使用 `sql.js` 读取 SQLite。若文件过大导致 `readFileSync` 无法处理，则会自动切换到 Python：

- Windows：依次尝试 `python`、`py`、`python3`
- macOS / Linux：依次尝试 `python3`、`python`

## 存储路径

### 用户 ID 查找路径

- Windows: `%APPDATA%\Cursor\sentry\scope_v3.json`
- Windows: `%APPDATA%\Cursor\sentry\session.json`
- Windows 旧路径: `%APPDATA%\Cursor\User\globalStorage\storage.json`
- macOS: `~/Library/Application Support/Cursor/sentry/*.json`
- Linux: `~/.config/Cursor/sentry/*.json`

### Access Token 查找路径

- Windows: `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
- macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Linux: `~/.config/Cursor/User/globalStorage/state.vscdb`

## 常见问题

### 状态栏显示 `No ID`

这表示扩展没有在本地 Cursor 数据中找到合法的 `user_*` 标识。常见原因一般就这几种：

- 当前机器上的 Cursor 还没有完成登录
- 你的安装环境里存储路径发生了变化
- 本地文件存在，但里面没有当前实现预期的字段

可以打开命令面板，执行 `Cursor Usage Tracker: 查看 Cursor Usage Tracker 日志`，查看具体查找过程。

### 状态栏显示 `Failed`

这说明接口请求没有拿回可用结果。常见原因包括：

- 无法从 `state.vscdb` 读到 access token
- 本地 token 已过期，自动重试也没恢复
- 上游接口格式发生变化，当前解析逻辑失效

### 大数据库 fallback 没生效

当 `state.vscdb` 达到 2 GiB 或更大时，扩展会依赖本地 Python 解释器做回退读取。请确认你的机器上至少存在以下命令之一：

- `python`
- `py`
- `python3`

如果都没有，安装 Python 3 后再刷新即可。

## 项目结构

```text
cursor-usage-tracker/
├── README.md
├── README_CN.md
├── src/
│   ├── extension.ts
│   └── sql.js.d.ts
├── out/
├── esbuild.mjs
├── package.json
├── test-api.js
└── icon.png
```

## 开发

常用命令：

```bash
npm install
npm run compile
npm run watch
npm run package
```

项目里还带了一个本地测试脚本：

```bash
node test-api.js
```

如果你想在扩展运行时之外单独验证用户 ID 查找、token 读取和原始接口请求，这个脚本会比较方便。

## 更新记录

### 1.0.3

- 为 Cursor 用量 API 的瞬时 TLS / 网络失败增加自动重试
- 为请求增加超时控制，避免刷新长时间卡住
- 补充可重试网络错误的回归测试

### 1.0.2

- 修复 `state.vscdb >= 2 GiB` 时的读取失败问题
- 增加 Python `sqlite3` 回退读取
- 改进日志和失败处理

### 1.0.1

- 初始版本发布

## License

[MIT](LICENSE)
