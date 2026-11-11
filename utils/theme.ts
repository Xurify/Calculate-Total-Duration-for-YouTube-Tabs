import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/instrument-sans/wght.css";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "theme-preference";

const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

function isThemePreference(value: string | null): value is ThemePreference {
  return value !== null && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function applyThemePreference(preference: ThemePreference): void {
  if (preference === "system") {
    delete document.documentElement.dataset.theme;
    return;
  }
  document.documentElement.dataset.theme = preference;
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable in locked-down profiles; the choice still applies for this session.
  }
  applyThemePreference(preference);
}

export function initTheme(): void {
  applyThemePreference(getThemePreference());
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY) applyThemePreference(getThemePreference());
  });
}

function syncThemeControl(root: HTMLElement): void {
  const activePreference = getThemePreference();
  root.querySelectorAll<HTMLButtonElement>("[data-theme-option]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeOption === activePreference));
  });
}

export function mountThemeControl(root: HTMLElement): void {
  syncThemeControl(root);
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-theme-option]");
    const preference = button?.dataset.themeOption ?? null;
    if (!isThemePreference(preference)) return;
    setThemePreference(preference);
    syncThemeControl(root);
  });
}

export const THEME_CONTROL_HTML = `
  <div class="inline-flex gap-0.5 rounded-lg border border-border bg-surface p-0.5" role="group" aria-label="Appearance" data-theme-control>
    <button type="button" class="theme-option" data-theme-option="system" aria-pressed="false">System</button>
    <button type="button" class="theme-option" data-theme-option="light" aria-pressed="false">Light</button>
    <button type="button" class="theme-option" data-theme-option="dark" aria-pressed="false">Dark</button>
  </div>
`;
