/**
 * @cytale/web — the self-view surface (calls V2 plan U5, VM15).
 *
 * RATIFIED VM15: self-view is mirrored — the ONLY mirrored surface (remote
 * video and the stage never are) — and it renders as a grid tile while the
 * grid is shown, DEMOTING to a corner overlay when the stage dominates
 * (VM16). The variant is the parent's call; both live here:
 *
 *   variant='tile'    → a full grid member (same Tile the grid renders,
 *                       always mirrored, name "You")
 *   variant='overlay' → the compact corner surface pinned over the stage
 *                       (.self-view-overlay — the composition positions the
 *                       anchor inside the stage's surface)
 *
 * All tile states (loading skeleton, camera-off avatar, freeze hint,
 * speaking indicator) come from Tile — SelfView adds only the mirroring
 * invariant and the two geometries. Enter/Space activate enlarge (VM21).
 */

import { Tile, type TileVideoState } from './Tile.js';

export interface SelfViewProps {
  /** Tile state (loading | live | camera-off | connection-paused | error). */
  state: TileVideoState;
  /** The viewer's own camera stream (structural; fixtures pass fakes). */
  stream?: unknown;
  /** Current-speaker indicator (non-color pairing inside Tile). */
  speaking?: boolean;
  /** Freeze→avatar degradation hint. */
  frozen?: boolean;
  /** Geometry (VM15): grid member or stage-dominant corner overlay. */
  variant?: 'tile' | 'overlay';
  /** VM21: activation → enlarge (the parent swaps geometry/stage). */
  onEnlarge?: (userId: string) => void;
  /** The viewer's user id (defaults to the fixture id 'self'). */
  userId?: string;
}

export function SelfView({
  state,
  stream = null,
  speaking = false,
  frozen = false,
  variant = 'tile',
  onEnlarge,
  userId = 'self',
}: SelfViewProps) {
  return (
    <div
      className={variant === 'overlay' ? 'self-view-overlay' : 'self-view-tile'}
      data-testid="self-view"
      data-variant={variant}
    >
      <Tile
        userId={userId}
        name="You"
        state={state}
        stream={stream}
        speaking={speaking}
        frozen={frozen}
        mirrored
        compact={variant === 'overlay'}
        onEnlarge={onEnlarge}
      />
    </div>
  );
}
