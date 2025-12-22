/**
 * Cursor API 测试脚本
 * 运行: node test-api.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// 获取用户ID
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

// 获取 AccessToken (使用 sql.js)
async function getAccessToken() {
    const initSqlJs = require('sql.js');
    const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    
    if (!fs.existsSync(dbPath)) {
        console.log('数据库文件不存在:', dbPath);
        return null;
    }

    const SQL = await initSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);
    
    const result = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");
    db.close();
    
    return result.length > 0 ? result[0].values[0][0] : null;
}

// 请求 API
function fetchUsage(userId, token) {
    // Cookie 格式: userId%3A%3Atoken (即 userId::token 的 URL 编码)
    const cookie = `WorkosCursorSessionToken=${userId}%3A%3A${token}`;
    
    const options = {
        hostname: 'cursor.com',  // 注意：必须用 cursor.com，不能用 www.cursor.com
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
                console.log('✓ 成功！');
                console.log(`  GPT-4 已用: ${json['gpt-4']?.numRequests}`);
                console.log(`  GPT-4 上限: ${json['gpt-4']?.maxRequestUsage}`);
            } else {
                console.log('✗ 失败:', data);
            }
        });
    }).on('error', e => console.log('请求错误:', e.message));
}

// 主函数
async function main() {
    const userId = getUserId();
    const token = await getAccessToken();

    console.log('='.repeat(40));
    console.log('Cursor API 测试');
    console.log('='.repeat(40));
    console.log(`User ID: ${userId}`);
    console.log(`Token: ${token?.substring(0, 30)}...`);
    console.log('');

    if (userId && token) {
        fetchUsage(userId, token);
    } else {
        console.log('✗ 无法获取 userId 或 token');
    }
}

main();
