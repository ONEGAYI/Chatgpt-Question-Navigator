#!/usr/bin/env node

/**
 * 版本管理脚本
 * 用法: node scripts/bump.mjs [patch|minor|major|VERSION] [--dry-run]
 *
 * 从 package.json 读取当前版本，计算新版本后同步更新:
 *   - package.json
 *   - wxt.config.ts
 *
 * --dry-run 模式只打印变更，不写文件。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pkgPath = resolve(root, 'package.json');
const wxtPath = resolve(root, 'wxt.config.ts');

// ── helpers ──────────────────────────────────────────────

function readVersionFromPkg() {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

function parseSemver(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [+m[1], +m[2], +m[3]];
}

function formatSemver([major, minor, patch]) {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(current, type) {
  const parts = parseSemver(current);
  if (!parts) {
    console.error(`✗ 当前版本 "${current}" 不是有效的 semver`);
    process.exit(1);
  }

  // 尝试解析为精确版本号
  const exact = parseSemver(type);
  if (exact) {
    if (formatSemver(exact) <= current) {
      console.error(`✗ 新版本 ${formatSemver(exact)} 不大于当前版本 ${current}`);
      process.exit(1);
    }
    return formatSemver(exact);
  }

  const [major, minor, patch] = parts;
  switch (type) {
    case 'patch': return formatSemver([major, minor, patch + 1]);
    case 'minor': return formatSemver([major, minor + 1, 0]);
    case 'major': return formatSemver([major + 1, 0, 0]);
    default:
      console.error(`✗ 未知的版本参数 "${type}"，请使用 patch|minor|major|x.y.z`);
      process.exit(1);
  }
}

function updateFile(filePath, content, oldVer, newVer, dryRun) {
  const escaped = oldVer.replace(/\./g, '\\.');
  // 匹配两种格式：
  //   package.json  →  "version": "0.1.0"
  //   wxt.config.ts  →  version: '0.1.0'
  const regex = new RegExp(
    `(["']?version["']?\\s*:\\s*['"])${escaped}(['"])`
  );
  if (!regex.test(content)) {
    console.error(`✗ 在 ${filePath} 中未找到版本模式 "${oldVer}"`);
    process.exit(1);
  }
  const updated = content.replace(regex, `$1${newVer}$2`);
  if (dryRun) {
    console.log(`  [dry-run] ${filePath} → ${newVer}`);
  } else {
    writeFileSync(filePath, updated, 'utf8');
    console.log(`  ✓ ${filePath} → ${newVer}`);
  }
}

// ── main ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const type = args.filter(a => a !== '--dry-run')[0];

if (!type) {
  console.error('用法: node scripts/bump.mjs [patch|minor|major|VERSION] [--dry-run]');
  process.exit(1);
}

const current = readVersionFromPkg();
const next = bumpVersion(current, type);

console.log(`\n  ${current} → ${next}${dryRun ? ' (dry-run)' : ''}\n`);

const pkgContent = readFileSync(pkgPath, 'utf8');
const wxtContent = readFileSync(wxtPath, 'utf8');

updateFile(pkgPath, pkgContent, current, next, dryRun);
updateFile(wxtPath, wxtContent, current, next, dryRun);

if (!dryRun) {
  console.log('\n  版本已更新。运行 pnpm build 重新生成 manifest。');
} else {
  console.log('\n  (dry-run 模式，未修改任何文件)');
}
