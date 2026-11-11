import "./variants.css";

const VARIANTS = [
  { id: "split", label: "Split cards" },
  { id: "band", label: "One band" },
  { id: "headline", label: "Headline" },
] as const;

type VariantId = (typeof VARIANTS)[number]["id"];

function activeVariant(): VariantId {
  const requested = new URLSearchParams(location.search).get("__variant");
  return VARIANTS.find((variant) => variant.id === requested)?.id ?? "split";
}

function setVariant(id: VariantId): void {
  document.documentElement.dataset.variant = id;
  const url = new URL(location.href);
  url.searchParams.set("__variant", id);
  history.replaceState(null, "", url);
  for (const button of document.querySelectorAll<HTMLButtonElement>(".variant-picker button")) {
    button.setAttribute("aria-pressed", String(button.dataset.variant === id));
  }
}

export function mountVariantPicker(): void {
  const picker = document.createElement("nav");
  picker.className = "variant-picker";
  picker.setAttribute("aria-label", "Variants");
  picker.innerHTML = `<div role="group" aria-labelledby="variants-structure">
    <span class="variant-picker-heading" id="variants-structure">
      <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v4a3 3 0 0 0 3 3h7" /><path d="m10 7 3 3-3 3" /></svg>
      Structure
    </span>
    ${VARIANTS.map((variant) => `<button type="button" data-variant="${variant.id}" aria-pressed="false">${variant.label}</button>`).join("")}
  </div>`;
  document.body.appendChild(picker);
  picker.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-variant]");
    if (button) setVariant(button.dataset.variant as VariantId);
  });
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;
    if (event.key === "h" || event.key === "H") {
      picker.hidden = !picker.hidden;
      return;
    }
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const index = VARIANTS.findIndex((variant) => variant.id === activeVariant());
    setVariant(VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length].id);
    event.preventDefault();
  });
  setVariant(activeVariant());
}
