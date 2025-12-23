// {{RIPER-7 Action}}
// Role: LD | Task_ID: #6-8 | Time: 2025-12-22T13:05:00+08:00
// Logic: Upgrade UI to modern dashboard style, add SVG ring chart and dynamic light effects
// Principle: SOLID-S (Single Responsibility)

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import initSqlJs, { Database } from "sql.js";

// Cached access token
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
	console.log("Cursor Usage Tracker activated");

	// Create status bar item
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.tooltip = "Cursor Quota Info";
	context.subscriptions.push(statusBarItem);

	// Register refresh command
	const refreshCommand = vscode.commands.registerCommand("cursor-usage-tracker.refresh", () => refreshUsage());
	context.subscriptions.push(refreshCommand);

	// Register show logs command
	const showLogsCommand = vscode.commands.registerCommand("cursor-usage-tracker.showLogs", () => {
		if (!outputChannel) {
			outputChannel = vscode.window.createOutputChannel("Cursor Usage Tracker");
		}
		outputChannel.show();
	});
	context.subscriptions.push(showLogsCommand);

	// Initial refresh
	refreshUsage();

	// Setup auto refresh
	setupAutoRefresh();

	// Listen for configuration changes
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

// Create output channel for logs
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
	log(`Searching for user ID, ${possiblePaths.length} candidate paths`);

	for (const storagePath of possiblePaths) {
		try {
			log(`Trying path: ${storagePath}`);
			const userId = await findUserIdInPath(storagePath);
			if (userId) {
				log(`✓ Successfully found user ID: ${userId}`);
				return userId;
			} else {
				log(`  - User ID not found in this path`);
			}
		} catch (error) {
			log(`  - Read failed: ${error}`);
		}
	}

	log(`✗ User ID not found in any path`);
	return null;
}

function getPossibleStoragePaths(): string[] {
	const paths: string[] = [];
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";

	if (process.platform === "win32") {
		const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
		paths.push(
			// New Cursor stores user info in sentry directory
			path.join(appData, "Cursor", "sentry", "scope_v3.json"),
			path.join(appData, "Cursor", "sentry", "session.json"),
			// Legacy paths for compatibility
			path.join(appData, "Cursor", "User", "globalStorage", "storage.json"),
			path.join(appData, "Cursor", "storage.json"),
			path.join(appData, "Cursor", "User", "settings.json"),
			path.join(homeDir, ".cursor", "storage.json"),
			path.join(homeDir, ".cursor-tutor", "storage.json")
		);
	} else if (process.platform === "darwin") {
		paths.push(
			// New Cursor stores user info in sentry directory
			path.join(homeDir, "Library", "Application Support", "Cursor", "sentry", "scope_v3.json"),
			path.join(homeDir, "Library", "Application Support", "Cursor", "sentry", "session.json"),
			// Legacy paths for compatibility
			path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "storage.json"),
			path.join(homeDir, "Library", "Application Support", "Cursor", "storage.json"),
			path.join(homeDir, ".cursor", "storage.json")
		);
	} else {
		paths.push(
			// New Cursor stores user info in sentry directory
			path.join(homeDir, ".config", "Cursor", "sentry", "scope_v3.json"),
			path.join(homeDir, ".config", "Cursor", "sentry", "session.json"),
			// Legacy paths for compatibility
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
			log(`  - File does not exist: ${filePath}`);
			const dirPath = path.dirname(filePath);
			if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
				log(`  - Trying to search directory: ${dirPath}`);
				return await searchDirectoryForUserId(dirPath);
			}
			return null;
		}

		log(`  - File exists, reading content...`);
		const content = fs.readFileSync(filePath, "utf8");
		log(`  - File size: ${content.length} bytes`);

		try {
			const data = JSON.parse(content);

			// Check sentry/scope_v3.json format: scope.user.id = "google-oauth2|user_xxx"
			if (data.scope?.user?.id) {
				log(`  - Found scope.user.id: ${data.scope.user.id}`);
				const userId = extractUserIdFromOAuth(data.scope.user.id);
				if (userId) {
					log(`  - Extracted user ID: ${userId}`);
					return userId;
				}
			}

			// Check sentry/session.json format: did = "google-oauth2|user_xxx"
			if (data.did) {
				log(`  - Found did: ${data.did}`);
				const userId = extractUserIdFromOAuth(data.did);
				if (userId) {
					log(`  - Extracted user ID: ${userId}`);
					return userId;
				}
			}

			// Legacy format check
			const possibleKeys = ["cursorAuth/cachedSignInMethod", "userId", "user_id", "id"];
			for (const key of possibleKeys) {
				if (data[key] && typeof data[key] === "string" && data[key].startsWith("user_")) {
					log(`  - Found ${key}: ${data[key]}`);
					return data[key];
				}
			}

			// Recursively search object
			const found = findUserIdInObject(data);
			if (found) {
				log(`  - Found by recursive search: ${found}`);
			}
			return found;
		} catch (parseError) {
			log(`  - JSON parsing failed, trying regex match...`);
			const match = content.match(/user_[a-zA-Z0-9]{20,}/);
			if (match) {
				log(`  - Found by regex: ${match[0]}`);
				return match[0];
			}
		}
	} catch (error) {
		log(`  - Failed to read file: ${error}`);
	}
	return null;
}

// Extract user_xxx part from OAuth ID format
// Example: "google-oauth2|user_01J87EEM44VT22PEP4HM8A3GSG" -> "user_01J87EEM44VT22PEP4HM8A3GSG"
function extractUserIdFromOAuth(oauthId: string): string | null {
	if (!oauthId || typeof oauthId !== "string") return null;

	// If contains | separator, take the part after it
	if (oauthId.includes("|")) {
		const parts = oauthId.split("|");
		const userPart = parts.find((p) => p.startsWith("user_"));
		if (userPart) return userPart;
	}

	// Directly match ID starting with user_
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
		console.error(`Failed to search directory: ${dirPath}`, error);
	}
	return null;
}

/**
 * Get Cursor state.vscdb database path
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
 * Read accessToken from state.vscdb
 * Use sql.js to read SQLite database
 */
async function getAccessToken(): Promise<string | null> {
	// Return cached token if available
	if (cachedAccessToken) {
		log(`Using cached accessToken`);
		return cachedAccessToken;
	}

	const dbPath = getCursorDbPath();
	log(`Trying to read database: ${dbPath}`);

	if (!fs.existsSync(dbPath)) {
		log(`✗ Database file does not exist: ${dbPath}`);
		return null;
	}

	try {
		// Initialize sql.js, specify WASM file location (same directory as bundled extension.js)
		const SQL = await initSqlJs({
			locateFile: (file: string) => path.join(__dirname, file),
		});

		// Read database file
		const fileBuffer = fs.readFileSync(dbPath);
		const db: Database = new SQL.Database(fileBuffer);

		// Query accessToken
		const result = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");

		if (result.length > 0 && result[0].values.length > 0) {
			const tokenValue = result[0].values[0][0] as string;
			log(`✓ Successfully retrieved accessToken`);

			// Cache token
			cachedAccessToken = tokenValue;

			db.close();
			return tokenValue;
		} else {
			log(`✗ accessToken not found`);

			// Try to list all cursorAuth related keys
			const allKeys = db.exec("SELECT key FROM ItemTable WHERE key LIKE '%cursorAuth%'");
			if (allKeys.length > 0) {
				log(`  - Found cursorAuth related keys: ${allKeys[0].values.map((v) => v[0]).join(", ")}`);
			}

			db.close();
			return null;
		}
	} catch (error) {
		log(`✗ Failed to read database: ${error}`);
		return null;
	}
}

/**
 * Fetch usage data from API
 * Authenticate using WorkosCursorSessionToken Cookie
 * Cookie format: userId%3A%3AaccessToken (URL-encoded userId::accessToken)
 */
async function fetchUsageFromAPI(userId: string): Promise<UsageData | null> {
	// First get accessToken
	const accessToken = await getAccessToken();

	// Build correct Cookie value: userId::accessToken (URL-encoded as userId%3A%3AaccessToken)
	const cookieValue = accessToken ? `${userId}%3A%3A${accessToken}` : null;

	const makeRequest = (url: string, redirectCount: number = 0): Promise<UsageData | null> => {
		return new Promise((resolve) => {
			if (redirectCount > 5) {
				log(`✗ Too many redirects, stopping request`);
				resolve(null);
				return;
			}

			log(`Requesting API: ${url}${redirectCount > 0 ? ` (redirect #${redirectCount})` : ""}`);

			// Build request options
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

			// Add authentication header if Cookie exists
			if (cookieValue) {
				log(`  - Using Cookie authentication`);
				options.headers = {
					...options.headers,
					Cookie: `WorkosCursorSessionToken=${cookieValue}`,
				};
			} else {
				log(`  - No authentication info, trying unauthenticated request`);
			}

			https
				.get(options, (res) => {
					log(`API response status code: ${res.statusCode}`);

					// Handle 401 Unauthorized
					if (res.statusCode === 401) {
						log(`✗ Authentication failed (401), clearing cached token`);
						cachedAccessToken = null;
						resolve(null);
						return;
					}

					// Handle redirects (301, 302, 307, 308)
					if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
						const location = res.headers.location;
						if (location) {
							log(`  - Redirecting to: ${location}`);
							// If relative path, need to concatenate
							const redirectUrl = location.startsWith("http") ? location : `https://www.cursor.com${location}`;
							resolve(makeRequest(redirectUrl, redirectCount + 1));
						} else {
							log(`✗ Redirect without Location header`);
							resolve(null);
						}
						return;
					}

					let data = "";
					res.on("data", (chunk) => {
						data += chunk;
					});
					res.on("end", () => {
						log(`API response data length: ${data.length} bytes`);
						try {
							const parsed = JSON.parse(data);
							if (parsed.error) {
								log(`✗ API returned error: ${parsed.error}`);
								resolve(null);
							} else {
								log(`✓ API request successful`);
								log(`  - GPT-4 requests: ${parsed["gpt-4"]?.numRequests || "N/A"}`);
								log(`  - GPT-4 max requests: ${parsed["gpt-4"]?.maxRequestUsage || "N/A"}`);
								resolve(parsed as UsageData);
							}
						} catch (error) {
							log(`✗ JSON parsing failed: ${error}`);
							log(`  - Raw data: ${data.substring(0, 200)}...`);
							resolve(null);
						}
					});
				})
				.on("error", (error) => {
					log(`✗ Network request failed: ${error}`);
					resolve(null);
				});
		});
	};

	// Note: Must use cursor.com instead of www.cursor.com, otherwise will get 308 redirect
	return makeRequest(`https://cursor.com/api/usage?user=${userId}`);
}

let lastUsageData: UsageData | null = null;
let lastUserId: string | null = null;

async function refreshUsage() {
	log("========== Starting quota refresh ==========");
	const config = vscode.workspace.getConfiguration("cursorUsageTracker");
	const showInStatusBar = config.get<boolean>("showInStatusBar", true);

	if (!showInStatusBar) {
		log("Status bar display disabled, skipping refresh");
		statusBarItem.hide();
		return;
	}

	statusBarItem.text = "$(sync~spin) Loading...";
	statusBarItem.show();

	try {
		log("Step 1: Getting user ID...");
		const userId = await getUserId();
		if (!userId) {
			log("✗ Failed to get user ID");
			statusBarItem.text = "$(warning) No ID";
			statusBarItem.tooltip = "Unable to automatically get User ID, click to view logs";
			statusBarItem.command = "cursor-usage-tracker.showLogs";
			return;
		}

		log(`Step 2: Calling API to get quota data...`);
		lastUserId = userId;
		const usageData = await fetchUsageFromAPI(userId);

		if (!usageData) {
			log("✗ API request failed");
			statusBarItem.text = "$(error) Failed";
			statusBarItem.tooltip = "Unable to fetch data from Cursor API, click to view logs";
			statusBarItem.command = "cursor-usage-tracker.showLogs";
			return;
		}

		log("✓ Quota data retrieved successfully");
		lastUsageData = usageData;
		updateStatusBar(usageData);
		log("========== Refresh completed ==========");
	} catch (error) {
		log(`✗ Exception occurred during refresh: ${error}`);
		statusBarItem.text = "$(error) Error";
	}
}

function updateStatusBar(data: UsageData) {
	const gpt4 = data["gpt-4"];

	if (gpt4 && gpt4.maxRequestUsage) {
		const used = gpt4.numRequests;
		const max = gpt4.maxRequestUsage;
		const percentage = Math.round((used / max) * 100);

		// Show traffic light based on used percentage (no background color change)
		let icon = "";
		if (percentage < 30) {
			// Green: used < 30% (low usage, good status)
			icon = "🟢";
		} else if (percentage < 70) {
			// Yellow: used 30-70% (moderate usage)
			icon = "🟡";
		} else {
			// Red: used >= 70% (high usage, need attention)
			icon = "🔴";
		}

		// Display format: 🟢 0/500 (used/total)
		statusBarItem.text = `${icon} ${used}/${max}`;
		statusBarItem.tooltip = createTooltip(data);
		
		// Don't set background color, keep default style
		statusBarItem.backgroundColor = undefined;
	} else {
		statusBarItem.text = "$(info) Cursor";
		statusBarItem.tooltip = "Unable to get quota information";
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
		const percentage = typeof max === "number" ? Math.round((used / max) * 100) : 0;

		md.appendMarkdown(`### 🤖 Cursor Quota\n`);
		md.appendMarkdown(`**${used}**/${max} Used\n\n`);

		// Progress bar simulation
		const bars = 10;
		const filled = Math.round((percentage / 100) * bars);
		const empty = bars - filled;
		const barStr = "█".repeat(filled) + "░".repeat(empty);

		md.appendMarkdown(`\`[${barStr}] ${percentage}%\`\n\n`);
		md.appendMarkdown(`--- \n`);
		md.appendMarkdown(`- **Used**: ${used}\n`);
		md.appendMarkdown(`- **Tokens**: ${(gpt4.numTokens / 1000000).toFixed(2)}M\n`);
	}

	if (data.startOfMonth) {
		const resetDate = new Date(data.startOfMonth);
		const nextReset = new Date(resetDate);
		nextReset.setMonth(nextReset.getMonth() + 1);
		const daysLeft = Math.ceil((nextReset.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

		md.appendMarkdown(`\n---\n`);
		md.appendMarkdown(`📅 Resets in **${daysLeft} days** (${nextReset.toLocaleDateString()})`);
	}

	return md;
}



export function deactivate() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
}
