import { render } from 'preact';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AutoCollector } from '../content/autoCollector';
import type { JumpController } from '../content/jumpController';
import type { RuntimeStore } from '../content/runtimeStore';
import { Sidebar } from './Sidebar';

export async function createShadowRootApp(
  ctx: ContentScriptContext,
  deps: {
    runtimeStore: RuntimeStore;
    jumpController: JumpController;
    onClearCurrentSession: () => Promise<void>;
    onStartAutoCollect: () => void;
    autoCollector: AutoCollector;
  }
): Promise<void> {
  const ui = await createShadowRootUi(ctx, {
    name: 'chatgpt-navigator',
    position: 'overlay',
    anchor: 'body',
    onMount(container: HTMLElement) {
      render(
        <Sidebar
          runtimeStore={deps.runtimeStore}
          jumpController={deps.jumpController}
          onClearCurrentSession={deps.onClearCurrentSession}
          onStartAutoCollect={deps.onStartAutoCollect}
          autoCollector={deps.autoCollector}
        />,
        container
      );
      return () => render(null, container);
    },
    onRemove(mounted) {
      if (typeof mounted === 'function') mounted();
    }
  });

  ui.mount();
}
