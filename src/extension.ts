// {{RIPER-7 Action}}
// Role: LD | Task_ID: #6-8 | Time: 2025-12-22T13:05:00+08:00
// Logic: 升级 UI 为现代仪表盘风格，增加 SVG 环形图和动态光效
// Principle: SOLID-S (单一职责)

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import initSqlJs, { Database } from "sql.js";

// 缓存的 access token
let cachedAccessToken: string | null = null;

interface UsageData {
	"gpt-4"?: {
		numRequests: number;
		numRequestsTotal: number;
		numTokens: number;
		maxRequestUsage: number | null;
		maxTokenUsage: number | null;
	};
	"gpt-3.5-turbo"?: {
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
	console.log("Cursor Usage Tracker 已激活");

	// 创建状态栏项
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.tooltip = "Cursor 配额信息";
	context.subscriptions.push(statusBarItem);

	// 注册刷新命令
	const refreshCommand = vscode.commands.registerCommand("cursor-usage-tracker.refresh", () => refreshUsage());
	context.subscriptions.push(refreshCommand);

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
	const interval = config.get<number>("refreshInterval", 300) * 1000;

	refreshInterval = setInterval(() => {
		refreshUsage();
	}, interval);
}

// 创建输出通道用于日志
let outputChannel: vscode.OutputChannel;

function log(message: string) {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel("Cursor Usage Tracker");
	}
	const timestamp = new Date().toLocaleTimeString();
	outputChannel.appendLine(`[${timestamp}] ${message}`);
	console.log(`[Cursor Usage Tracker] ${message}`);
}

async function getUserId(): Promise<string | null> {
	const possiblePaths = getPossibleStoragePaths();
	log(`开始搜索用户 ID，共 ${possiblePaths.length} 个候选路径`);

	for (const storagePath of possiblePaths) {
		try {
			log(`尝试路径: ${storagePath}`);
			const userId = await findUserIdInPath(storagePath);
			if (userId) {
				log(`✓ 成功找到用户 ID: ${userId}`);
				return userId;
			} else {
				log(`  - 未在此路径找到用户 ID`);
			}
		} catch (error) {
			log(`  - 读取失败: ${error}`);
		}
	}

	log(`✗ 所有路径都未找到用户 ID`);
	return null;
}

function getPossibleStoragePaths(): string[] {
	const paths: string[] = [];
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";

	if (process.platform === "win32") {
		const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
		paths.push(
			// 新版 Cursor 将用户信息存储在 sentry 目录
			path.join(appData, "Cursor", "sentry", "scope_v3.json"),
			path.join(appData, "Cursor", "sentry", "session.json"),
			// 旧版路径保留兼容
			path.join(appData, "Cursor", "User", "globalStorage", "storage.json"),
			path.join(appData, "Cursor", "storage.json"),
			path.join(appData, "Cursor", "User", "settings.json"),
			path.join(homeDir, ".cursor", "storage.json"),
			path.join(homeDir, ".cursor-tutor", "storage.json")
		);
	} else if (process.platform === "darwin") {
		paths.push(
			// 新版 Cursor 将用户信息存储在 sentry 目录
			path.join(homeDir, "Library", "Application Support", "Cursor", "sentry", "scope_v3.json"),
			path.join(homeDir, "Library", "Application Support", "Cursor", "sentry", "session.json"),
			// 旧版路径保留兼容
			path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "storage.json"),
			path.join(homeDir, "Library", "Application Support", "Cursor", "storage.json"),
			path.join(homeDir, ".cursor", "storage.json")
		);
	} else {
		paths.push(
			// 新版 Cursor 将用户信息存储在 sentry 目录
			path.join(homeDir, ".config", "Cursor", "sentry", "scope_v3.json"),
			path.join(homeDir, ".config", "Cursor", "sentry", "session.json"),
			// 旧版路径保留兼容
			path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "storage.json"),
			path.join(homeDir, ".config", "Cursor", "storage.json"),
			path.join(homeDir, ".cursor", "storage.json")
		);
	}

	return paths;
}

async function findUserIdInPath(filePath: string): Promise<string | null> {
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
		} catch (parseError) {
			log(`  - JSON 解析失败，尝试正则匹配...`);
			const match = content.match(/user_[a-zA-Z0-9]{20,}/);
			if (match) {
				log(`  - 正则匹配找到: ${match[0]}`);
				return match[0];
			}
		}
	} catch (error) {
		log(`  - 读取文件失败: ${error}`);
	}
	return null;
}

// 从 OAuth ID 格式中提取 user_xxx 部分
// 例如: "google-oauth2|user_01J87EEM44VT22PEP4HM8A3GSG" -> "user_01J87EEM44VT22PEP4HM8A3GSG"
function extractUserIdFromOAuth(oauthId: string): string | null {
	if (!oauthId || typeof oauthId !== "string") return null;

	// 如果包含 | 分隔符，取后面的部分
	if (oauthId.includes("|")) {
		const parts = oauthId.split("|");
		const userPart = parts.find((p) => p.startsWith("user_"));
		if (userPart) return userPart;
	}

	// 直接匹配 user_ 开头的 ID
	if (oauthId.startsWith("user_")) {
		return oauthId;
	}

	return null;
}

function findUserIdInObject(obj: any): string | null {
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

async function searchDirectoryForUserId(dirPath: string): Promise<string | null> {
	try {
		const files = fs.readdirSync(dirPath);
		for (const file of files) {
			const filePath = path.join(dirPath, file);
			const stat = fs.statSync(filePath);
			if (stat.isFile() && (file.endsWith(".json") || file === "storage.json")) {
				const userId = await findUserIdInPath(filePath);
				if (userId) return userId;
			} else if (stat.isDirectory() && !file.startsWith(".")) {
				const userId = await searchDirectoryForUserId(filePath);
				if (userId) return userId;
			}
		}
	} catch (error) {
		console.error(`搜索目录失败: ${dirPath}`, error);
	}
	return null;
}

/**
 * 获取 Cursor state.vscdb 数据库路径
 */
function getCursorDbPath(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";

	if (process.platform === "win32") {
		const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
		return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
	} else if (process.platform === "darwin") {
		return path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
	} else {
		return path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
	}
}

/**
 * 从 state.vscdb 读取 accessToken
 * 使用 sql.js 读取 SQLite 数据库
 */
async function getAccessToken(): Promise<string | null> {
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
		// 初始化 sql.js，指定 WASM 文件位置（与打包后的 extension.js 同目录）
		const SQL = await initSqlJs({
			locateFile: (file: string) => path.join(__dirname, file),
		});

		// 读取数据库文件
		const fileBuffer = fs.readFileSync(dbPath);
		const db: Database = new SQL.Database(fileBuffer);

		// 查询 accessToken
		const result = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");

		if (result.length > 0 && result[0].values.length > 0) {
			const tokenValue = result[0].values[0][0] as string;
			log(`✓ 成功获取 accessToken`);

			// 缓存 token
			cachedAccessToken = tokenValue;

			db.close();
			return tokenValue;
		} else {
			log(`✗ 未找到 accessToken`);

			// 尝试列出所有 cursorAuth 相关的 key
			const allKeys = db.exec("SELECT key FROM ItemTable WHERE key LIKE '%cursorAuth%'");
			if (allKeys.length > 0) {
				log(`  - 找到的 cursorAuth 相关 key: ${allKeys[0].values.map((v) => v[0]).join(", ")}`);
			}

			db.close();
			return null;
		}
	} catch (error) {
		log(`✗ 读取数据库失败: ${error}`);
		return null;
	}
}

/**
 * 从 API 获取使用量数据
 * 使用 WorkosCursorSessionToken Cookie 进行认证
 * Cookie 格式: userId%3A%3AaccessToken (即 userId::accessToken 的 URL 编码)
 */
async function fetchUsageFromAPI(userId: string): Promise<UsageData | null> {
	// 先获取 accessToken
	const accessToken = await getAccessToken();

	// 构建正确的 Cookie 值: userId::accessToken (URL 编码后为 userId%3A%3AaccessToken)
	const cookieValue = accessToken ? `${userId}%3A%3A${accessToken}` : null;

	const makeRequest = (url: string, redirectCount: number = 0): Promise<UsageData | null> => {
		return new Promise((resolve) => {
			if (redirectCount > 5) {
				log(`✗ 重定向次数过多，停止请求`);
				resolve(null);
				return;
			}

			log(`请求 API: ${url}${redirectCount > 0 ? ` (重定向 #${redirectCount})` : ""}`);

			// 构建请求选项
			const urlObj = new URL(url);
			const options: https.RequestOptions = {
				hostname: urlObj.hostname,
				path: urlObj.pathname + urlObj.search,
				method: "GET",
				headers: {
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
					Accept: "application/json",
				},
			};

			// 如果有 Cookie，添加认证头
			if (cookieValue) {
				log(`  - 使用 Cookie 认证`);
				options.headers = {
					...options.headers,
					Cookie: `WorkosCursorSessionToken=${cookieValue}`,
				};
			} else {
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
						} else {
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
							} else {
								log(`✓ API 请求成功`);
								log(`  - GPT-4 请求数: ${parsed["gpt-4"]?.numRequests || "N/A"}`);
								log(`  - GPT-4 最大请求数: ${parsed["gpt-4"]?.maxRequestUsage || "N/A"}`);
								resolve(parsed as UsageData);
							}
						} catch (error) {
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

	// 注意：必须使用 cursor.com 而不是 www.cursor.com，否则会 308 重定向
	return makeRequest(`https://cursor.com/api/usage?user=${userId}`);
}

let lastUsageData: UsageData | null = null;
let lastUserId: string | null = null;

async function refreshUsage() {
	log("========== 开始刷新配额 ==========");
	const config = vscode.workspace.getConfiguration("cursorUsageTracker");
	const showInStatusBar = config.get<boolean>("showInStatusBar", true);

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
	} catch (error) {
		log(`✗ 刷新过程发生异常: ${error}`);
		statusBarItem.text = "$(error) 错误";
	}
}

function updateStatusBar(data: UsageData) {
	const gpt4 = data["gpt-4"];

	if (gpt4 && gpt4.maxRequestUsage) {
		const used = gpt4.numRequests;
		const max = gpt4.maxRequestUsage;
		const remaining = max - used;
		const percentage = Math.round((used / max) * 100);

		let icon = "$(circle-filled)";
		let colorTheme = "";

		// 根据百分比显示红绿灯
		if (percentage >= 70) {
			// 绿灯：70-100%
			icon = "$(circle-filled)";
			colorTheme = ""; // 默认绿色主题
		} else if (percentage >= 30) {
			// 黄灯：30-70%
			icon = "$(circle-filled)";
			colorTheme = "statusBarItem.warningBackground";
		} else {
			// 红灯：<30%
			icon = "$(circle-filled)";
			colorTheme = "statusBarItem.errorBackground";
		}

		statusBarItem.text = `${icon} ${remaining}`;
		statusBarItem.tooltip = createTooltip(data);

		// 根据红绿灯设置背景颜色
		if (colorTheme) {
			statusBarItem.backgroundColor = new vscode.ThemeColor(colorTheme);
		} else {
			statusBarItem.backgroundColor = undefined;
		}
	} else {
		statusBarItem.text = "$(info) Cursor";
		statusBarItem.tooltip = "无法获取配额信息";
	}
	statusBarItem.show();
}

function createTooltip(data: UsageData): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.isTrusted = true;

	const gpt4 = data["gpt-4"];
	if (gpt4) {
		const used = gpt4.numRequests;
		const max = gpt4.maxRequestUsage || "∞";
		const remaining = typeof max === "number" ? max - used : "∞";
		const percentage = typeof max === "number" ? Math.round((used / max) * 100) : 0;

		md.appendMarkdown(`### 🤖 Cursor 配额\n`);
		md.appendMarkdown(`**${remaining}** / ${max} 请求可用\n\n`);

		// 进度条模拟
		const bars = 10;
		const filled = Math.round((percentage / 100) * bars);
		const empty = bars - filled;
		const barStr = "█".repeat(filled) + "░".repeat(empty);

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

	return md;
}



export function deactivate() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
}
