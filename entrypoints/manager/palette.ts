

export const SECTION_RAIL_VARS = [
  "var(--section-coral)",
  "var(--section-amber)",
  "var(--section-lime)",
  "var(--section-teal)",
  "var(--section-sky)",
  "var(--section-indigo)",
  "var(--section-violet)",
  "var(--section-rose)",
] as const;

export function sectionRailVar(colorIndex: number | "unsorted"): string {
  if (colorIndex === "unsorted") return "var(--color-border)";
  return SECTION_RAIL_VARS[((colorIndex % SECTION_RAIL_VARS.length) + SECTION_RAIL_VARS.length) % SECTION_RAIL_VARS.length];
}

export const FACET_PALETTE = SECTION_RAIL_VARS;
