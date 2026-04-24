import * as vscode from "vscode";
import * as https from "https";
import {
	getUserId,
	getAccessToken,
	clearCachedAccessToken,
	buildSessionCookie,
} from "./auth";

const API_REQUEST_TIMEOUT_MS = 15000;
const API_MAX_REDIRECTS = 5;
const API_MAX_NETWORK_RETRIES = 3;
const API_RETRY_BASE_DELAY_MS = 1000;
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ECONNABORTED",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"ERR_TLS_HANDSHAKE_TIMEOUT",
]);

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

interface RetryAsyncOptions {
	maxAttempts: number;
	shouldRetry: (error: unknown) => boolean;
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
	sleepFn?: (ms: number) => Promise<void>;
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") {
		return undefined;
	}

	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" ? code : undefined;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function formatError(error: unknown): string {
	const code = getErrorCode(error);
	const message = getErrorMessage(error);
	return code ? `${code}: ${message}` : message;
}

function isRetryableNetworkError(error: unknown): boolean {
	const code = getErrorCode(error);
	if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) {
		return true;
	}

	const message = getErrorMessage(error);
	return /Client network socket disconnected before secure TLS connection was established/i.test(message) ||
		/socket hang up/i.test(message);
}

async function retryAsync<T>(operation: (attempt: number) => Promise<T>, options: RetryAsyncOptions): Promise<T> {
	const sleepFn = options.sleepFn ?? sleep;

	for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
		try {
			return await operation(attempt);
		} catch (error) {
			if (attempt === options.maxAttempts || !options.shouldRetry(error)) {
				throw error;
			}

			const delayMs = API_RETRY_BASE_DELAY_MS * attempt;
			options.onRetry?.(error, attempt, delayMs);
			await sleepFn(delayMs);
		}
	}

	throw new Error("retryAsync exhausted without returning or throwing");
}

/**
 * Fetch usage data from API
 * Authenticate using WorkosCursorSessionToken Cookie
 * Cookie format: userId%3A%3AaccessToken (URL-encoded userId::accessToken)
 * @param userId - User ID
 * @param retryOnAuth - If true, retry once with fresh token on 401 error (default: true)
 */
async function fetchUsageFromAPI(userId: string, retryOnAuth: boolean = true): Promise<UsageData | null> {
	// First get accessToken
	const accessToken = await getAccessToken(false, log);

	// Build correct Cookie value: userId::accessToken (URL-encoded as userId%3A%3AaccessToken)
	const cookieHeader = accessToken ? buildSessionCookie(userId, accessToken) : null;

	const makeRequest = (url: string, redirectCount: number = 0): Promise<UsageData | null> => {
		return new Promise((resolve, reject) => {
			if (redirectCount > API_MAX_REDIRECTS) {
				log(`Too many redirects, stopping request`);
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
			if (cookieHeader) {
				log(`  - Using Cookie authentication`);
				options.headers = {
					...options.headers,
					Cookie: cookieHeader,
				};
			} else {
				log(`  - No authentication info, trying unauthenticated request`);
			}

			const request = https
				.get(options, (res) => {
					log(`API response status code: ${res.statusCode}`);

					// Handle 401 Unauthorized - retry with fresh token if allowed
					if (res.statusCode === 401) {
						log(`Authentication failed (401), clearing cached token`);
						clearCachedAccessToken();

						if (retryOnAuth) {
							log(`  - Retrying with fresh token from database...`);
							// Retry with force refresh token, but don't retry again
							resolve(fetchUsageFromAPI(userId, false));
						} else {
							log(`  - Already retried, giving up`);
							resolve(null);
						}
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
							log(`Redirect without Location header`);
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
								log(`API returned error: ${parsed.error}`);
								resolve(null);
							} else {
								log(`API request successful`);
								log(`  - GPT-4 requests: ${parsed["gpt-4"]?.numRequests || "N/A"}`);
								log(`  - GPT-4 max requests: ${parsed["gpt-4"]?.maxRequestUsage || "N/A"}`);
								resolve(parsed as UsageData);
							}
						} catch (error) {
							log(`JSON parsing failed: ${error}`);
							log(`  - Raw data: ${data.substring(0, 200)}...`);
							resolve(null);
						}
					});
				})
				.on("error", (error) => {
					reject(error);
				});

			request.setTimeout(API_REQUEST_TIMEOUT_MS, () => {
				const timeoutError = new Error(`Request timed out after ${API_REQUEST_TIMEOUT_MS}ms`) as NodeJS.ErrnoException;
				timeoutError.code = "ETIMEDOUT";
				request.destroy(timeoutError);
			});
		});
	};

	// Note: Must use cursor.com instead of www.cursor.com, otherwise will get 308 redirect
	try {
		return await retryAsync(
			() => makeRequest(`https://cursor.com/api/usage?user=${userId}`),
			{
				maxAttempts: API_MAX_NETWORK_RETRIES,
				shouldRetry: isRetryableNetworkError,
				onRetry: (error, attempt, delayMs) => {
					log(`Transient network error on API request (attempt ${attempt}/${API_MAX_NETWORK_RETRIES}): ${formatError(error)}`);
					log(`  - Retrying in ${delayMs}ms`);
				},
			}
		);
	} catch (error) {
		log(`Network request failed: ${formatError(error)}`);
		return null;
	}
}


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
		const userId = await getUserId(log);
		if (!userId) {
			log("Failed to get user ID");
			statusBarItem.text = "$(warning) No ID";
			statusBarItem.tooltip = "Unable to automatically get User ID, click to view logs";
			statusBarItem.command = "cursor-usage-tracker.showLogs";
			return;
		}

		log(`Step 2: Calling API to get quota data...`);
		const usageData = await fetchUsageFromAPI(userId);

		if (!usageData) {
			log("API request failed");
			statusBarItem.text = "$(error) Failed";
			statusBarItem.tooltip = "Unable to fetch data from Cursor API, click to view logs";
			statusBarItem.command = "cursor-usage-tracker.showLogs";
			return;
		}

		log("Quota data retrieved successfully");
		updateStatusBar(usageData);
		log("========== Refresh completed ==========");
	} catch (error) {
		log(`Exception occurred during refresh: ${error}`);
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
		if (percentage < 40) {
			// Green: used < 40% (low usage, good status)
			icon = "\u{1F7E2}";
		} else if (percentage < 70) {
			// Yellow: used 40-70% (moderate usage)
			icon = "\u{1F7E1}";
		} else {
			// Red: used >= 70% (high usage, need attention)
			icon = "\u{1F534}";
		}

		// Display format: icon + used/total, e.g. "🟢 0/500"
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
		const max = gpt4.maxRequestUsage ?? "N/A";
		const percentage = typeof max === "number" && max > 0 ? Math.round((used / max) * 100) : 0;

		md.appendMarkdown(`### Cursor Quota\n`);
		md.appendMarkdown(`**${used}**/${max} Used\n\n`);

		// Progress bar simulation
		const bars = 10;
		const filled = Math.round((percentage / 100) * bars);
		const empty = bars - filled;
		const barStr = "#".repeat(filled) + "-".repeat(empty);

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
		md.appendMarkdown(`Resets in **${daysLeft} days** (${nextReset.toLocaleDateString()})`);
	}

	return md;
}

export function deactivate() {
	if (refreshInterval) {
		clearInterval(refreshInterval);
	}
}

export const __test__ = {
	isRetryableNetworkError,
	retryAsync,
};

