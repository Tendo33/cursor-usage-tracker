// {{RIPER-7 Action}}
// Role: LD | Task_ID: #6-8 | Time: 2025-12-22T13:05:00+08:00
// Logic: 升级 UI 为现代仪表盘风格，增加 SVG 环形图和动态光效
// Principle: SOLID-S (单一职责)

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

interface UsageData {
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

let statusBarItem: vscode.StatusBarItem;
let refreshInterval: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Cursor Usage Tracker 已激活');

    // 创建状态栏项
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'cursor-usage-tracker.showDetails';
    statusBarItem.tooltip = '点击查看 Cursor 配额详情';
    context.subscriptions.push(statusBarItem);

    // 注册刷新命令
    const refreshCommand = vscode.commands.registerCommand(
        'cursor-usage-tracker.refresh',
        () => refreshUsage()
    );
    context.subscriptions.push(refreshCommand);

    // 注册显示详情命令
    const showDetailsCommand = vscode.commands.registerCommand(
        'cursor-usage-tracker.showDetails',
        () => showUsageDetails()
    );
    context.subscriptions.push(showDetailsCommand);

    // 初始刷新
    refreshUsage();

    // 设置自动刷新
    setupAutoRefresh();

    // 监听配置变更
    vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cursorUsageTracker')) {
            setupAutoRefresh();
        }
    });
}

function setupAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }

    const config = vscode.workspace.getConfiguration('cursorUsageTracker');
    const interval = config.get<number>('refreshInterval', 300) * 1000;

    refreshInterval = setInterval(() => {
        refreshUsage();
    }, interval);
}

async function getUserId(): Promise<string | null> {
    const possiblePaths = getPossibleStoragePaths();
    
    for (const storagePath of possiblePaths) {
        try {
            const userId = await findUserIdInPath(storagePath);
            if (userId) {
                return userId;
            }
        } catch (error) {
            // 继续尝试下一个路径
        }
    }

    return null;
}

function getPossibleStoragePaths(): string[] {
    const paths: string[] = [];
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
        paths.push(
            path.join(appData, 'Cursor', 'User', 'globalStorage', 'storage.json'),
            path.join(appData, 'Cursor', 'storage.json'),
            path.join(appData, 'Cursor', 'User', 'settings.json'),
            path.join(homeDir, '.cursor', 'storage.json'),
            path.join(homeDir, '.cursor-tutor', 'storage.json')
        );
    } else if (process.platform === 'darwin') {
        paths.push(
            path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json'),
            path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'storage.json'),
            path.join(homeDir, '.cursor', 'storage.json')
        );
    } else {
        paths.push(
            path.join(homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'storage.json'),
            path.join(homeDir, '.config', 'Cursor', 'storage.json'),
            path.join(homeDir, '.cursor', 'storage.json')
        );
    }

    return paths;
}

async function findUserIdInPath(filePath: string): Promise<string | null> {
    try {
        if (!fs.existsSync(filePath)) {
            const dirPath = path.dirname(filePath);
            if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
                return await searchDirectoryForUserId(dirPath);
            }
            return null;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        
        try {
            const data = JSON.parse(content);
            const possibleKeys = ['cursorAuth/cachedSignInMethod', 'userId', 'user_id', 'id'];
            for (const key of possibleKeys) {
                if (data[key] && typeof data[key] === 'string' && data[key].startsWith('user_')) {
                    return data[key];
                }
            }
            return findUserIdInObject(data);
        } catch {
            const match = content.match(/user_[a-zA-Z0-9]{26,}/);
            if (match) {
                return match[0];
            }
        }
    } catch (error) {
        console.error(`读取文件失败: ${filePath}`, error);
    }
    return null;
}

function findUserIdInObject(obj: any): string | null {
    if (!obj || typeof obj !== 'object') {
        return null;
    }
    for (const key in obj) {
        const value = obj[key];
        if (typeof value === 'string' && value.startsWith('user_') && value.length > 20) {
            return value;
        }
        if (typeof value === 'object') {
            const found = findUserIdInObject(value);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

async function searchDirectoryForUserId(dirPath: string): Promise<string | null> {
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);
            if (stat.isFile() && (file.endsWith('.json') || file === 'storage.json')) {
                const userId = await findUserIdInPath(filePath);
                if (userId) return userId;
            } else if (stat.isDirectory() && !file.startsWith('.')) {
                const userId = await searchDirectoryForUserId(filePath);
                if (userId) return userId;
            }
        }
    } catch (error) {
        console.error(`搜索目录失败: ${dirPath}`, error);
    }
    return null;
}

async function fetchUsageFromAPI(userId: string): Promise<UsageData | null> {
    return new Promise((resolve) => {
        const url = `https://www.cursor.com/api/usage?user=${userId}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        console.error('API 错误:', parsed.error);
                        resolve(null);
                    } else {
                        resolve(parsed as UsageData);
                    }
                } catch (error) {
                    console.error('解析响应失败:', error);
                    resolve(null);
                }
            });
        }).on('error', (error) => {
            console.error('请求失败:', error);
            resolve(null);
        });
    });
}

let lastUsageData: UsageData | null = null;
let lastUserId: string | null = null;

async function refreshUsage() {
    const config = vscode.workspace.getConfiguration('cursorUsageTracker');
    const showInStatusBar = config.get<boolean>('showInStatusBar', true);

    if (!showInStatusBar) {
        statusBarItem.hide();
        return;
    }

    statusBarItem.text = '$(sync~spin) 获取中...';
    statusBarItem.show();

    try {
        const userId = await getUserId();
        if (!userId) {
            statusBarItem.text = '$(warning) 无 ID';
            statusBarItem.tooltip = '无法自动获取 User ID，请确保已登录 Cursor';
            return;
        }

        lastUserId = userId;
        const usageData = await fetchUsageFromAPI(userId);

        if (!usageData) {
            statusBarItem.text = '$(error) 失败';
            statusBarItem.tooltip = '无法从 Cursor API 获取数据';
            return;
        }

        lastUsageData = usageData;
        updateStatusBar(usageData);

    } catch (error) {
        console.error('刷新配额失败:', error);
        statusBarItem.text = '$(error) 错误';
    }
}

function updateStatusBar(data: UsageData) {
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
        } else if (percentage >= 70) {
            icon = '$(warning)';
        } else {
            icon = '$(pulse)';
            colorTheme = ''; // Default
        }

        statusBarItem.text = `${icon} ${remaining}`;
        statusBarItem.tooltip = createTooltip(data);
        
        if (percentage >= 70) {
             statusBarItem.backgroundColor = new vscode.ThemeColor(colorTheme);
        } else {
            statusBarItem.backgroundColor = undefined;
        }
    } else {
        statusBarItem.text = '$(info) Cursor';
        statusBarItem.tooltip = '无法获取配额信息';
    }
    statusBarItem.show();
}

function createTooltip(data: UsageData): vscode.MarkdownString {
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

    const panel = vscode.window.createWebviewPanel(
        'cursorUsageReport',
        'Cursor 配额仪表盘',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    
    panel.webview.html = getWebviewContent(lastUsageData, lastUserId || 'Unknown');
}

function getWebviewContent(data: UsageData, userId: string): string {
    const gpt4 = data['gpt-4'];
    const used = gpt4?.numRequests || 0;
    const max = gpt4?.maxRequestUsage || 500;
    const remaining = max - used;
    const percentage = Math.round((used / max) * 100);
    const tokens = gpt4?.numTokens || 0;
    
    // 计算颜色
    let color = '#4cc9f0'; // 默认蓝
    if (percentage > 75) color = '#f72585'; // 红色警告
    else if (percentage > 50) color = '#f8961e'; // 橙色警告
    
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

export function deactivate() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
}
