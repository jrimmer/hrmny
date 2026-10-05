/**
 * @cytale/web — UserPanel, the bottom-left identity + transport panel.
 *
 * Extracted from ChannelSidebar (U20) so the shell owns its placement: it is
 * the channel sidebar's own footer — column 2's row 2 on desktop (the rail
 * column ends in the build badge instead), above the drawer footer on mobile,
 * both via the shell's `userPanel` prop. This component owns only identity +
 * presence.
 *
 * Status display (Discord-style): the ONLY self-status indicator is the
 * presence dot on the avatar's bottom-left — no separate dot+word in the
 * panel. Clicking the AVATAR opens the status picker. Transport icons
 * (mic/headset/settings) render larger, right-aligned.
 */
import { getCallEngine } from '../../features/calls/useCallMedia.js';
import { useCallEngineState } from '../../features/calls/useCall.js';
import { useSpeakingSet } from '../../features/calls/useSpeaking.js';
import { PresenceMenu, type SelfStatus } from '../../features/presence/PresenceMenu.js';
import { Avatar } from '../ui/UserAvatar.js';
import { GearIcon } from './HeaderActionsMenu.js';

export interface UserPanelUser {
  name: string;
  handle: string;
  /** Snowflake id — anchors the avatar tile's deterministic hue. */
  id?: string;
  /** Uploaded avatar (attachment path); absent → the hue tile. */
  avatarUrl?: string | null;
  /** Display status (invisible arrives here as offline — display honesty). */
  status?: 'online' | 'idle' | 'dnd' | 'offline';
}

/**
 * Optical size for the panel's transport icons. 17 is the value the gear was
 * already tuned to — it has to read level with the 🎧 character beside it,
 * which renders larger than its 16px font-size (see GearIcon's note) — so the
 * mic joins them at the same size rather than the 14px it shipped with, which
 * read a size smaller than both (owner report 2026-09-15).
 */
const PANEL_ICON_SIZE = 17;

export function UserPanel({
  user,
  selfStatus = 'online',
  onSelfStatus,
  settingsOpen = false,
  onToggleSettings,
}: {
  user: UserPanelUser;
  selfStatus?: SelfStatus;
  onSelfStatus?: (status: SelfStatus) => void;
  /** True while the settings surface owns columns 2+3 (gear = the toggle). */
  settingsOpen?: boolean;
  onToggleSettings?: () => void;
}) {
  return (
    <div className="user-panel" data-testid="user-panel">
      <PresenceMenu
        status={selfStatus}
        onSelect={(s) => onSelfStatus?.(s)}
        renderTrigger={({ ref, open, toggle }) => (
          <button
            type="button"
            ref={ref}
            className="user-panel-avatar-trigger"
            aria-haspopup="menu"
            aria-expanded={open || undefined}
            aria-label="Set status"
            title="Set status"
            data-testid="user-panel-status-trigger"
            onClick={toggle}
          >
            <Avatar
              id={user.id ?? user.name}
              name={user.name}
              src={user.avatarUrl}
              className="user-panel-avatar"
              data-presence={user.status ?? 'offline'}
            />
          </button>
        )}
      />
      <span className="user-panel-identity">
        <span className="user-panel-name">{user.name}</span>
        <span className="user-panel-handle">{user.handle}</span>
      </span>
      <span className="user-panel-actions">
        <UserPanelMicStatus userId={user.id} />
        <span className="user-panel-action" aria-hidden="true">🎧</span>
        {/* The gear is the settings surface's toggle (in-call transport owns
            mic/headset; the mic slot is the live hearing-you indicator
            above, the headset remains display parity for now). Drawn from the
            shared header gear path rather than the `⚙` character — see
            GearIcon's note: the text-presentation dingbat read a third smaller
            than the 🎧 beside it and never took the hover tint. */}
        <button
          type="button"
          className="user-panel-action user-panel-action-btn"
          aria-label="User settings"
          aria-expanded={settingsOpen || undefined}
          title="User settings"
          data-testid="user-settings-toggle"
          // The mobile drawer closes on this entry (AppShell checks the attribute).
          data-drawer-close={true}
          data-active={settingsOpen || undefined}
          onClick={onToggleSettings}
        >
          <GearIcon size={PANEL_ICON_SIZE} />
        </button>
      </span>
    </div>
  );
}

/**
 * Mic status (user-directed 2026-09-07, Discord/Teams parity): the
 * bottom-left identity block answers "is Hrmny hearing me?" — green while
 * the live mic is actually picking you up. Level-driven off the AM5
 * monitor attached to the LOCAL stream (engine self-attach), so mute reads
 * honestly as not-heard: a disabled track renders silence in the WebAudio
 * graph. Phase 1: solid states; the wave-fill animation can ride
 * data-hearing later without markup changes.
 */
function UserPanelMicStatus({ userId }: { userId?: string }) {
  const engine = getCallEngine();
  const snapshot = useCallEngineState(engine);
  const speaking = useSpeakingSet(engine.speakingSubscribe, engine.getSpeaking);
  const inCall =
    snapshot.channelId !== null &&
    snapshot.voice.status !== 'idle' &&
    snapshot.voice.status !== 'offline';
  const muted = inCall && snapshot.muted;
  const hearing = inCall && !muted && userId !== undefined && speaking.has(userId);
  const label = !inCall
    ? 'Microphone inactive'
    : muted
      ? 'Microphone muted'
      : hearing
        ? 'Hrmny is hearing you'
        : 'Microphone live';
  return (
    <span
      className="user-panel-action"
      data-testid="user-panel-mic"
      data-in-call={inCall || undefined}
      data-muted={muted || undefined}
      data-hearing={hearing || undefined}
      role="img"
      aria-label={label}
      title={label}
    >
      <MicStatusIcon slashed={muted} />
    </span>
  );
}

function MicStatusIcon({ slashed, size = PANEL_ICON_SIZE }: { slashed?: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v5.5A3.5 3.5 0 0 0 12 15z"
        fill="currentColor"
      />
      <path
        d="M18.5 11.5a.9.9 0 0 0-1.8 0 4.7 4.7 0 0 1-9.4 0 .9.9 0 0 0-1.8 0 6.5 6.5 0 0 0 5.6 6.4V20H8.9a.9.9 0 0 0 0 1.8h6.2a.9.9 0 0 0 0-1.8h-2.2v-2.1a6.5 6.5 0 0 0 5.6-6.4z"
        fill="currentColor"
      />
      {slashed ? (
        <path
          d="M4.2 4.2 19.8 19.8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}
