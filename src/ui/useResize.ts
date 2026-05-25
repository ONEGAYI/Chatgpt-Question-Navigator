import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

const MIN_WIDTH = 240;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 280;

export interface UseResizeOptions {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  storageKey: string;
}

export interface UseResizeReturn {
  width: number;
  isResizing: boolean;
  dragHandleProps: {
    onMouseDown: (e: MouseEvent) => void;
  };
}

export function useResize({
  defaultWidth = DEFAULT_WIDTH,
  minWidth = MIN_WIDTH,
  maxWidth = MAX_WIDTH,
  storageKey,
}: UseResizeOptions): UseResizeReturn {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // 从 chrome.storage.local 加载持久化的宽度
  useEffect(() => {
    chrome.storage.local.get(storageKey, (result) => {
      const stored = result[storageKey];
      if (typeof stored === 'number' && stored >= minWidth && stored <= maxWidth) {
        setWidth(stored);
      }
      setLoaded(true);
    });
  }, [storageKey, minWidth, maxWidth]);

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsResizing(true);

      const originalUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';

      const handleMouseMove = (ev: MouseEvent) => {
        // 侧栏在右侧，鼠标左移 = 宽度增大（right edge fixed, left edge moves left）
        const dx = startXRef.current - ev.clientX;
        const next = Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + dx));
        setWidth(next);
      };

      const handleMouseUp = (ev: MouseEvent) => {
        document.body.style.userSelect = originalUserSelect;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        setIsResizing(false);

        // 持久化最终宽度
        const dx = startXRef.current - ev.clientX;
        const finalWidth = Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + dx));
        chrome.storage.local.set({ [storageKey]: finalWidth });
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [width, minWidth, maxWidth, storageKey]
  );

  // 未加载完成前用默认宽度，加载完成后用存储值
  return {
    width: loaded ? width : defaultWidth,
    isResizing,
    dragHandleProps: { onMouseDown: handleMouseDown },
  };
}
