/**
 * Keeps the in-player HUD clear of the controls YouTube paints at the top of the player,
 * such as the Shorts play/mute and captions/menu/fullscreen rows. Nothing here depends on
 * YouTube's element names: the HUD's own box is hit-tested and whatever interactive control
 * turns up underneath it is what the HUD moves below.
 */

export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export const HUD_CLEARANCE_PX = 8;
/** Lower than this share of the player the HUD would sit in the picture; keep the default spot instead. */
export const HUD_MAX_TOP_RATIO = 0.5;
/** Anything taller or wider than this is a tap-to-pause layer or the overlay itself, not a row of controls. */
const CONTROL_MAX_HEIGHT_RATIO = 0.4;
const CONTROL_MAX_WIDTH_RATIO = 0.7;
const PROBE_COLUMNS = 6;
const PROBE_ROWS = 2;
const MAX_PASSES = 3;

const NATIVE_CONTROL_SELECTOR = [
  "button",
  "a[href]",
  '[role="button"]',
  '[role="menuitem"]',
  '[role="slider"]',
  "yt-icon-button",
  "yt-button-shape",
  "yt-button-view-model",
  "button-view-model",
  "toggle-button-view-model",
  ".ytp-button",
].join(", ");

export function isControlSizedBox(box: Box, player: Box): boolean {
  if (box.width <= 0 || box.height <= 0) return false;
  return (
    box.height <= player.height * CONTROL_MAX_HEIGHT_RATIO && box.width <= player.width * CONTROL_MAX_WIDTH_RATIO
  );
}

/**
 * The HUD's top offset inside the player, in pixels, that clears every control-sized box.
 * Null when nothing control-sized is in the way, or when clearing it would push the HUD too far down.
 */
export function hudTopBelow(controls: Box[], player: Box, clearance = HUD_CLEARANCE_PX): number | null {
  let lowestBottom = -Infinity;
  for (const control of controls) {
    if (!isControlSizedBox(control, player)) continue;
    lowestBottom = Math.max(lowestBottom, control.bottom);
  }
  if (lowestBottom === -Infinity) return null;
  const top = Math.round(lowestBottom - player.top + clearance);
  return top > player.height * HUD_MAX_TOP_RATIO ? null : top;
}

export function isOnScreen(box: Box): boolean {
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.bottom > 0 &&
    box.right > 0 &&
    box.top < window.innerHeight &&
    box.left < window.innerWidth
  );
}

/** Interactive elements painted under the given area, found by hit-testing a grid of points across it. */
export function controlsUnder(area: Box, isIgnored: (element: Element) => boolean): DOMRect[] {
  const controls = new Set<Element>();
  for (let column = 0; column < PROBE_COLUMNS; column++) {
    for (let row = 0; row < PROBE_ROWS; row++) {
      const x = area.left + ((column + 0.5) / PROBE_COLUMNS) * area.width;
      const y = area.top + ((row + 0.5) / PROBE_ROWS) * area.height;
      for (const hit of document.elementsFromPoint(x, y)) {
        if (isIgnored(hit)) continue;
        const control = hit.closest(NATIVE_CONTROL_SELECTOR);
        if (control && !isIgnored(control)) controls.add(control);
      }
    }
  }
  return Array.from(controls)
    .filter((control) => getComputedStyle(control).visibility !== "hidden")
    .map((control) => control.getBoundingClientRect());
}

/**
 * Moves the HUD (absolutely positioned inside the player) down until no native control sits under it.
 * Leaves the stylesheet's position alone when the HUD is off screen, so a hidden page can't reset it.
 */
export function placeHudBelowNativeControls(
  hud: HTMLElement,
  player: HTMLElement,
  isOwnElement: (element: Element) => boolean
): void {
  const playerBox = player.getBoundingClientRect();
  if (playerBox.width === 0 || playerBox.height === 0) return;
  if (!isOnScreen(hud.getBoundingClientRect())) return;

  hud.style.top = "";
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const controls = controlsUnder(hud.getBoundingClientRect(), isOwnElement).filter((control) =>
      isControlSizedBox(control, playerBox)
    );
    if (controls.length === 0) return;
    const top = hudTopBelow(controls, playerBox);
    if (top === null) {
      hud.style.top = "";
      return;
    }
    hud.style.top = `${top}px`;
  }
}
