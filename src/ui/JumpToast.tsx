import type { JumpState } from '../shared/types';

interface JumpToastProps {
  jumpState: JumpState;
  onCancel: () => void;
}

export function JumpToast({ jumpState, onCancel }: JumpToastProps) {
  if (jumpState.status === 'idle') return null;

  if (jumpState.status === 'jumping') {
    return (
      <div className="cqn-toast cqn-toast--jumping">
        <span className="cqn-toast-text">正在跳转... ({jumpState.attempt}/30)</span>
        <button className="cqn-toast-btn" type="button" onClick={onCancel}>取消</button>
      </div>
    );
  }

  // status === 'failed'
  return (
    <div className="cqn-toast cqn-toast--failed">
      <span className="cqn-toast-text">{jumpState.reason}</span>
      <button className="cqn-toast-btn" type="button" onClick={onCancel}>关闭</button>
    </div>
  );
}
