import { loadCachedMandalaSummary, type CachedMandalaSummary } from "../../utils/storage";
import { hostOf, isTrackableUrl, pagePrefixOf, pillarColor, type SiteRule } from "../../utils/timeLog";
import {
  actionSelectOptions,
  escapeHtml as escapeText,
  matchWords,
  pillarChoices,
  pillarSelectOptions,
  type CurrentSiteResponse,
} from "../../utils/timeUi";
import { mountCustomSelect } from "../manager/custom-select";

let sitePickerOpen = false;
let pickedPillarIndex: number | null = null;
let pickedActionId: string | null = null;
let pickedScope: "host" | "prefix" | null = null;
let siteBlockTab: Browser.tabs.Tab | null = null;
let siteBlockSummary: CachedMandalaSummary | null = null;
let siteBlockStatus: CurrentSiteResponse | null = null;

export async function loadSiteBlock(): Promise<void> {
  const block = document.getElementById("site-block");
  if (!block) return;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isTrackableUrl(tab.url)) {
      block.classList.add("hidden");
      return;
    }
    const [status, summary] = await Promise.all([
      browser.runtime.sendMessage({ action: "get-current-site", tabId: tab.id, url: tab.url }) as Promise<CurrentSiteResponse>,
      loadCachedMandalaSummary(),
    ]);
    siteBlockTab = tab;
    siteBlockSummary = summary;
    siteBlockStatus = status;
    renderSiteBlock();
  } catch {
    block.classList.add("hidden");
  }
}

function renderSiteBlock(): void {
  const block = document.getElementById("site-block");
  const tab = siteBlockTab;
  const status = siteBlockStatus;
  if (!block || !tab || !status || !isTrackableUrl(tab.url)) return;
  const host = hostOf(tab.url);
  const match = status.match;
  const swatch = match ? `<span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${pillarColor(match.pillarIndex)}"></span>` : "";
  const where = match ? matchWords(match, siteBlockSummary) : "Not counted";
  const minutes = match && status.todayMinutes > 0 ? ` · ${status.todayMinutes} min today` : "";
  const canRemove = match && match.ruleId && match.source !== "pile";
  const shownPillarIndex = pickedPillarIndex ?? match?.pillarIndex ?? pillarChoices(siteBlockSummary)[0]?.index ?? 0;

  block.classList.remove("hidden");
  block.innerHTML = `
    <div class="rounded-[10px] border border-border bg-surface-elevated px-3 py-2 flex flex-col gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <div class="flex-1 min-w-0 flex flex-col gap-0.5">
          <div class="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted truncate">This site · ${escapeText(host)}</div>
          <div class="text-[12px] text-text-primary flex items-center gap-1.5 min-w-0"><span class="truncate">${swatch} ${escapeText(where)}${escapeText(minutes)}</span></div>
        </div>
        <button type="button" id="site-pick" class="shrink-0 h-7 px-2.5 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer">${match ? "Change" : "Count for…"}</button>
      </div>
      ${
        sitePickerOpen
          ? `<div class="flex flex-col gap-1.5 pt-1 border-t border-border/60">
              ${
                siteBlockSummary
                  ? ""
                  : `<p class="m-0 text-[10px] text-text-muted">Open Mandala once so your pillars show here. Until then the rule counts for a pillar by its number.</p>`
              }
              <div class="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-[11px] text-text-secondary">
                <span>Pillar</span><div id="site-pillar"></div>
                <span>Action</span><div id="site-action"></div>
                <span>Scope</span><div id="site-scope"></div>
              </div>
              <div class="flex items-center gap-2 pt-0.5">
                <button type="button" id="site-save" class="h-7 px-3 rounded-md border-0 bg-accent text-on-accent text-[11px] font-semibold cursor-pointer hover:bg-accent-hover transition-colors">Count it</button>
                ${canRemove ? `<button type="button" id="site-remove" class="h-7 px-2.5 rounded-md border border-border bg-surface text-[11px] font-medium text-text-secondary hover:text-danger hover:border-danger/40 cursor-pointer transition-colors">Stop counting</button>` : ""}
                <span class="flex-1"></span>
                <button type="button" id="site-cancel" class="h-7 px-2 rounded-md border-0 bg-transparent text-[11px] text-text-muted hover:text-text-primary cursor-pointer">Cancel</button>
              </div>
            </div>`
          : ""
      }
    </div>
  `;

  const shownActionId = pickedActionId ?? (pickedPillarIndex === null ? (match?.actionId ?? "") : "");
  const shownScope = pickedScope ?? (match?.source === "prefix" ? "prefix" : "host");
  const pillarRoot = document.getElementById("site-pillar");
  const actionRoot = document.getElementById("site-action");
  const scopeRoot = document.getElementById("site-scope");
  if (pillarRoot && actionRoot && scopeRoot) {
    mountCustomSelect(pillarRoot, {
      options: pillarSelectOptions(siteBlockSummary),
      value: String(shownPillarIndex),
      block: true,
      size: "small",
      ariaLabel: "Pillar",
      onChange: (value) => {
        pickedPillarIndex = Number(value);
        pickedActionId = "";
        renderSiteBlock();
      },
    });
    mountCustomSelect(actionRoot, {
      options: actionSelectOptions(siteBlockSummary, shownPillarIndex),
      value: shownActionId,
      block: true,
      size: "small",
      ariaLabel: "Action",
      onChange: (value) => (pickedActionId = value),
    });
    mountCustomSelect(scopeRoot, {
      options: [
        { value: "host", label: `Whole site (${host})` },
        { value: "prefix", label: "This page and what is under it" },
      ],
      value: shownScope,
      block: true,
      size: "small",
      ariaLabel: "Scope",
      onChange: (value) => (pickedScope = value === "prefix" ? "prefix" : "host"),
    });
  }

  const resetPicks = () => {
    pickedPillarIndex = null;
    pickedActionId = null;
    pickedScope = null;
  };
  document.getElementById("site-pick")?.addEventListener("click", () => {
    sitePickerOpen = !sitePickerOpen;
    resetPicks();
    renderSiteBlock();
  });
  document.getElementById("site-cancel")?.addEventListener("click", () => {
    sitePickerOpen = false;
    resetPicks();
    renderSiteBlock();
  });
  document.getElementById("site-save")?.addEventListener("click", async () => {
    const pillarIndex = shownPillarIndex;
    const actionId = (pickedActionId ?? shownActionId) || undefined;
    const scope = pickedScope ?? shownScope;
    const pattern = scope === "host" ? host : pagePrefixOf(tab.url!);
    const rule: Omit<SiteRule, "id" | "createdAt"> & { id?: string } = {
      id: match?.ruleId && match.source === scope ? match.ruleId : undefined,
      kind: scope,
      pattern,
      label: scope === "host" ? host : pattern.replace(/^https?:\/\//, ""),
      pillarIndex,
      actionId,
    };
    await browser.runtime.sendMessage({ action: "set-site-rule", rule });
    sitePickerOpen = false;
    resetPicks();
    await loadSiteBlock();
  });
  document.getElementById("site-remove")?.addEventListener("click", async () => {
    if (match?.ruleId) await browser.runtime.sendMessage({ action: "remove-site-rule", id: match.ruleId });
    sitePickerOpen = false;
    resetPicks();
    await loadSiteBlock();
  });
}
