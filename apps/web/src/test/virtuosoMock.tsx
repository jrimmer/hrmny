/**
 * @cytale/web — a layout-free react-virtuoso stand-in for unit tests.
 *
 * jsdom has no layout, so the real Virtuoso renders no rows. This renders
 * EVERY item in order inside a `data-virtuoso-scroller` node (the list's pin
 * writes that node's scrollTop), plus the `components.Header`/`Footer` with
 * the list's `context` — the thread panel's starter line and origin live in
 * the Header (#15). The last props are exposed for assertions.
 *
 * Use it from a test file:
 *
 *   vi.mock('react-virtuoso', async () => (await import('<rel>/test/virtuosoMock.js')).virtuosoModule());
 */
import React from 'react';

export const virtuosoMockState: {
  lastProps: Record<string, unknown> | null;
  scrollToIndexCalls: Array<{ index: number; align?: string; behavior?: string }>;
} = { lastProps: null, scrollToIndexCalls: [] };

interface MockProps {
  data?: readonly unknown[];
  itemContent: (index: number, data: unknown) => React.ReactNode;
  computeItemKey?: (index: number, data: unknown) => string;
  context?: unknown;
  components?: {
    Header?: React.ComponentType<{ context?: unknown }>;
    Footer?: React.ComponentType<{ context?: unknown }>;
  };
}

const Virtuoso = React.forwardRef(function Virtuoso(props: MockProps, ref: React.Ref<unknown>) {
  React.useImperativeHandle(ref, () => ({
    scrollToIndex: (params: { index: number; align?: string; behavior?: string }) => {
      virtuosoMockState.scrollToIndexCalls.push(params);
    },
    scrollTo: () => {},
    scrollBy: () => {},
    getState: (cb: (s: unknown) => void) => cb({ ranges: [], scrollTop: 0 }),
  }));
  virtuosoMockState.lastProps = props as unknown as Record<string, unknown>;
  const items = props.data ?? [];
  const Header = props.components?.Header;
  const Footer = props.components?.Footer;
  return (
    <div data-virtuoso-scroller="true" data-testid="virtuoso-mock">
      <div data-testid="virtuoso-item-list">
        {Header ? <Header context={props.context} /> : null}
        {items.map((item, i) => (
          <div key={props.computeItemKey?.(i, item) ?? i} data-testid="virtuoso-item">
            {props.itemContent(i, item)}
          </div>
        ))}
        {Footer ? <Footer context={props.context} /> : null}
      </div>
    </div>
  );
});

/** The module shape `vi.mock('react-virtuoso', …)` must return. */
export function virtuosoModule() {
  return { Virtuoso };
}
