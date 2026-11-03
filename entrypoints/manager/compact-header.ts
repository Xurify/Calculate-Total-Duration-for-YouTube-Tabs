const SCROLLING_PANELS = ["time-panel", "practice-panel", "sessions-panel"];
/** Two thresholds, so a scroll that rests near one of them doesn't make the header flicker. */
const COMPACT_AFTER = 48;
const EXPAND_BELOW = 8;
/**
 * Shrinking the header makes the panel taller. When the content only just overflows, that can pull the
 * scroll back under the threshold and expand the header again, so short pages keep the full header.
 */
const MIN_OVERFLOW = 160;

function visiblePanel(): HTMLElement | null {
  for (const id of SCROLLING_PANELS) {
    const panel = document.getElementById(id);
    if (panel && !panel.classList.contains("hidden")) return panel;
  }
  return null;
}

/** Long pages (Time, Practice, Saved sessions) fold the big title into one line once you scroll, so the content gets the room. */
export function syncCompactHeader(): void {
  const head = document.getElementById("desk-head");
  if (!head) return;
  const panel = visiblePanel();
  const compact = head.classList.contains("desk-head--compact");
  let next = false;
  if (panel && panel.scrollHeight - panel.clientHeight > MIN_OVERFLOW) {
    next = compact ? panel.scrollTop > EXPAND_BELOW : panel.scrollTop > COMPACT_AFTER;
  }
  if (next !== compact) head.classList.toggle("desk-head--compact", next);
}

export function wireCompactHeader(): void {
  for (const id of SCROLLING_PANELS) {
    document.getElementById(id)?.addEventListener("scroll", syncCompactHeader, { passive: true });
  }
}
