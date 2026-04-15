/**
 * Cursor API 测试脚本
 * 运行: node test-api.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('module');

const MAX_READFILE_SIZE = 2 * 1024 * 1024 * 1024;

function loadExtensionForTests() {
    const extensionPath = path.join(__dirname, 'out', 'extension.js');
    const originalLoad = Module._load;

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'vscode') {
            return {};
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[require.resolve(extensionPath)];

    try {
        return require(extensionPath);
    } finally {
        Module._load = originalLoad;
    }
}

if (process.env.NODE_TEST_CONTEXT) {
    test('release workflow 会在 tag 推送后创建 GitHub Release 并上传 vsix', () => {
        const workflowPath = path.join(__dirname, '.github', 'workflows', 'release.yml');
        assert.equal(fs.existsSync(workflowPath), true);

        const workflow = fs.readFileSync(workflowPath, 'utf8');
        assert.match(workflow, /push:\s*[\r\n]+\s*tags:\s*[\r\n]+\s*-\s*'v\*'/);
        assert.match(workflow, /permissions:\s*[\r\n]+\s*contents:\s*write/);
        assert.match(workflow, /npm run package/);
        assert.match(workflow, /gh release create/);
        assert.match(workflow, /VERSION="\$\{GITHUB_REF_NAME#v\}"/);
        assert.match(workflow, /VSIX_PATH="cursor-usage-tracker-\$\{VERSION\}\.vsix"/);
    });

    test('.vscodeignore 会排除 .github，避免 workflow 被打进 VSIX', () => {
        const ignorePath = path.join(__dirname, '.vscodeignore');
        assert.equal(fs.existsSync(ignorePath), true);

        const ignoreRules = fs.readFileSync(ignorePath, 'utf8');
        assert.match(ignoreRules, /^\.github\/\*\*$/m);
    });

    test('将 TLS 握手断连识别为可重试网络错误', () => {
        const extension = loadExtensionForTests();
        const error = new Error('Client network socket disconnected before secure TLS connection was established');

        assert.equal(extension.__test__.isRetryableNetworkError(error), true);
    });

    test('遇到瞬时网络错误时会重试直到成功', async () => {
        const extension = loadExtensionForTests();
        const delays = [];
        let attempts = 0;

        const result = await extension.__test__.retryAsync(async () => {
            attempts += 1;

            if (attempts < 3) {
                const error = new Error('Client network socket disconnected before secure TLS connection was established');
                error.code = 'ECONNRESET';
                throw error;
            }

            return 'ok';
        }, {
            maxAttempts: 3,
            shouldRetry: extension.__test__.isRetryableNetworkError,
            sleepFn: async (delayMs) => {
                delays.push(delayMs);
            },
        });

        assert.equal(result, 'ok');
        assert.equal(attempts, 3);
        assert.deepEqual(delays, [1000, 2000]);
    });

    test('非瞬时错误不会误重试', async () => {
        const extension = loadExtensionForTests();
        const delays = [];
        let attempts = 0;

        await assert.rejects(async () => extension.__test__.retryAsync(async () => {
            attempts += 1;
            throw new Error('Authentication failed');
        }, {
            maxAttempts: 3,
            shouldRetry: extension.__test__.isRetryableNetworkError,
            sleepFn: async (delayMs) => {
                delays.push(delayMs);
            },
        }), /Authentication failed/);

        assert.equal(attempts, 1);
        assert.deepEqual(delays, []);
    });
}

// 获取用户 ID
function getUserId() {
    const appData = process.env.APPDATA;
    const filePath = path.join(appData, 'Cursor', 'sentry', 'scope_v3.json');

    if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.scope?.user?.id?.includes('|')) {
            return data.scope.user.id.split('|').find(p => p.startsWith('user_'));
        }
    }
    return null;
}

function execFileAsync(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            const value = stdout.trim();
            resolve(value.length > 0 ? value : null);
        });
    });
}

async function getAccessTokenViaSqlJs(dbPath) {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    try {
        const result = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");
        return result.length > 0 ? result[0].values[0][0] : null;
    } finally {
        db.close();
    }
}

async function getAccessTokenViaPython(dbPath) {
    const commands = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
    const script =
        "import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); cur = conn.cursor(); " +
        "cur.execute(\"SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1\"); " +
        "row = cur.fetchone(); print(row[0] if row and row[0] else ''); conn.close()";

    for (const cmd of commands) {
        try {
            console.log(`尝试 fallback 命令: ${cmd}`);
            const token = await execFileAsync(cmd, ['-c', script, dbPath]);
            if (token) {
                return token;
            }
        } catch (error) {
            console.log(`fallback 命令失败 (${cmd}): ${error.message || error}`);
        }
    }

    return null;
}

// 获取 AccessToken
async function getAccessToken() {
    const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');

    if (!fs.existsSync(dbPath)) {
        console.log('数据库文件不存在:', dbPath);
        return null;
    }

    const dbSize = fs.statSync(dbPath).size;
    console.log(`数据库大小: ${dbSize} bytes`);

    try {
        if (dbSize >= MAX_READFILE_SIZE) {
            console.log('数据库超过 2 GiB，使用 Python fallback');
            return await getAccessTokenViaPython(dbPath);
        }
        return await getAccessTokenViaSqlJs(dbPath);
    } catch (error) {
        if (error && error.code === 'ERR_FS_FILE_TOO_LARGE') {
            console.log('命中 ERR_FS_FILE_TOO_LARGE，改用 Python fallback');
            return await getAccessTokenViaPython(dbPath);
        }
        throw error;
    }
}

// 请求 API
function fetchUsage(userId, token) {
    const cookie = `WorkosCursorSessionToken=${userId}%3A%3A${token}`;

    const options = {
        hostname: 'cursor.com',
        path: `/api/usage?user=${userId}`,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json',
            'Cookie': cookie,
        },
    };

    console.log(`请求: https://${options.hostname}${options.path}`);
    console.log(`Cookie: ${cookie.substring(0, 60)}...`);

    https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            console.log(`状态码: ${res.statusCode}`);
            if (res.statusCode === 200) {
                const json = JSON.parse(data);
                console.log('请求成功');
                console.log(`  GPT-4 已用: ${json['gpt-4']?.numRequests}`);
                console.log(`  GPT-4 上限: ${json['gpt-4']?.maxRequestUsage}`);
            } else {
                console.log('请求失败:', data);
            }
        });
    }).on('error', e => console.log('请求错误:', e.message));
}

async function main() {
    const userId = getUserId();
    const token = await getAccessToken();

    console.log('='.repeat(40));
    console.log('Cursor API 测试');
    console.log('='.repeat(40));
    console.log(`User ID: ${userId}`);
    console.log(`Token: ${token ? `${token.substring(0, 30)}...` : token}`);
    console.log('');

    if (userId && token) {
        fetchUsage(userId, token);
    } else {
        console.log('无法获取 userId 或 token');
    }
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
    main().catch((error) => {
        console.error('脚本执行失败:', error);
        process.exitCode = 1;
    });
}
