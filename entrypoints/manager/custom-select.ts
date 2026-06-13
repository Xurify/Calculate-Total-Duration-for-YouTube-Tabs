export interface CustomSelectOption {
  value: string;
  label: string;
}

export interface CustomSelectHandle {
  getValue: () => string;
  setValue: (value: string) => void;
  setOptions: (options: CustomSelectOption[]) => void;
  setHidden: (hidden: boolean) => void;
  close: () => void;
  destroy: () => void;
}

interface MountCustomSelectOptions {
  options: CustomSelectOption[];
  value?: string;
  compact?: boolean;
  block?: boolean;
  ariaLabel?: string;
  onChange?: (value: string) => void;
}

const CHECK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

const CHEVRON_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="custom-select-chevron"><path d="m6 9 6 6 6-6"/></svg>';

let openSelect: CustomSelectHandle | null = null;

export function closeAllCustomSelects(): void {
  openSelect?.close();
}

export function mountCustomSelect(
  container: HTMLElement,
  config: MountCustomSelectOptions
): CustomSelectHandle {
  container.innerHTML = "";
  container.classList.add("custom-select");
  if (config.compact) container.classList.add("custom-select--compact");
  if (config.block) container.classList.add("custom-select--block");

  let options = [...config.options];
  let value = config.value ?? options[0]?.value ?? "";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (config.ariaLabel) trigger.setAttribute("aria-label", config.ariaLabel);

  const labelEl = document.createElement("span");
  labelEl.className = "custom-select-label truncate";

  trigger.append(labelEl, createChevron());

  const menu = document.createElement("div");
  menu.className =
    "menu-panel menu-panel-animate custom-select-menu custom-scrollbar hidden absolute z-[120] min-w-full overflow-y-auto";
  menu.setAttribute("role", "listbox");

  container.append(trigger, menu);

  function labelForValue(nextValue: string): string {
    return options.find((option) => option.value === nextValue)?.label ?? nextValue;
  }

  function renderOptions(): void {
    menu.innerHTML = options
      .map((option) => {
        const selected = option.value === value;
        return `
          <button
            type="button"
            role="option"
            class="custom-select-option${selected ? " custom-select-option--selected" : ""}"
            data-value="${escapeAttr(option.value)}"
            aria-selected="${selected ? "true" : "false"}"
          >
            <span class="truncate">${escapeHtml(option.label)}</span>
            <span class="custom-select-check">${selected ? CHECK_ICON : ""}</span>
          </button>`;
      })
      .join("");
  }

  function syncTrigger(): void {
    labelEl.textContent = labelForValue(value);
    trigger.setAttribute("aria-expanded", menu.classList.contains("hidden") ? "false" : "true");
    container.classList.toggle("custom-select--open", !menu.classList.contains("hidden"));
  }

  function close(): void {
    if (menu.classList.contains("hidden")) return;
    menu.classList.add("hidden");
    syncTrigger();
    if (openSelect === handle) openSelect = null;
  }

  function open(): void {
    closeAllCustomSelects();
    menu.classList.remove("hidden");
    syncTrigger();
    openSelect = handle;
    const selected = menu.querySelector(".custom-select-option--selected") as HTMLElement | null;
    selected?.focus({ preventScroll: true });
  }

  function setValue(nextValue: string): void {
    if (!options.some((option) => option.value === nextValue)) return;
    value = nextValue;
    renderOptions();
    syncTrigger();
  }

  const handle: CustomSelectHandle = {
    getValue: () => value,
    setValue,
    setOptions(nextOptions: CustomSelectOption[]) {
      options = [...nextOptions];
      if (!options.some((option) => option.value === value)) {
        value = options[0]?.value ?? "";
      }
      renderOptions();
      syncTrigger();
    },
    setHidden(hidden: boolean) {
      container.classList.toggle("hidden", hidden);
      if (hidden) close();
    },
    close,
    destroy() {
      close();
      container.replaceChildren();
      container.classList.remove("custom-select", "custom-select--compact", "custom-select--block", "custom-select--open");
      trigger.removeEventListener("click", onTriggerClick);
      menu.removeEventListener("click", onMenuClick);
      container.removeEventListener("click", stopPropagation);
    },
  };

  function onTriggerClick(event: MouseEvent): void {
    event.stopPropagation();
    if (menu.classList.contains("hidden")) open();
    else close();
  }

  function onMenuClick(event: MouseEvent): void {
    event.stopPropagation();
    const option = (event.target as HTMLElement).closest(".custom-select-option") as HTMLElement | null;
    if (!option) return;
    const nextValue = option.getAttribute("data-value");
    if (!nextValue || nextValue === value) {
      close();
      return;
    }
    value = nextValue;
    renderOptions();
    syncTrigger();
    close();
    config.onChange?.(value);
  }

  function stopPropagation(event: MouseEvent): void {
    event.stopPropagation();
  }

  trigger.addEventListener("click", onTriggerClick);
  menu.addEventListener("click", onMenuClick);
  container.addEventListener("click", stopPropagation);

  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".custom-select-option")];
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      trigger.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = items[Math.min(currentIndex + 1, items.length - 1)] ?? items[0];
      next?.focus();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = items[Math.max(currentIndex - 1, 0)] ?? items[items.length - 1];
      next?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      (document.activeElement as HTMLElement | null)?.click();
    }
  });

  if (config.value !== undefined) value = config.value;
  renderOptions();
  syncTrigger();

  return handle;
}

function createChevron(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = CHEVRON_ICON;
  return wrap.firstElementChild as HTMLElement;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}
