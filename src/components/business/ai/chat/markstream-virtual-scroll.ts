import type { MarkstreamVirtualMetrics } from 'markstream-vue';
import type { InjectionKey, Ref } from 'vue';

export interface IAiMarkdownVirtualScrollContext {
  scrollRoot: Readonly<Ref<HTMLElement | null>>;
  threadKey: Readonly<Ref<string>>;
  measurementKey: Readonly<Ref<string>>;
  onHeightChange: (metrics: MarkstreamVirtualMetrics) => void;
}

export const AI_MARKDOWN_VIRTUAL_SCROLL_KEY: InjectionKey<IAiMarkdownVirtualScrollContext> = Symbol(
  'AI_MARKDOWN_VIRTUAL_SCROLL_KEY',
);
