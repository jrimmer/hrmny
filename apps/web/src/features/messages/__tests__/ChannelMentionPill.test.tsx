/**
 * `<#channel>` in a message body: a known workspace channel renders as an
 * in-app link named from the reader's store; anything else as
 * `#unknown-channel`, never leaking a name the reader cannot see.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

import { createStateStore } from '@cytale/state';
import { resolveMentionTokens } from '@cytale/markdown';

import { ChannelMentionPill, channelNameOf } from '../ChannelMentionPill.js';
import { renderMarkdown } from '../markdown.js';

afterEach(cleanup);

function storeWith(channels: Record<string, unknown>) {
  const store = createStateStore();
  store.setState({ channels } as never);
  return store;
}

describe('ChannelMentionPill', () => {
  const store = storeWith({
    '11': { id: '11', name: 'general', workspace_id: 'ws1', type: 'text' },
    '12': { id: '12', name: 'Projects', workspace_id: 'ws1', type: 'category' },
  });

  it('a known channel is an in-app link to it, named #name', () => {
    render(<ChannelMentionPill channelId="11" store={store} />);
    const pill = screen.getByText('#general');
    expect(pill.tagName).toBe('A');
    expect(pill.getAttribute('href')).toBe('#/workspace/ws1/channel/11');
  });

  it('an unknown channel (or a category) shows #unknown-channel and is not a link', () => {
    render(
      <>
        <ChannelMentionPill channelId="99" store={store} />
        <ChannelMentionPill channelId="12" store={store} />
      </>,
    );
    const pills = screen.getAllByText('#unknown-channel');
    expect(pills).toHaveLength(2);
    expect(pills.every((p) => p.tagName === 'SPAN')).toBe(true);
  });

  it('the body renderer uses the injected pill, and falls back to #id without one', () => {
    render(
      <div data-testid="with">
        {renderMarkdown('see <#11>', undefined, undefined, (id, key) => (
          <ChannelMentionPill key={key} channelId={id} store={store} />
        ))}
      </div>,
    );
    expect(screen.getByTestId('with').textContent).toBe('see #general');
    cleanup();
    render(<div data-testid="without">{renderMarkdown('see <#11>')}</div>);
    expect(screen.getByTestId('without').textContent).toBe('see #11');
  });

  it('reply snippets rewrite channel tokens to names too', () => {
    const resolve = (id: string) => channelNameOf(store, id) ?? 'unknown-channel';
    expect(resolveMentionTokens('in <#11> and <#99>', undefined, resolve)).toBe(
      'in #general and #unknown-channel',
    );
  });
});
