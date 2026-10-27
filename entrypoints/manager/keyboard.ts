import { closeAllCustomSelects } from "./custom-select";
import { handlePracticeKeydown } from "./practice";
import { app } from "./state";
import { hasAnyFacet, toggleFacet } from "./facets";
import { selectedSessionTabUrls, selectedTabIds } from "./state";

function queueRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("#tab-list [data-id], #tab-list [data-session-tab-url]"));
}

function rowKey(row: HTMLElement): string {
  return row.dataset.id ?? row.dataset.sessionTabUrl ?? "";
}

export function applyRowFocus(): void {
  const rows = queueRows();
  let found = false;
  for (const row of rows) {
    const on = app.focusedRowKey != null && rowKey(row) === app.focusedRowKey;
    row.classList.toggle("queue-row--focused", on);
    if (on) found = true;
  }
  if (!found) app.focusedRowKey = null;
}

function moveRowFocus(delta: number): void {
  const rows = queueRows();
  if (rows.length === 0) return;
  const index = rows.findIndex((row) => rowKey(row) === app.focusedRowKey);
  const next = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + delta));
  app.focusedRowKey = rowKey(rows[next]);
  applyRowFocus();
  rows[next].scrollIntoView({ block: "nearest" });
}

function focusedRow(): HTMLElement | null {
  return queueRows().find((row) => rowKey(row) === app.focusedRowKey) ?? null;
}

function keyboardTargetIsTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function anyDialogOpen(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], #settings-modal, #language-modal')).some(
    (element) => !element.classList.contains("hidden")
  );
}

const BROWSER_COMMAND_LABELS: Record<string, string> = {
  _execute_action: "Open the popup",
  "open-desk": "Open the desk",
};

async function renderBrowserShortcuts(): Promise<void> {
  const list = document.getElementById("shortcuts-browser");
  if (!list) return;
  const commands = await browser.commands.getAll().catch(() => []);
  list.replaceChildren(
    ...commands
      .filter((command) => command.name && BROWSER_COMMAND_LABELS[command.name])
      .map((command) => {
        const row = document.createElement("div");
        row.className = "shortcut-row";
        const label = document.createElement("dt");
        label.textContent = BROWSER_COMMAND_LABELS[command.name!];
        const keys = document.createElement("dd");
        if (command.shortcut) {
          const key = document.createElement("kbd");
          key.textContent = command.shortcut;
          keys.append(key);
        } else {
          keys.textContent = "Not set";
          keys.className = "text-text-muted";
        }
        row.append(label, keys);
        return row;
      })
  );
}

function openShortcutsDialog(): void {
  const dialog = document.getElementById("shortcuts-modal");
  if (!dialog) return;
  void renderBrowserShortcuts();
  dialog.classList.remove("hidden");
  dialog.classList.add("flex");
}

function closeShortcutsDialog(): void {
  const dialog = document.getElementById("shortcuts-modal");
  dialog?.classList.add("hidden");
  dialog?.classList.remove("flex");
}

function clickIfShown(id: string): void {
  const element = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | null;
  if (!element || element.disabled || element.offsetParent === null) return;
  element.click();
}

function undoFromToast(): boolean {
  const undo = document.querySelector<HTMLButtonElement>("#toast:not(.hidden):not(.opacity-0) .toast-action");
  if (!undo) return false;
  undo.click();
  return true;
}

const VIEW_SHORTCUTS: Record<string, string> = { "1": "nav-desk", "2": "nav-sessions", "3": "nav-reading-list", "4": "nav-time", "5": "nav-practice" };

export function handleDeskKeydown(event: KeyboardEvent): void {
  if (anyDialogOpen()) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z") {
    if (!keyboardTargetIsTyping(event) && undoFromToast()) event.preventDefault();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const onCheckbox = event.target instanceof HTMLInputElement && event.target.type === "checkbox";
  if (keyboardTargetIsTyping(event) && !(onCheckbox && event.key === "Escape")) {
    if (event.key !== "Escape") return;
    const target = event.target as HTMLInputElement;
    if (target.id === "search-input" && target.value !== "") document.getElementById("search-clear-btn")?.click();
    else target.blur();
    return;
  }
  if (VIEW_SHORTCUTS[event.key]) {
    event.preventDefault();
    clickIfShown(VIEW_SHORTCUTS[event.key]);
    return;
  }
  if (app.isPracticeView) {
    if (handlePracticeKeydown(event)) {
      event.preventDefault();
      return;
    }
    // Desk shortcuts act on video rows, which this page has none of; help and undo still apply.
    if (event.key !== "?" && event.key !== "z") return;
  }
  switch (event.key) {
    case "?":
      event.preventDefault();
      openShortcutsDialog();
      return;
    case "z":
      if (undoFromToast()) event.preventDefault();
      return;
    case "s":
      event.preventDefault();
      clickIfShown("btn-save-session");
      return;
    case "p":
      event.preventDefault();
      clickIfShown("btn-start-plan");
      return;
    case "v": {
      event.preventDefault();
      clickIfShown(app.layoutMode === "grid" ? "layout-list" : "layout-grid");
      return;
    }
    case "a":
      event.preventDefault();
      clickIfShown("select-all-checkbox");
      return;
    case "/": {
      event.preventDefault();
      const search = document.getElementById("search-input") as HTMLInputElement | null;
      search?.focus();
      search?.select();
      return;
    }
    case "j":
    case "ArrowDown":
      event.preventDefault();
      moveRowFocus(1);
      return;
    case "k":
    case "ArrowUp":
      event.preventDefault();
      moveRowFocus(-1);
      return;
    case "Enter": {
      const row = focusedRow();
      (row?.querySelector(".jump-btn, .session-open-new-tab") as HTMLElement | null)?.click();
      return;
    }
    case "x": {
      const row = focusedRow();
      if (!row) return;
      const next = queueRows();
      const index = next.indexOf(row);
      const neighbour = next[index + 1] ?? next[index - 1] ?? null;
      app.focusedRowKey = neighbour ? rowKey(neighbour) : null;
      (row.querySelector(".close-btn, .session-remove-btn") as HTMLElement | null)?.click();
      return;
    }
    case " ": {
      const row = focusedRow();
      if (!row) return;
      event.preventDefault();
      (row.querySelector(".selection-toggle input, .session-selection-toggle input") as HTMLElement | null)?.click();
      return;
    }
    case "Escape":
      if (app.focusedRowKey) {
        app.focusedRowKey = null;
        applyRowFocus();
      } else if (selectedTabIds.size > 0 || selectedSessionTabUrls.size > 0) {
        document.getElementById("btn-clear-selection")?.click();
      } else if (hasAnyFacet()) {
        toggleFacet("all");
      }
      return;
  }
}

export function wireShortcutsDialog() {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeAllCustomSelects();
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
    document.getElementById("move-to-section-popover")?.classList.add("hidden");
  });

  document.getElementById("shortcuts-close")?.addEventListener("click", closeShortcutsDialog);
  document.getElementById("shortcuts-modal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeShortcutsDialog();
  });
  document.getElementById("settings-open-shortcuts")?.addEventListener("click", openShortcutsDialog);
  document.getElementById("shortcuts-change-browser")?.addEventListener("click", () => {
    void browser.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
}
