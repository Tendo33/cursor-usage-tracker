"use strict";
// {{RIPER-7 Action}}
// Role: LD | Task_ID: #6-8 | Time: 2025-12-22T13:05:00+08:00
// Logic: 升级 UI 为现代仪表盘风格，增加 SVG 环形图和动态光效
// Principle: SOLID-S (单一职责)
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const https = __importStar(require("https"));
const sql_js_1 = __importDefault(require("sql.js"));
// 缓存的 access token
let cachedAccessToken = null;
let statusBarItem;
let refreshInterval;
function activate(context) {
    console.log("Cursor Usage Tracker 已激活");
    // 创建状态栏项
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "cursor-usage-tracker.showDetails";
    statusBarItem.tooltip = "点击查看 Cursor 配额详情";
    context.subscriptions.push(statusBarItem);
    // 注册刷新命令
    const refreshCommand = vscode.commands.registerCommand("cursor-usage-tracker.refresh", () => refreshUsage());
    context.subscriptions.push(refreshCommand);
    // 注册显示详情命令
    const showDetailsCommand = vscode.commands.registerCommand("cursor-usage-tracker.showDetails", () => showUsageDetails());
    context.subscriptions.push(showDetailsCommand);
    // 注册查看日志命令
    const showLogsCommand = vscode.commands.registerCommand("cursor-usage-tracker.showLogs", () => {
        if (!outputChannel) {
            outputChannel = vscode.window.createOutputChannel("Cursor Usage Tracker");
        }
        outputChannel.show();
    });
    context.subscriptions.push(showLogsCommand);
    // 初始刷新
    refreshUsage();
    // 设置自动刷新
    setupAutoRefresh();
    // 监听配置变更
    vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("cursorUsageTracker")) {
            setupAutoRefresh();
        }
    });
}
function setupAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    const config = vscode.workspace.getConfiguration("cursorUsageTracker");
    const interval = config.get("refreshInterval", 300) * 1000;
    refreshInterval = setInterval(() => {
        refreshUsage();
    }, interval);
}
// 创建输出通道用于日志
let outputChannel;
function log(message) {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("Cursor Usage Tracker");
    }
    const timestamp = new Date().toLocaleTimeString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
    console.log(`[Cursor Usage Tracker] ${message}`);
}
async function getUserId() {
    const possiblePaths = getPossibleStoragePaths();
    log(`开始搜索用户 ID，共 ${possiblePaths.length} 个候选路径`);
    for (const storagePath of possiblePaths) {
        try {
            log(`尝试路径: ${storagePath}`);
            const userId = await findUserIdInPath(storagePath);
            if (userId) {
                log(`✓ 成功找到用户 ID: ${userId}`);
                return userId;
            }
            else {
                log(`  - 未在此路径找到用户 ID`);
            }
        }
        catch (error) {
            log(`  - 读取失败: ${error}`);
        }
    }
    log(`✗ 所有路径都未找到用户 ID`);
    return null;
}
function getPossibleStoragePaths() {
    const paths = [];
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    if (process.platform === "win32") {
        const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
        paths.push(
        // 新版 Cursor 将用户信息存储在 sentry 目录
        path.join(appData, "Cursor", "sentry", "scope_v3.json"), path.join(appData, "Cursor", "sentry", "session.json"), 
        // 旧版路径保留兼容
        path.join(appData, "Cursor", "User", "globalStorage", "storage.json"), path.join(appData, "Cursor", "storage.json"), path.join(appData, "Cursor", "User", "settings.json"), path.join(homeDir, ".cursor", "storage.json"), path.join(homeDir, ".cursor-tutor", "storage.json"));
    }
    else if (process.platform === "darwin") {
        paths.push(
        // 新版 Cursor 将用户信息存储在 sentry 目录
        path.join(homeDir, "Library", "Application Support", "Cursor", "sentry", "scope_v3.json"), path.join(homeDir, "Library", "Application Support", "Cursor", "sentry", "session.json"), 
        // 旧版路径保留兼容
        path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "storage.json"), path.join(homeDir, "Library", "Application Support", "Cursor", "storage.json"), path.join(homeDir, ".cursor", "storage.json"));
    }
    else {
        paths.push(
        // 新版 Cursor 将用户信息存储在 sentry 目录
        path.join(homeDir, ".config", "Cursor", "sentry", "scope_v3.json"), path.join(homeDir, ".config", "Cursor", "sentry", "session.json"), 
        // 旧版路径保留兼容
        path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "storage.json"), path.join(homeDir, ".config", "Cursor", "storage.json"), path.join(homeDir, ".cursor", "storage.json"));
    }
    return paths;
}
async function findUserIdInPath(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            log(`  - 文件不存在: ${filePath}`);
            const dirPath = path.dirname(filePath);
            if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
                log(`  - 尝试搜索目录: ${dirPath}`);
                return await searchDirectoryForUserId(dirPath);
            }
            return null;
        }
        log(`  - 文件存在，读取内容...`);
        const content = fs.readFileSync(filePath, "utf8");
        log(`  - 文件大小: ${content.length} 字节`);
        try {
            const data = JSON.parse(content);
            // 检查 sentry/scope_v3.json 格式: scope.user.id = "google-oauth2|user_xxx"
            if (data.scope?.user?.id) {
                log(`  - 发现 scope.user.id: ${data.scope.user.id}`);
                const userId = extractUserIdFromOAuth(data.scope.user.id);
                if (userId) {
                    log(`  - 提取用户 ID: ${userId}`);
                    return userId;
                }
            }
            // 检查 sentry/session.json 格式: did = "google-oauth2|user_xxx"
            if (data.did) {
                log(`  - 发现 did: ${data.did}`);
                const userId = extractUserIdFromOAuth(data.did);
                if (userId) {
                    log(`  - 提取用户 ID: ${userId}`);
                    return userId;
                }
            }
            // 旧版格式检查
            const possibleKeys = ["cursorAuth/cachedSignInMethod", "userId", "user_id", "id"];
            for (const key of possibleKeys) {
                if (data[key] && typeof data[key] === "string" && data[key].startsWith("user_")) {
                    log(`  - 发现 ${key}: ${data[key]}`);
                    return data[key];
                }
            }
            // 递归搜索对象
            const found = findUserIdInObject(data);
            if (found) {
                log(`  - 递归搜索找到: ${found}`);
            }
            return found;
        }
        catch (parseError) {
            log(`  - JSON 解析失败，尝试正则匹配...`);
            const match = content.match(/user_[a-zA-Z0-9]{20,}/);
            if (match) {
                log(`  - 正则匹配找到: ${match[0]}`);
                return match[0];
            }
        }
    }
    catch (error) {
        log(`  - 读取文件失败: ${error}`);
    }
    return null;
}
// 从 OAuth ID 格式中提取 user_xxx 部分
// 例如: "google-oauth2|user_01J87EEM44VT22PEP4HM8A3GSG" -> "user_01J87EEM44VT22PEP4HM8A3GSG"
function extractUserIdFromOAuth(oauthId) {
    if (!oauthId || typeof oauthId !== "string")
        return null;
    // 如果包含 | 分隔符，取后面的部分
    if (oauthId.includes("|")) {
        const parts = oauthId.split("|");
        const userPart = parts.find((p) => p.startsWith("user_"));
        if (userPart)
            return userPart;
    }
    // 直接匹配 user_ 开头的 ID
    if (oauthId.startsWith("user_")) {
        return oauthId;
    }
    return null;
}
function findUserIdInObject(obj) {
    if (!obj || typeof obj !== "object") {
        return null;
    }
    for (const key in obj) {
        const value = obj[key];
        if (typeof value === "string" && value.startsWith("user_") && value.length > 20) {
            return value;
        }
        if (typeof value === "object") {
            const found = findUserIdInObject(value);
            if (found) {
                return found;
            }
        }
    }
    return null;
}
async function searchDirectoryForUserId(dirPath) {
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);
            if (stat.isFile() && (file.endsWith(".json") || file === "storage.json")) {
                const userId = await findUserIdInPath(filePath);
                if (userId)
                    return userId;
            }
            else if (stat.isDirectory() && !file.startsWith(".")) {
                const userId = await searchDirectoryForUserId(filePath);
                if (userId)
                    return userId;
            }
        }
    }
    catch (error) {
        console.error(`搜索目录失败: ${dirPath}`, error);
    }
    return null;
}
/**
 * 获取 Cursor state.vscdb 数据库路径
 */
function getCursorDbPath() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    if (process.platform === "win32") {
        const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
        return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
    }
    else if (process.platform === "darwin") {
        return path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
    }
    else {
        return path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
    }
}
/**
 * 从 state.vscdb 读取 accessToken
 * 使用 sql.js 读取 SQLite 数据库
 */
async function getAccessToken() {
    // 如果已有缓存，直接返回
    if (cachedAccessToken) {
        log(`使用缓存的 accessToken`);
        return cachedAccessToken;
    }
    const dbPath = getCursorDbPath();
    log(`尝试读取数据库: ${dbPath}`);
    if (!fs.existsSync(dbPath)) {
        log(`✗ 数据库文件不存在: ${dbPath}`);
        return null;
    }
    try {
        // 初始化 sql.js
        const SQL = await (0, sql_js_1.default)();
        // 读取数据库文件
        const fileBuffer = fs.readFileSync(dbPath);
        const db = new SQL.Database(fileBuffer);
        // 查询 accessToken
        const result = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");
        if (result.length > 0 && result[0].values.length > 0) {
            const tokenValue = result[0].values[0][0];
            log(`✓ 成功获取 accessToken`);
            // 缓存 token
            cachedAccessToken = tokenValue;
            db.close();
            return tokenValue;
        }
        else {
            log(`✗ 未找到 accessToken`);
            // 尝试列出所有 cursorAuth 相关的 key
            const allKeys = db.exec("SELECT key FROM ItemTable WHERE key LIKE '%cursorAuth%'");
            if (allKeys.length > 0) {
                log(`  - 找到的 cursorAuth 相关 key: ${allKeys[0].values.map((v) => v[0]).join(", ")}`);
            }
            db.close();
            return null;
        }
    }
    catch (error) {
        log(`✗ 读取数据库失败: ${error}`);
        return null;
    }
}
/**
 * 从 API 获取使用量数据
 * 使用 WorkosCursorSessionToken Cookie 进行认证
 */
async function fetchUsageFromAPI(userId) {
    // 先获取 accessToken
    const accessToken = await getAccessToken();
    const makeRequest = (url, redirectCount = 0) => {
        return new Promise((resolve) => {
            if (redirectCount > 5) {
                log(`✗ 重定向次数过多，停止请求`);
                resolve(null);
                return;
            }
            log(`请求 API: ${url}${redirectCount > 0 ? ` (重定向 #${redirectCount})` : ""}`);
            // 构建请求选项
            const urlObj = new URL(url);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    Accept: "application/json",
                },
            };
            // 如果有 accessToken，添加 Cookie
            if (accessToken) {
                log(`  - 使用 Cookie 认证`);
                options.headers = {
                    ...options.headers,
                    Cookie: `WorkosCursorSessionToken=${accessToken}`,
                };
            }
            else {
                log(`  - 无认证信息，尝试无认证请求`);
            }
            https
                .get(options, (res) => {
                log(`API 响应状态码: ${res.statusCode}`);
                // 处理 401 未授权
                if (res.statusCode === 401) {
                    log(`✗ 认证失败 (401)，清除缓存的 token`);
                    cachedAccessToken = null;
                    resolve(null);
                    return;
                }
                // 处理重定向 (301, 302, 307, 308)
                if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
                    const location = res.headers.location;
                    if (location) {
                        log(`  - 重定向到: ${location}`);
                        // 如果是相对路径，需要拼接
                        const redirectUrl = location.startsWith("http") ? location : `https://www.cursor.com${location}`;
                        resolve(makeRequest(redirectUrl, redirectCount + 1));
                    }
                    else {
                        log(`✗ 重定向但没有 Location 头`);
                        resolve(null);
                    }
                    return;
                }
                let data = "";
                res.on("data", (chunk) => {
                    data += chunk;
                });
                res.on("end", () => {
                    log(`API 响应数据长度: ${data.length} 字节`);
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            log(`✗ API 返回错误: ${parsed.error}`);
                            resolve(null);
                        }
                        else {
                            log(`✓ API 请求成功`);
                            log(`  - GPT-4 请求数: ${parsed["gpt-4"]?.numRequests || "N/A"}`);
                            log(`  - GPT-4 最大请求数: ${parsed["gpt-4"]?.maxRequestUsage || "N/A"}`);
                            resolve(parsed);
                        }
                    }
                    catch (error) {
                        log(`✗ JSON 解析失败: ${error}`);
                        log(`  - 原始数据: ${data.substring(0, 200)}...`);
                        resolve(null);
                    }
                });
            })
                .on("error", (error) => {
                log(`✗ 网络请求失败: ${error}`);
                resolve(null);
            });
        });
    };
    return makeRequest(`https://www.cursor.com/api/usage?user=${userId}`);
}
let lastUsageData = null;
let lastUserId = null;
async function refreshUsage() {
    log("========== 开始刷新配额 ==========");
    const config = vscode.workspace.getConfiguration("cursorUsageTracker");
    const showInStatusBar = config.get("showInStatusBar", true);
    if (!showInStatusBar) {
        log("状态栏显示已禁用，跳过刷新");
        statusBarItem.hide();
        return;
    }
    statusBarItem.text = "$(sync~spin) 获取中...";
    statusBarItem.show();
    try {
        log("步骤 1: 获取用户 ID...");
        const userId = await getUserId();
        if (!userId) {
            log("✗ 获取用户 ID 失败");
            statusBarItem.text = "$(warning) 无 ID";
            statusBarItem.tooltip = "无法自动获取 User ID，请点击查看日志";
            statusBarItem.command = "cursor-usage-tracker.showLogs";
            return;
        }
        log(`步骤 2: 调用 API 获取配额数据...`);
        lastUserId = userId;
        const usageData = await fetchUsageFromAPI(userId);
        if (!usageData) {
            log("✗ API 请求失败");
            statusBarItem.text = "$(error) 失败";
            statusBarItem.tooltip = "无法从 Cursor API 获取数据，请点击查看日志";
            statusBarItem.command = "cursor-usage-tracker.showLogs";
            return;
        }
        log("✓ 配额数据获取成功");
        lastUsageData = usageData;
        updateStatusBar(usageData);
        log("========== 刷新完成 ==========");
    }
    catch (error) {
        log(`✗ 刷新过程发生异常: ${error}`);
        statusBarItem.text = "$(error) 错误";
    }
}
function updateStatusBar(data) {
    const gpt4 = data['gpt-4'];
    if (gpt4 && gpt4.maxRequestUsage) {
        const used = gpt4.numRequests;
        const max = gpt4.maxRequestUsage;
        const remaining = max - used;
        const percentage = Math.round((used / max) * 100);
        let icon = '$(check)';
        let colorTheme = 'statusBarItem.warningBackground';
        if (percentage >= 90) {
            icon = '$(flame)';
            colorTheme = 'statusBarItem.errorBackground';
        }
        else if (percentage >= 70) {
            icon = '$(warning)';
        }
        else {
            icon = '$(pulse)';
            colorTheme = ''; // Default
        }
        statusBarItem.text = `${icon} ${remaining}`;
        statusBarItem.tooltip = createTooltip(data);
        if (percentage >= 70) {
            statusBarItem.backgroundColor = new vscode.ThemeColor(colorTheme);
        }
        else {
            statusBarItem.backgroundColor = undefined;
        }
    }
    else {
        statusBarItem.text = '$(info) Cursor';
        statusBarItem.tooltip = '无法获取配额信息';
    }
    statusBarItem.show();
}
function createTooltip(data) {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    const gpt4 = data['gpt-4'];
    if (gpt4) {
        const used = gpt4.numRequests;
        const max = gpt4.maxRequestUsage || '∞';
        const remaining = typeof max === 'number' ? max - used : '∞';
        const percentage = typeof max === 'number' ? Math.round((used / max) * 100) : 0;
        md.appendMarkdown(`### 🤖 GPT-4 配额\n`);
        md.appendMarkdown(`**${remaining}** / ${max} 请求可用\n\n`);
        // 进度条模拟
        const bars = 10;
        const filled = Math.round((percentage / 100) * bars);
        const empty = bars - filled;
        const barStr = '█'.repeat(filled) + '░'.repeat(empty);
        md.appendMarkdown(`\`[${barStr}] ${percentage}%\`\n\n`);
        md.appendMarkdown(`--- \n`);
        md.appendMarkdown(`- **已用**: ${used}\n`);
        md.appendMarkdown(`- **Tokens**: ${(gpt4.numTokens / 1000000).toFixed(2)}M\n`);
    }
    if (data.startOfMonth) {
        const resetDate = new Date(data.startOfMonth);
        const nextReset = new Date(resetDate);
        nextReset.setMonth(nextReset.getMonth() + 1);
        const daysLeft = Math.ceil((nextReset.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        md.appendMarkdown(`\n---\n`);
        md.appendMarkdown(`📅 **${daysLeft}天** 后重置 (${nextReset.toLocaleDateString()})`);
    }
    md.appendMarkdown(`\n\n$(graph) [查看详细报告](command:cursor-usage-tracker.showDetails)`);
    return md;
}
async function showUsageDetails() {
    if (!lastUsageData) {
        await refreshUsage();
    }
    if (!lastUsageData) {
        vscode.window.showErrorMessage('无法获取 Cursor 配额信息');
        return;
    }
    const panel = vscode.window.createWebviewPanel('cursorUsageReport', 'Cursor 配额仪表盘', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.html = getWebviewContent(lastUsageData, lastUserId || 'Unknown');
}
function getWebviewContent(data, userId) {
    const gpt4 = data['gpt-4'];
    const used = gpt4?.numRequests || 0;
    const max = gpt4?.maxRequestUsage || 500;
    const remaining = max - used;
    const percentage = Math.round((used / max) * 100);
    const tokens = gpt4?.numTokens || 0;
    // 计算颜色
    let color = '#4cc9f0'; // 默认蓝
    if (percentage > 75)
        color = '#f72585'; // 红色警告
    else if (percentage > 50)
        color = '#f8961e'; // 橙色警告
    const resetDate = new Date(data.startOfMonth);
    const nextReset = new Date(resetDate);
    nextReset.setMonth(nextReset.getMonth() + 1);
    const daysUntilReset = Math.ceil((nextReset.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    // SVG 环形进度条参数
    const radius = 80;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percentage / 100) * circumference;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cursor Usage Dashboard</title>
    <style>
        :root {
            --bg-color: #0d1117;
            --card-bg: #161b22;
            --text-primary: #f0f6fc;
            --text-secondary: #8b949e;
            --accent-color: ${color};
            --accent-glow: ${color}40;
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-primary);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
        }
        
        .dashboard {
            background: var(--card-bg);
            border-radius: 24px;
            padding: 40px;
            width: 100%;
            max-width: 480px;
            box-shadow: 0 20px 50px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.1);
            position: relative;
            overflow: hidden;
        }

        .dashboard::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; height: 4px;
            background: linear-gradient(90deg, #4cc9f0, #7209b7, #f72585);
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        
        .title {
            font-size: 1.5rem;
            font-weight: 600;
            letter-spacing: -0.5px;
            margin-bottom: 8px;
        }
        
        .subtitle {
            color: var(--text-secondary);
            font-size: 0.9rem;
        }

        /* 环形图容器 */
        .chart-container {
            position: relative;
            width: 200px;
            height: 200px;
            margin: 0 auto 40px;
        }
        
        .chart-svg {
            transform: rotate(-90deg);
            width: 100%;
            height: 100%;
        }
        
        .chart-circle-bg {
            fill: none;
            stroke: rgba(255,255,255,0.05);
            stroke-width: 12;
        }
        
        .chart-circle {
            fill: none;
            stroke: var(--accent-color);
            stroke-width: 12;
            stroke-dasharray: ${circumference};
            stroke-dashoffset: ${circumference}; /* Initial for animation */
            stroke-linecap: round;
            animation: progress 1.5s ease-out forwards;
            filter: drop-shadow(0 0 8px var(--accent-glow));
        }
        
        .chart-content {
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            text-align: center;
        }
        
        .chart-number {
            font-size: 3rem;
            font-weight: 700;
            line-height: 1;
        }
        
        .chart-label {
            font-size: 0.8rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-top: 5px;
        }

        @keyframes progress {
            to { stroke-dashoffset: ${offset}; }
        }

        /* 统计数据网格 */
        .stats-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: rgba(255,255,255,0.03);
            border-radius: 16px;
            padding: 16px;
            text-align: center;
            transition: transform 0.2s;
            border: 1px solid rgba(255,255,255,0.05);
        }
        
        .stat-card:hover {
            transform: translateY(-2px);
            background: rgba(255,255,255,0.05);
        }
        
        .stat-value {
            font-size: 1.2rem;
            font-weight: 600;
            margin-bottom: 4px;
        }
        
        .stat-name {
            font-size: 0.75rem;
            color: var(--text-secondary);
        }

        .footer-info {
            background: rgba(255,255,255,0.02);
            border-radius: 12px;
            padding: 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 0.85rem;
            color: var(--text-secondary);
        }
        
        .reset-badge {
            background: rgba(76, 201, 240, 0.1);
            color: #4cc9f0;
            padding: 4px 12px;
            border-radius: 100px;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .user-id-container {
            margin-top: 20px;
            text-align: center;
        }
        
        .user-id {
            font-family: monospace;
            font-size: 0.7rem;
            color: #444;
            background: #000;
            padding: 4px 8px;
            border-radius: 4px;
            display: inline-block;
        }

    </style>
</head>
<body>
    <div class="dashboard">
        <div class="header">
            <div class="title">GPT-4 Usage</div>
            <div class="subtitle">Monthly Quota Overview</div>
        </div>

        <div class="chart-container">
            <svg class="chart-svg">
                <circle class="chart-circle-bg" cx="100" cy="100" r="${radius}"></circle>
                <circle class="chart-circle" cx="100" cy="100" r="${radius}"></circle>
            </svg>
            <div class="chart-content">
                <div class="chart-number">${remaining}</div>
                <div class="chart-label">LEFT</div>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">${used} / ${max}</div>
                <div class="stat-name">Requests Used</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${(tokens / 1000000).toFixed(2)}M</div>
                <div class="stat-name">Tokens Processed</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${percentage}%</div>
                <div class="stat-name">Consumption</div>
            </div>
             <div class="stat-card">
                <div class="stat-value">${daysUntilReset} Days</div>
                <div class="stat-name">Until Reset</div>
            </div>
        </div>

        <div class="footer-info">
            <span>Next Cycle</span>
            <span class="reset-badge">${nextReset.toLocaleDateString()}</span>
        </div>
        
        <div class="user-id-container">
            <span class="user-id">${userId}</span>
        </div>
    </div>
</body>
</html>`;
}
function deactivate() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
}
//# sourceMappingURL=extension.js.map