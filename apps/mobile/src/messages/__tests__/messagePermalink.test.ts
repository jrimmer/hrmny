/**
 * #118 — the mobile permalink MINTER.
 *
 * The point of these tests is that this client no longer SPELLS a permalink:
 * the token is keyed server-side, so a link exists only after the mint
 * (`POST /permalinks`) answers. So the assertions are about the round trip —
 * the two ids it carries, that there is exactly one of it, and the URL the
 * clipboard would get: `<origin>/m/<token>`, with no `#`, no route grammar and
 * no ids.
 *
 * `isSnowflake`/origin refusals are asserted to spend NO round trip: there is
 * nothing to mint, and asking the server for a link to a placeholder would be
 * a request nobody can answer.
 */
import { createMemoryTokenStorage, createSessionManager } from '@cytale/session';

import { createFakeGateway, installWire } from '../../auth/__tests__/support';
import { mintMessageLink, sessionPermalinkMinter } from '../messagePermalink';

const CHANNEL = '700000000000000001';
const THREAD = '800000000000000009';
const MESSAGE = '1000000000000000003';

/** A token spelled like a minted one (30 base62 characters, #118). */
const TOKEN = '3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP';

/** A mint that records its call and answers the fixed token. */
function recordingMint() {
  return jest.fn(async (_channelId: string, _messageId: string) => ({ token: TOKEN }));
}

describe('mintMessageLink', () => {
  it('mints ONE round trip carrying the two ids, and writes <origin>/m/<token>', async () => {
    const mint = recordingMint();

    const url = await mintMessageLink(
      { id: MESSAGE, channel_id: CHANNEL, thread_id: null },
      mint,
      'https://chat.example.com',
    );

    // The POST body, exactly: the channel and the message — nothing else is
    // the client's to send.
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith(CHANNEL, MESSAGE);

    // And what lands on the clipboard: the origin, the one opaque segment, the
    // token. No hash (the fragment form is gone), no grammar, no ids.
    expect(url).toBe(`https://chat.example.com/m/${TOKEN}`);
    expect(url).not.toContain('#');
    expect(url).not.toContain('/workspace');
    expect(url).not.toContain(CHANNEL);
    expect(url).not.toContain(MESSAGE);
  });

  it('a thread reply mints with the PARENT CHANNEL id, never the thread id', async () => {
    const mint = recordingMint();

    // The shape the store holds: a reply's `channel_id` is its parent channel
    // (stamped from `threadsById`), `thread_id` names the thread it lives in.
    const url = await mintMessageLink(
      { id: MESSAGE, channel_id: CHANNEL, thread_id: THREAD },
      mint,
      'https://chat.example.com',
    );

    // The parent channel + the reply: the pair the server keys the token with,
    // which is what makes the landing open the reply INSIDE the thread.
    expect(mint).toHaveBeenCalledWith(CHANNEL, MESSAGE);
    expect(mint).not.toHaveBeenCalledWith(THREAD, MESSAGE);
    // The thread id is not part of the address either — the token carries the
    // route, the link does not.
    expect(url).toBe(`https://chat.example.com/m/${TOKEN}`);
    expect(url).not.toContain(THREAD);
  });

  it('uses the configured build origin by default', async () => {
    // The jest setup pins EXPO_PUBLIC_CYTALE_ORIGIN (src/test/setup.ts).
    const url = await mintMessageLink({ id: MESSAGE, channel_id: CHANNEL }, recordingMint());
    expect(url).toBe(`http://127.0.0.1:4001/m/${TOKEN}`);
  });

  it('refuses an unaddressable message without spending a round trip', async () => {
    const mint = recordingMint();

    expect(
      await mintMessageLink(
        { id: 'pending_1', channel_id: CHANNEL },
        mint,
        'https://chat.example.com',
      ),
    ).toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });

  it('has no address at all without a configured origin — never invents a host', async () => {
    // Native has no same-origin fallback: with no `EXPO_PUBLIC_CYTALE_ORIGIN`
    // there is no server this client could point a link at, so it says so
    // rather than minting a token for a URL nobody can open.
    const mint = recordingMint();
    const previous = process.env.EXPO_PUBLIC_CYTALE_ORIGIN;
    delete process.env.EXPO_PUBLIC_CYTALE_ORIGIN;
    try {
      expect(
        await mintMessageLink({ id: MESSAGE, channel_id: CHANNEL }, mint),
      ).toBeNull();
      expect(mint).not.toHaveBeenCalled();
    } finally {
      process.env.EXPO_PUBLIC_CYTALE_ORIGIN = previous;
    }
  });

  it('rejects when the mint fails — the caller reports a failure, never a fallback', async () => {
    // No legacy URL is substituted: a link that was not minted may not resolve,
    // and the fragment spelling would publish the ids the token hides.
    const mint = jest.fn(async () => {
      throw new Error('offline');
    });

    await expect(
      mintMessageLink({ id: MESSAGE, channel_id: CHANNEL }, mint, 'https://chat.example.com'),
    ).rejects.toThrow('offline');
  });

  it('the production minter rejects with no session mounted (nothing is written)', async () => {
    // `SessionProvider` is the only thing that publishes the manager; outside
    // it there is no api client to mint through, and the sheet's failure path
    // is the honest answer.
    await expect(sessionPermalinkMinter(CHANNEL, MESSAGE)).rejects.toThrow(/no signed-in session/);
  });

  it('the session api client puts the two ids in the POST body, once', async () => {
    // The wire-level half: the api client the mobile minter calls turns those
    // two arguments into `{channel_id, message_id}` on `POST /permalinks` —
    // asserted over a stubbed transport, so the body is not inferred from the
    // seam's signature.
    const wire = installWire([
      {
        match: (url) => url.endsWith('/permalinks'),
        respond: () => ({ status: 200, body: { token: TOKEN, url: `https://c.test/m/${TOKEN}` } }),
      },
    ]);
    const manager = createSessionManager({
      storage: createMemoryTokenStorage(),
      resolveOrigin: () => 'http://127.0.0.1:4001',
      createGatewayClient: createFakeGateway,
    });

    try {
      const url = await mintMessageLink(
        { id: MESSAGE, channel_id: CHANNEL, thread_id: THREAD },
        (channelId, messageId) => manager.api.mintPermalink(channelId, messageId),
        'https://chat.example.com',
      );

      expect(url).toBe(`https://chat.example.com/m/${TOKEN}`);
      expect(wire.seen('/permalinks')).toHaveLength(1);
      expect(wire.calls[0]!.method).toBe('POST');
      expect(wire.calls[0]!.body).toEqual({ channel_id: CHANNEL, message_id: MESSAGE });
    } finally {
      wire.restore();
    }
  });
});
