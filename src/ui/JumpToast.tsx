import { useEffect, useState } from 'preact/hooks';
import type { JumpState } from '../shared/types';
import { MAX_ATTEMPTS } from '../content/jumpController';

interface JumpToastProps {
  jumpState: JumpState;
  onDismiss?: () => void;
}

const FAILED_DISMISS_MS = 8000;

export function JumpToast({ jumpState, onDismiss }: JumpToastProps) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
    if (jumpState.status === 'failed') {
      const timer = window.setTimeout(() => {
        setDismissed(true);
        onDismiss?.();
      }, FAILED_DISMISS_MS);
      return () => window.clearTimeout(timer);
    }
  }, [jumpState, onDismiss]);

  if (jumpState.status === 'idle' || dismissed) return null;

  if (jumpState.status === 'jumping') {
    return (
      <div className="cqn-toast is-jumping" role="status" aria-live="polite">
        ⟳ 跳转中… (尝试 {jumpState.attempt}/{MAX_ATTEMPTS})
      </div>
    );
  }

  return (
    <div className="cqn-toast is-failed" role="alert">
      跳转失败：{jumpState.reason}
    </div>
  );
}
