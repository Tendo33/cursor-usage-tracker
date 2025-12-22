# 🎯 Cursor Usage Tracker

<p align="center">
  <img src="https://img.shields.io/badge/Platform-VSCode%20%7C%20Cursor-blue?style=for-the-badge&logo=visual-studio-code" />
  <img src="https://img.shields.io/badge/Version-1.0.0-green?style=for-the-badge" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" />
</p>

> 🔋 在状态栏实时显示你的 Cursor GPT-4 剩余配额，再也不用担心配额不够用！

---

## ✨ 功能特性

- 📊 **状态栏实时显示** - 随时查看 GPT-4 剩余请求次数
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
   git clone https://github.com/your-username/cursor-usage-tracker.git
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
| `$(pulse) 150` | 正常状态，显示剩余请求数 |
| `$(warning) 80` | 配额使用超过 70% |
| `$(flame) 20` | 配额使用超过 90%，即将耗尽 |
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

1. 插件自动读取本地 Cursor 存储文件，获取用户 ID
2. 通过 Cursor 官方 API 获取配额数据：
   ```
   https://www.cursor.com/api/usage?user={userId}
   ```
3. 解析数据并展示在状态栏和仪表盘中

**支持的存储路径：**

| 系统 | 路径 |
|------|------|
| Windows | `%APPDATA%\Cursor\User\globalStorage\storage.json` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/storage.json` |
| Linux | `~/.config/Cursor/User/globalStorage/storage.json` |

---

## 🛠️ 开发

### 项目结构

```
cursor-usage-tracker/
├── src/
│   └── extension.ts    # 主要源码
├── out/                # 编译输出
├── package.json        # 插件配置
└── README.md
```

### 常用命令

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 监听模式（开发时使用）
npm run watch

# 打包 VSIX
npm run package
```

---

## ❓ 常见问题

### Q: 显示 "无 ID" 怎么办？
A: 请确保你已登录 Cursor 账号。如果仍有问题，尝试重启 Cursor。

### Q: 数据不准确？
A: 配额数据来自 Cursor 官方 API，可能有数分钟延迟。可尝试手动刷新。

### Q: 在 VSCode 中能用吗？
A: 技术上可以安装，但只有使用 Cursor 时才有实际意义。

---

## 📄 开源协议

[MIT License](LICENSE) © TuDou

---

<p align="center">
  <b>🌟 如果觉得有用，欢迎 Star！</b>
</p>
