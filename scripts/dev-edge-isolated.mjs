import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

process.env.CQN_EDGE_PROFILE_DIR = resolve('.wxt/edge-data');
execSync('npx wxt -b edge', { stdio: 'inherit' });
