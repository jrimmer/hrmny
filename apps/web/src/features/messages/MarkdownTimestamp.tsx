/**
 * @cytale/web — a `<t:UNIX:STYLE>` timestamp in a message body.
 *
 * Renders in the reader's locale and time zone, with the full date and time
 * on hover (Discord's tooltip). The `R` style keeps counting — "in 5
 * minutes", "in 4 minutes", … "in 30 seconds", "5 minutes ago" — on a timer
 * that ticks only as often as its label can change (every second within the
 * hour, see `relativeRefreshMs`).
 *
 * Not a live region: a countdown announcing itself every second would drown
 * a screen reader. The label is read when the reader reaches it, and the
 * `<time dateTime>` carries the instant for any tool that wants it.
 */

import { useEffect, useState } from 'react';

import { formatTimestamp, relativeRefreshMs, type TimestampNode } from '@cytale/markdown';

export function MarkdownTimestamp({ node }: { node: TimestampNode }) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = node.style === 'R';

  useEffect(() => {
    if (!ticking) return undefined;
    const id = setTimeout(() => setNow(Date.now()), relativeRefreshMs(node.unix, now));
    return () => clearTimeout(id);
  }, [ticking, node.unix, now]);

  const date = new Date(node.unix * 1000);
  return (
    <time className="md-timestamp" dateTime={date.toISOString()} title={formatTimestamp(node.unix, 'F')}>
      {formatTimestamp(node.unix, node.style, { now })}
    </time>
  );
}
