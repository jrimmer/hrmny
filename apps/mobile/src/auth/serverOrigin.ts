/**
 * @cytale/mobile — the login form's server-address persistence.
 *
 * The server a user signed into last is the server the NEXT launch should
 * reach (the session manager's origin override is applied from this value
 * before the persisted session restores). Stored in the same encrypted
 * secure store as the tokens — it is not secret, but it is the natural place
 * for per-install connection state.
 */
import * as SecureStore from 'expo-secure-store';

const KEY = 'hrmny.server_origin';

/**
 * The sign-in form's suggested server: the build's hosted deployment,
 * `EXPO_PUBLIC_CYTALE_HOSTED_ORIGIN` (inlined at build time; a deployment's
 * release configuration supplies it, never the source). Empty in a build that
 * names none — the user types their server.
 */
export const DEFAULT_SERVER_ORIGIN: string = (process.env.EXPO_PUBLIC_CYTALE_HOSTED_ORIGIN ?? '')
  .trim()
  .replace(/\/+$/, '');

export async function readServerOrigin(): Promise<string | null> {
  try {
    return (await SecureStore.getItemAsync(KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function writeServerOrigin(origin: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, origin);
  } catch {
    // Best effort: a failed write means the next launch falls back to the
    // default origin, not a broken session.
  }
}
