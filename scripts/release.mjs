#!/usr/bin/env node

/**
 * 发布脚本
 * 用法: node scripts/release.mjs
 *
 * 流程：git pull（阻塞）→ git push → pnpm build → pnpm zip
 * 输出 zip 路径供后续 gh release create 使用。
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pkgPath = resolve(root, 'package.json');

function run(cmd, label) {
  console.log(`\n▸ ${label}`);
  try {
    execSync(cmd, { cwd: root, stdio: 'inherit' });
  } catch {
    console.error(`\n✗ ${label} 失败，中止发布。`);
    process.exit(1);
  }
}

// ── main ─────────────────────────────────────────────────

const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const tag = `v${version}`;

console.log(`\n  发布 ${tag}\n`);

run('git pull --rebase', '拉取远端最新代码');
run('git push', '推送本地提交');
run('pnpm build', '生产构建');
run('pnpm zip', '打包 zip');

console.log(`\n  ✓ 发布准备完成`);
console.log(`  版本: ${tag}`);
console.log(`  产物: .output/chatgpt-question-navigator-${version}-chrome.zip`);
console.log(`\n  下一步：更新 CHANGELOG / CLAUDE.md / Tree.md 后执行：`);
console.log(`  gh release create ${tag} .output/chatgpt-question-navigator-${version}-chrome.zip --title "${tag}" --notes "详见 CHANGELOG"\n`);
