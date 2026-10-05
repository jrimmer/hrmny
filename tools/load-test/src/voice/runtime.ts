/**
 * U13 — the real voice seam: REST provisioning + Elixir sidecar + signaling
 * clients on the production gateway client. Wired by the CLI for voice-*
 * scenarios; unit tests inject fakes instead.
 */

import { provisionVoiceRoom } from './provision.js';
import { SidecarDriver } from './sidecar.js';
import { RawResumeProber } from './raw_resume_prober.js';
import { VirtualVoiceClient } from './virtual_voice_client.js';
import type { ProvisionedVoiceRoom, RawResumeProberLike, SidecarHandle, SidecarRequest, VoiceClientHandle, VoiceSeam } from './types.js';

export interface RuntimeSeamOptions {
  /** REST API base (e.g. http://127.0.0.1:4100/api/v1). */
  apiBaseUrl: string;
  /** Gateway WebSocket URL (e.g. ws://127.0.0.1:4100/gateway/websocket). */
  gatewayUrl: string;
  /** Parsed gateway host/port/path for the sidecar's raw WS client. */
  gatewayHost: string;
  gatewayPort: number;
  gatewayPath: string;
  /** Sidecar driver (default: the repo's tools/load-test/voice-sidecar). */
  sidecar?: SidecarDriver;
}

/** Build the real VoiceSeam the CLI passes to voice-* scenarios. */
export function realVoiceSeam(options: RuntimeSeamOptions): VoiceSeam {
  const sidecar = options.sidecar ?? new SidecarDriver();

  return {
    provision: (request) =>
      provisionVoiceRoom({
        apiBaseUrl: options.apiBaseUrl,
        userCount: request.userCount,
        label: request.label,
      }),

    startSidecar: (request: SidecarRequest): Promise<SidecarHandle> =>
      sidecar.start({
        ...request,
        host: options.gatewayHost,
        port: options.gatewayPort,
        path: options.gatewayPath,
      }),

    createClient: (token: string, label: string): VoiceClientHandle => {
      const client = new VirtualVoiceClient({
        url: options.gatewayUrl,
        token,
        label,
      });
      return client as VirtualVoiceClient & VoiceClientHandle;
    },

    createProber: (token: string): RawResumeProber => new RawResumeProber(options.gatewayUrl, token),
  };
}

/** Parse ws://host:port/path into the sidecar's connect triple. */
export function parseGatewayUrl(url: string): { host: string; port: number; path: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 80 : Number(parsed.port),
    path: parsed.pathname || '/gateway/websocket',
  };
}

export type { ProvisionedVoiceRoom };
