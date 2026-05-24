import type { CachedUserMessage } from '../shared/types';

export class JumpController {
  async jumpToMessage(_target: CachedUserMessage): Promise<boolean> {
    return false;
  }

  cancelCurrent(): void {}
}
