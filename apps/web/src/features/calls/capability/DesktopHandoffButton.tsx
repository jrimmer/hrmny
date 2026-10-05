/**
 * @cytale/web — the desktop handoff affordance (calls V2 plan U6; R12 +
 * KDV3 + KTD8, on U5a's VM10 CapabilityDisabledButton pattern).
 *
 * The target of a failed capability probe: a visibly-disabled-looking,
 * still-focusable button whose activation explains the gap and offers
 * exactly ONE action — "Open the web app" (`openWebApp`, KDV3: nothing
 * fancier). Render it where the probe (capability.screenshareSupport /
 * captureSupport) returned 'unavailable' — i.e. only inside the desktop
 * shell; on the web build the probes never report 'unavailable' (the web
 * app is the full client, R12).
 */

import type { ReactNode } from 'react';

import { CapabilityDisabledButton } from '../video/CapabilityDisabledButton.js';
import { DESKTOP_HANDOFF_COPY, type DesktopHandoffKind } from './copy.js';
import { openWebApp } from './handoff.js';

export interface DesktopHandoffButtonProps {
  /** Which gap is being explained — selects the copy variant. */
  kind: DesktopHandoffKind;
  /** Accessible name of the affordance ("Share your screen"). */
  label: string;
  /** The affordance's glyph (rendered aria-hidden). */
  icon: ReactNode;
  /** Stable testid suffix (the owning surface — 'panel' | 'dm' | ...). */
  context: string;
}

export function DesktopHandoffButton({
  kind,
  label,
  icon,
  context,
}: DesktopHandoffButtonProps) {
  const copy = DESKTOP_HANDOFF_COPY[kind];
  return (
    <CapabilityDisabledButton
      label={label}
      icon={icon}
      context={context}
      dialogTitle={copy.dialogTitle}
      dialogBody={copy.dialogBody}
      actionLabel={copy.actionLabel}
      onAction={() => {
        void openWebApp();
      }}
    />
  );
}
