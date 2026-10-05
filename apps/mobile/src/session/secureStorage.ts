/**
 * @cytale/mobile — `expo-secure-store` binding for the native TokenStorage
 * (plan 004 M4, KD3).
 *
 * This is the ONLY file that imports `expo-secure-store`; the adapter logic
 * lives in `./secureTokenStorage.ts` (structural `SecureStoreLike`) so it is
 * unit-tested without the native module. The app wires `secureTokenStorage`
 * into `createSessionManager({ storage: secureTokenStorage })` (M5/M10).
 */

import * as SecureStore from 'expo-secure-store';

import type { TokenStorage } from '@cytale/session';

import { createSecureTokenStorage } from './secureTokenStorage.js';

/**
 * Keychain (iOS) / Keystore (Android) backed credential storage. Keys match
 * the web localStorage names; values are the raw tokens (SecureStore encrypts
 * at rest, so no extra envelope is needed).
 */
export const secureTokenStorage: TokenStorage = createSecureTokenStorage(SecureStore);
