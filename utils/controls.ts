import { formatDurationInput, MAX_LIMIT_MINUTES, parseDurationMinutes, stepDurationMinutes } from "./languageLimits";

const TOOLTIP_DELAY_MS = 350;
const TOOLTIP_GAP = 8;

/**
 * Replaces the browser's title tooltips page-wide: a title is moved to data-tip the first time it is pointed at,
 * so markup keeps using plain title attributes. Icon-only buttons keep the text as their accessible name.
 */
export function installTooltips(root: Document = document): void {
  const tip = root.createElement("div");
  tip.className = "ui-tooltip";
  tip.setAttribute("role", "tooltip");
  let target: HTMLElement | null = null;
  let timer: number | null = null;

  const hide = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    target = null;
    tip.classList.remove("ui-tooltip--shown");
    tip.remove();
  };

  const place = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const left = Math.min(Math.max(TOOLTIP_GAP, rect.left + rect.width / 2 - box.width / 2), window.innerWidth - box.width - TOOLTIP_GAP);
    const above = rect.top - box.height - TOOLTIP_GAP;
    const top = above >= TOOLTIP_GAP ? above : rect.bottom + TOOLTIP_GAP;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  };

  const adopt = (element: HTMLElement): string | null => {
    const title = element.getAttribute("title");
    if (title) {
      element.dataset.tip = title;
      element.removeAttribute("title");
      if (!element.hasAttribute("aria-label") && !element.textContent?.trim()) element.setAttribute("aria-label", title);
    }
    return element.dataset.tip || null;
  };

  const show = (element: HTMLElement) => {
    const text = adopt(element);
    if (!text || element === target) return;
    hide();
    target = element;
    timer = window.setTimeout(() => {
      if (target !== element || !element.isConnected) return;
      tip.textContent = element.dataset.tip ?? text;
      root.body.appendChild(tip);
      place(element);
      requestAnimationFrame(() => tip.classList.add("ui-tooltip--shown"));
    }, TOOLTIP_DELAY_MS);
  };

  const tipOwner = (node: EventTarget | null) => (node instanceof Element ? node.closest<HTMLElement>("[title], [data-tip]") : null);

  root.addEventListener("pointerover", (event) => {
    const owner = tipOwner(event.target);
    if (owner) show(owner);
    else if (target) hide();
  });
  root.addEventListener("pointerout", (event) => {
    if (target && !target.contains(event.relatedTarget as Node | null)) hide();
  });
  root.addEventListener("focusin", (event) => {
    const owner = tipOwner(event.target);
    if (owner && (event.target as Element).matches(":focus-visible")) show(owner);
  });
  root.addEventListener("focusout", hide);
  root.addEventListener("pointerdown", hide, true);
  root.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape") hide();
  });
  window.addEventListener("scroll", hide, true);
}

export interface StepperOptions {
  value?: number | null;
  min: number;
  max: number;
  step?: number;
  name?: string;
  className?: string;
  attributes?: Record<string, string>;
  ariaLabel: string;
  placeholder?: string;
  suffix?: string;
  required?: boolean;
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const MINUS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>`;
const PLUS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;

export function stepperHtml(options: StepperOptions): string {
  const attributes = Object.entries(options.attributes ?? {})
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");
  return `<span class="ui-stepper">
    <button type="button" class="ui-stepper-btn" data-stepper="-1" tabindex="-1" aria-label="Less">${MINUS_ICON}</button>
    <input type="number" inputmode="numeric" class="${escapeAttribute(options.className ?? "")}"${options.name ? ` name="${escapeAttribute(options.name)}"` : ""} min="${options.min}" max="${options.max}" step="${options.step ?? 1}"${options.value != null ? ` value="${options.value}"` : ""}${options.placeholder ? ` placeholder="${escapeAttribute(options.placeholder)}"` : ""}${options.required ? " required" : ""} aria-label="${escapeAttribute(options.ariaLabel)}"${attributes} />
    ${options.suffix ? `<span class="ui-stepper-suffix">${escapeAttribute(options.suffix)}</span>` : ""}
    <button type="button" class="ui-stepper-btn" data-stepper="1" tabindex="-1" aria-label="More">${PLUS_ICON}</button>
  </span>`;
}

export interface DurationFieldOptions {
  minutes?: number | null;
  name?: string;
  className?: string;
  attributes?: Record<string, string>;
  ariaLabel: string;
  suffix?: string;
  required?: boolean;
}

/** A stepper that takes "3 h" or "1:30" as well as minutes; read it back with parseDurationMinutes. */
export function durationFieldHtml(options: DurationFieldOptions): string {
  const attributes = Object.entries(options.attributes ?? {})
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");
  const value = options.minutes != null ? formatDurationInput(options.minutes) : "";
  return `<span class="ui-stepper ui-stepper--duration">
    <button type="button" class="ui-stepper-btn" data-stepper="-1" tabindex="-1" aria-label="Less">${MINUS_ICON}</button>
    <input type="text" inputmode="text" autocomplete="off" spellcheck="false" class="duration-input ${escapeAttribute(options.className ?? "")}"${options.name ? ` name="${escapeAttribute(options.name)}"` : ""} value="${escapeAttribute(value)}" placeholder="30 min"${options.required ? " required" : ""} aria-label="${escapeAttribute(options.ariaLabel)}" title="Type 45 min, 3 h or 1:30"${attributes} />
    ${options.suffix ? `<span class="ui-stepper-suffix">${escapeAttribute(options.suffix)}</span>` : ""}
    <button type="button" class="ui-stepper-btn" data-stepper="1" tabindex="-1" aria-label="More">${PLUS_ICON}</button>
  </span>`;
}

function checkDuration(input: HTMLInputElement): number | null {
  const minutes = parseDurationMinutes(input.value);
  const valid = minutes !== null && minutes >= 1 && minutes <= MAX_LIMIT_MINUTES;
  input.setCustomValidity(input.value.trim() === "" || valid ? "" : "Type a time from 1 min to 24 h, like 45 min, 3 h or 1:30.");
  return valid ? minutes : null;
}

/** One delegated listener for every stepper under `root`; a press fires the same events as typing. */
export function wireSteppers(root: HTMLElement): void {
  root.addEventListener("input", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.classList.contains("duration-input")) checkDuration(input);
  });
  root.addEventListener(
    "change",
    (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.classList.contains("duration-input")) return;
      const minutes = checkDuration(input);
      if (minutes !== null) input.value = formatDurationInput(minutes);
    },
    true
  );
  root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-stepper]");
    const duration = button?.closest(".ui-stepper")?.querySelector<HTMLInputElement>("input.duration-input");
    if (button && duration) {
      event.preventDefault();
      const current = parseDurationMinutes(duration.value);
      duration.value = formatDurationInput(current === null ? 30 : stepDurationMinutes(current, button.dataset.stepper === "1" ? 1 : -1));
      duration.setCustomValidity("");
      duration.dispatchEvent(new Event("input", { bubbles: true }));
      duration.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const input = button?.closest(".ui-stepper")?.querySelector<HTMLInputElement>("input[type=number]");
    if (!button || !input) return;
    event.preventDefault();
    const step = Number(input.step) || 1;
    const min = input.min === "" ? -Infinity : Number(input.min);
    const max = input.max === "" ? Infinity : Number(input.max);
    let next: number;
    if (input.value === "") {
      next = Number.isFinite(min) ? min : 0;
    } else {
      const current = Number(input.value);
      // Steps snap to the step grid, so 47 goes to 50 with a step of 5 rather than to 52.
      next = button.dataset.stepper === "1" ? Math.floor(current / step) * step + step : Math.ceil(current / step) * step - step;
    }
    input.value = String(Math.min(max, Math.max(min, next)));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function wireCombobox(input: HTMLInputElement, suggestions: () => string[]): void {
  const box = input.closest<HTMLElement>(".ui-combobox") ?? input.parentElement!;
  const menu = document.createElement("div");
  menu.className = "menu-panel menu-panel-animate ui-combobox-menu custom-scrollbar hidden";
  menu.setAttribute("role", "listbox");
  menu.id = `${input.id || input.name || "combobox"}-options`;
  box.appendChild(menu);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", menu.id);
  input.setAttribute("aria-expanded", "false");
  input.autocomplete = "off";
  let active = -1;

  const matches = () => {
    const query = input.value.trim().toLowerCase();
    return suggestions().filter((option) => option.toLowerCase().includes(query) && option.toLowerCase() !== query);
  };

  const close = () => {
    menu.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };

  const render = () => {
    const options = matches();
    if (options.length === 0) {
      close();
      return;
    }
    active = Math.min(active, options.length - 1);
    menu.innerHTML = options
      .map(
        (option, index) =>
          `<button type="button" role="option" tabindex="-1" class="custom-select-option${index === active ? " bg-surface-hover" : ""}" aria-selected="${index === active}" data-value="${escapeAttribute(option)}"><span class="truncate">${escapeAttribute(option)}</span></button>`
      )
      .join("");
    menu.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  };

  const choose = (value: string) => {
    input.value = value;
    close();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  input.addEventListener("focus", render);
  input.addEventListener("input", () => {
    active = -1;
    render();
  });
  input.addEventListener("blur", () => window.setTimeout(close, 120));
  input.addEventListener("keydown", (event) => {
    const options = matches();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      active = event.key === "ArrowDown" ? (active + 1) % options.length : (active - 1 + options.length) % options.length;
      render();
    } else if (event.key === "Enter" && active >= 0 && !menu.classList.contains("hidden")) {
      event.preventDefault();
      choose(options[active]);
    } else if (event.key === "Escape" && !menu.classList.contains("hidden")) {
      event.stopPropagation();
      close();
    }
  });
  menu.addEventListener("pointerdown", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => {
    const option = (event.target as Element).closest<HTMLElement>("[data-value]");
    if (option?.dataset.value) choose(option.dataset.value);
  });
}

export function syncRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  input.style.setProperty("--range-fill", `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isShown(element: HTMLElement): boolean {
  return !element.classList.contains("hidden") && element.getClientRects().length > 0;
}

function focusableIn(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.getClientRects().length > 0);
}

/**
 * Gives every [role="dialog"] the same keyboard contract, however it is opened or closed: focus moves in when it
 * appears, Tab stays inside, Escape presses its [data-dialog-cancel] control, and focus returns to the opener.
 */
export function installDialogs(root: Document = document): void {
  const openers = new WeakMap<HTMLElement, HTMLElement>();
  const open = new Set<HTMLElement>();

  const topmost = (): HTMLElement | null => {
    const shown = Array.from(open).filter(isShown);
    return shown.sort((first, second) => Number(getComputedStyle(second).zIndex) - Number(getComputedStyle(first).zIndex))[0] ?? null;
  };

  const sync = (dialog: HTMLElement) => {
    const shown = isShown(dialog);
    if (shown && !open.has(dialog)) {
      open.add(dialog);
      const active = root.activeElement;
      if (active instanceof HTMLElement && !dialog.contains(active)) openers.set(dialog, active);
      requestAnimationFrame(() => {
        if (!isShown(dialog) || dialog.contains(root.activeElement)) return;
        const preferred = dialog.querySelector<HTMLElement>("[data-dialog-focus]");
        (preferred && preferred.getClientRects().length > 0 ? preferred : focusableIn(dialog)[0])?.focus();
      });
    } else if (!shown && open.has(dialog)) {
      open.delete(dialog);
      const opener = openers.get(dialog);
      openers.delete(dialog);
      const focusLost = root.activeElement === root.body || dialog.contains(root.activeElement);
      if (opener?.isConnected && focusLost) opener.focus();
    }
  };

  const watch = (dialog: HTMLElement) => {
    new MutationObserver(() => sync(dialog)).observe(dialog, { attributes: true, attributeFilter: ["class", "hidden", "style"] });
    sync(dialog);
  };
  root.querySelectorAll<HTMLElement>('[role="dialog"]').forEach(watch);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches('[role="dialog"]')) watch(node);
        node.querySelectorAll<HTMLElement>('[role="dialog"]').forEach(watch);
      });
    }
  }).observe(root.body, { childList: true, subtree: true });

  root.addEventListener("keydown", (event) => {
    const dialog = topmost();
    if (!dialog) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      // An open listbox inside the dialog takes the first Escape.
      if (dialog.querySelector('[aria-expanded="true"]')) return;
      const cancel = dialog.querySelector<HTMLElement>("[data-dialog-cancel]");
      if (!cancel) return;
      event.preventDefault();
      cancel.click();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusableIn(dialog);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = root.activeElement;
    if (!dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
