import { cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const buildDir = join(process.cwd(), '.output', 'chrome-mv3');
const tempDir = join(tmpdir(), 'Chatgpt-Question-Navigator');

if (!existsSync(buildDir)) {
  console.error('Build output not found:', buildDir);
  process.exit(1);
}

rmSync(tempDir, { recursive: true, force: true });
cpSync(buildDir, tempDir, { recursive: true });

console.log(`Build copied to: ${tempDir}`);
