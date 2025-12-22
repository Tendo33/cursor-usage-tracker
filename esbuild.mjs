import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// 确保 out 目录存在
const outDir = join(__dirname, 'out');
if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
}

// 复制 sql.js WASM 文件到 out 目录
const wasmSrc = join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmDest = join(outDir, 'sql-wasm.wasm');
if (existsSync(wasmSrc)) {
    copyFileSync(wasmSrc, wasmDest);
    console.log('✓ Copied sql-wasm.wasm to out/');
} else {
    console.warn('⚠ sql-wasm.wasm not found, please run npm install first');
}

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode'],
    logLevel: 'info',
};

async function main() {
    try {
        if (watch) {
            const ctx = await esbuild.context(buildOptions);
            await ctx.watch();
            console.log('👀 Watching for changes...');
        } else {
            await esbuild.build(buildOptions);
            console.log(production ? '✓ Production build complete' : '✓ Development build complete');
        }
    } catch (err) {
        console.error('Build failed:', err);
        process.exit(1);
    }
}

main();
