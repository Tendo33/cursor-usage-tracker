import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import initSqlJs, { Database } from 'sql.js';

const MAX_READFILE_SIZE = 2 * 1024 * 1024 * 1024;
let cachedAccessToken: string | null = null;

export function getPossibleStoragePaths(): string[] {
  const paths: string[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    paths.push(
      path.join(appData, 'Cursor', 'sentry', 'scope_v3.json'),
      path.join(appData, 'Cursor', 'sentry', 'session.json'),
      path.join(appData, 'Cursor', 'User', 'globalStorage', 'storage.json'),
      path.join(appData, 'Cursor', 'storage.json'),
      path.join(appData, 'Cursor', 'User', 'settings.json'),
      path.join(homeDir, '.cursor', 'storage.json'),
      path.join(homeDir, '.cursor-tutor', 'storage.json'),
    );
  } else if (process.platform === 'darwin') {
    paths.push(
      path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'sentry', 'scope_v3.json'),
      path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'sentry', 'session.json'),
      path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json'),
      path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'storage.json'),
      path.join(homeDir, '.cursor', 'storage.json'),
    );
  } else {
    paths.push(
      path.join(homeDir, '.config', 'Cursor', 'sentry', 'scope_v3.json'),
      path.join(homeDir, '.config', 'Cursor', 'sentry', 'session.json'),
      path.join(homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'storage.json'),
      path.join(homeDir, '.config', 'Cursor', 'storage.json'),
      path.join(homeDir, '.cursor', 'storage.json'),
    );
  }
  return paths;
}

export function getCursorDbPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  } else if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function extractUserIdFromOAuth(oauthId: unknown): string | null {
  if (!oauthId || typeof oauthId !== 'string') return null;
  if (oauthId.includes('|')) {
    const parts = oauthId.split('|');
    const userPart = parts.find((p) => p.startsWith('user_'));
    if (userPart) return userPart;
  }
  if (oauthId.startsWith('user_')) return oauthId;
  return null;
}

function findUserIdInObject(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const key in obj) {
    const value = obj[key];
    if (typeof value === 'string' && value.startsWith('user_') && value.length > 20) return value;
    if (typeof value === 'object') {
      const found = findUserIdInObject(value);
      if (found) return found;
    }
  }
  return null;
}

async function findUserIdInPath(filePath: string, log: (m: string) => void): Promise<string | null> {
  try {
    if (!fs.existsSync(filePath)) {
      const dirPath = path.dirname(filePath);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        return await searchDirectoryForUserId(dirPath, log);
      }
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    try {
      const data = JSON.parse(content);
      if (data.scope?.user?.id) {
        const id = extractUserIdFromOAuth(data.scope.user.id);
        if (id) return id;
      }
      if (data.did) {
        const id = extractUserIdFromOAuth(data.did);
        if (id) return id;
      }
      const possibleKeys = ['cursorAuth/cachedSignInMethod', 'userId', 'user_id', 'id'];
      for (const key of possibleKeys) {
        if (typeof data[key] === 'string' && data[key].startsWith('user_')) return data[key];
      }
      return findUserIdInObject(data);
    } catch {
      const match = content.match(/user_[a-zA-Z0-9]{20,}/);
      return match ? match[0] : null;
    }
  } catch (err) {
    log(`  - failed to read file: ${err}`);
    return null;
  }
}

async function searchDirectoryForUserId(dirPath: string, log: (m: string) => void): Promise<string | null> {
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile() && (file.endsWith('.json') || file === 'storage.json')) {
        const id = await findUserIdInPath(filePath, log);
        if (id) return id;
      } else if (stat.isDirectory() && !file.startsWith('.')) {
        const id = await searchDirectoryForUserId(filePath, log);
        if (id) return id;
      }
    }
  } catch {}
  return null;
}

export async function getUserId(log: (m: string) => void = () => {}): Promise<string | null> {
  for (const p of getPossibleStoragePaths()) {
    log(`Trying path: ${p}`);
    const id = await findUserIdInPath(p, log);
    if (id) {
      log(`Successfully found user ID: ${id}`);
      return id;
    }
  }
  return null;
}

function execFileAsync(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const t = stdout.trim();
      resolve(t.length > 0 ? t : null);
    });
  });
}

async function getAccessTokenViaSqlJs(dbPath: string): Promise<string | null> {
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(__dirname, f) });
  const buf = fs.readFileSync(dbPath);
  const db: Database = new SQL.Database(buf);
  try {
    const r = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");
    if (r.length > 0 && r[0].values.length > 0) return r[0].values[0][0] as string;
    return null;
  } finally {
    db.close();
  }
}

async function getAccessTokenViaPython(dbPath: string): Promise<string | null> {
  const cmds = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  const script =
    "import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); cur = conn.cursor(); " +
    "cur.execute(\"SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1\"); " +
    "row = cur.fetchone(); print(row[0] if row and row[0] else ''); conn.close()";
  for (const cmd of cmds) {
    try {
      const tok = await execFileAsync(cmd, ['-c', script, dbPath]);
      if (tok) return tok;
    } catch {}
  }
  return null;
}

function isFileTooLargeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as NodeJS.ErrnoException).code === 'ERR_FS_FILE_TOO_LARGE';
}

export async function getAccessToken(forceRefresh = false, log: (m: string) => void = () => {}): Promise<string | null> {
  if (cachedAccessToken && !forceRefresh) return cachedAccessToken;
  if (forceRefresh) cachedAccessToken = null;

  const dbPath = getCursorDbPath();
  if (!fs.existsSync(dbPath)) {
    log(`Database file does not exist: ${dbPath}`);
    return null;
  }
  try {
    const dbSize = fs.statSync(dbPath).size;
    let token: string | null = null;
    if (dbSize >= MAX_READFILE_SIZE) {
      token = await getAccessTokenViaPython(dbPath);
    } else {
      token = await getAccessTokenViaSqlJs(dbPath);
    }
    if (token) cachedAccessToken = token;
    return token;
  } catch (err) {
    if (isFileTooLargeError(err)) {
      const token = await getAccessTokenViaPython(dbPath);
      if (token) cachedAccessToken = token;
      return token;
    }
    log(`Failed to read database: ${err}`);
    return null;
  }
}

export function clearCachedAccessToken(): void {
  cachedAccessToken = null;
}

export function buildSessionCookie(userId: string, accessToken: string): string {
  return `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`;
}

export const __test__ = { extractUserIdFromOAuth, findUserIdInObject };
