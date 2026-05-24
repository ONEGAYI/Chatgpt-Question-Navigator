import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { defineWebExtConfig } from 'wxt';

const profileDir =
  process.env.CQN_EDGE_PROFILE_DIR ??
  resolve(process.env.LOCALAPPDATA ?? '', 'ChatGPTQuestionNavigator', 'edge-dev-profile');

mkdirSync(profileDir, { recursive: true });

export default defineWebExtConfig({
  chromiumProfile: profileDir,
  keepProfileChanges: true,
  binaries: { edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
});
