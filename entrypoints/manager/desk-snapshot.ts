import { app } from "./state";
import { hasAnyFacet } from "./facets";

let deskSnapshotTimeout: ReturnType<typeof setTimeout> | null = null;

/** What public/desk-init.js paints on the next load, before any tab is read. Only the plain desk, unfiltered. */
export function saveDeskSnapshot(): void {
  document.documentElement.classList.remove("desk-snapshot", "desk-loading");
  if (hasAnyFacet() || app.currentWindowId !== "all" || app.searchQuery) return;
  if (deskSnapshotTimeout != null) clearTimeout(deskSnapshotTimeout);
  deskSnapshotTimeout = setTimeout(writeDeskSnapshot, 1500);
}

function writeDeskSnapshot(): void {
  deskSnapshotTimeout = null;
  if (hasAnyFacet() || app.currentWindowId !== "all" || app.searchQuery || app.selectedSession || app.isReadingListView || app.isSessionsView || app.isTimeView || app.isPracticeView) return;
  const html = (id: string) => document.getElementById(id)?.innerHTML ?? "";
  const text = (id: string) => document.getElementById(id)?.textContent ?? "";
  const visible = (id: string) => !document.getElementById(id)?.classList.contains("hidden");
  try {
    localStorage.setItem(
      "desk-snapshot",
      JSON.stringify({
        v: 2,
        list: html("tab-list"),
        rail: html("facet-rail"),
        timeBar: visible("time-bar") ? html("time-bar") : "",
        timeBarRest: visible("time-bar-rest") ? html("time-bar-rest") : "",
        kicker: text("desk-kicker"),
        title: text("current-view-title"),
        timeValue: text("desk-time-value"),
        timeSuffix: text("desk-time-suffix"),
        stats: text("current-view-stats"),
        planSummary: text("plan-summary"),
        planLabel: text("btn-start-plan-label"),
        plannerVisible: visible("planner"),
      })
    );
  } catch {
    // Storage may be full or blocked; the next load just starts empty.
  }
}
