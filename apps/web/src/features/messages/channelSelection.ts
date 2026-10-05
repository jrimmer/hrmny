/**
 * @cytale/web — the default-channel gate.
 *
 * The app keeps one `activeChannelId` across two surfaces that disagree about
 * what it means. A workspace has a LIST of channels, so a selection outside
 * that list is stale and the pane should fall back to the workspace's first
 * text channel. Home has no list — a DM belongs to no workspace — so a DM
 * selection is not "outside" anything; it is simply the only channel Home can
 * show.
 *
 * Conflating the two is what made selecting a DM on Home render the DASHBOARD:
 * `activeWorkspaceId` is still whatever workspace was last open, so the
 * fallback ran, found the DM in no workspace list, and replaced it with that
 * workspace's first channel one render after the click (owner report
 * 2026-09-14: "click on an existing one col 3 should change to the usual
 * message interface … no new concepts here").
 *
 * Extracted as a pure predicate because the first attempt at the fix got the
 * exemption one level too broad — it kept a DM selected while a WORKSPACE took
 * over, putting a DM in the workspace's pane. The cases are table-tested in
 * channelSelection.test.ts so the next edit has to be deliberate.
 */

export interface ChannelSelectionInput {
  /** The current selection, or null when nothing is selected. */
  activeChannelId: string | null;
  /** The ACTIVE workspace's channel ids, categories already filtered out. */
  workspaceChannelIds: readonly string[];
  /** A channel the page's own hash addresses (#114), which outranks the default. */
  hashPinned: string | null;
  /** True while Home owns the pane — the only surface where a DM is selectable. */
  homeActive: boolean;
  /** The selected channel's type, when the store knows it. */
  selectedType: 'text' | 'category' | 'dm' | undefined;
}

/**
 * Whether the pane should fall back to the workspace's first text channel.
 *
 * True when nothing is selected, and when the selection is a workspace channel
 * that the active workspace no longer lists (deleted, or access revoked).
 */
export function shouldDefaultChannel(input: ChannelSelectionInput): boolean {
  const { activeChannelId, workspaceChannelIds, hashPinned, homeActive, selectedType } = input;

  // Home owns a DM selection: no workspace list applies to it.
  if (homeActive && activeChannelId != null && selectedType === 'dm') return false;

  if (activeChannelId == null) return true;
  if (activeChannelId === hashPinned) return false;
  return !workspaceChannelIds.includes(activeChannelId);
}
