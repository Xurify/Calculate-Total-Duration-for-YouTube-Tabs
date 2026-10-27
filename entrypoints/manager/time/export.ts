import { CSV_COLUMNS, DEFAULT_CSV_COLUMNS, type CsvColumn } from "../../../utils/watchCsv";
import { plural } from "./html";
import { downloadText, escapeHtml } from "../util";

let exportDays: number | null = 30;
let exportColumns = new Set<CsvColumn>(DEFAULT_CSV_COLUMNS);
const EXPORT_RANGES: { days: number | null; label: string }[] = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: null, label: "All time" },
];
const EXPORT_PREVIEW_ROWS = 4;

async function requestWatchCsv(): Promise<{ csv: string; rows: number } | null> {
  const response = (await browser.runtime.sendMessage({ action: "export-watch-csv", days: exportDays, columns: [...exportColumns] })) as { csv?: string; rows?: number };
  return typeof response?.csv === "string" ? { csv: response.csv, rows: response.rows ?? 0 } : null;
}

async function refreshExportPreview(): Promise<void> {
  const range = document.getElementById("export-range");
  const columns = document.getElementById("export-columns");
  const preview = document.getElementById("export-preview");
  const count = document.getElementById("export-count");
  const download = document.getElementById("export-download") as HTMLButtonElement | null;
  if (range) {
    range.innerHTML = EXPORT_RANGES.map(
      (option) => `<button type="button" class="export-range budget-chip text-xs" data-days="${option.days ?? ""}" aria-pressed="${exportDays === option.days}">${option.label}</button>`
    ).join("");
  }
  if (columns) {
    columns.innerHTML = CSV_COLUMNS.map(
      (column) => `<label class="flex items-center gap-2.5 text-sm text-text-secondary cursor-pointer"><input type="checkbox" class="ui-check export-column" value="${column.id}"${exportColumns.has(column.id) ? " checked" : ""} /> ${escapeHtml(column.label)}</label>`
    ).join("");
  }
  const result = exportColumns.size > 0 ? await requestWatchCsv() : null;
  const lines = result?.csv.trimEnd().split("\r\n") ?? [];
  if (preview) {
    const more = lines.length - 1 - EXPORT_PREVIEW_ROWS;
    preview.textContent = exportColumns.size === 0 ? "Pick at least one column." : [...lines.slice(0, EXPORT_PREVIEW_ROWS + 1), ...(more > 0 ? [`… ${more} more ${more === 1 ? "row" : "rows"}`] : [])].join("\n");
  }
  if (count) count.textContent = result ? plural(result.rows, "sitting") : "";
  if (download) download.disabled = !result || result.rows === 0;
}

export function openExportModal(): void {
  const modal = document.getElementById("export-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  void refreshExportPreview().then(() => document.getElementById("export-download")?.focus());
}

function closeExportModal(): void {
  const modal = document.getElementById("export-modal");
  modal?.classList.add("hidden");
  modal?.classList.remove("flex");
}

export function wireExportModal(): void {
  const modal = document.getElementById("export-modal");
  const form = document.getElementById("export-form") as HTMLFormElement | null;
  if (!modal || !form) return;
  modal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target === modal || target.closest("#export-cancel")) {
      closeExportModal();
      return;
    }
    const range = target.closest<HTMLElement>(".export-range");
    if (range) {
      exportDays = range.dataset.days ? Number(range.dataset.days) : null;
      void refreshExportPreview();
    }
  });
  modal.addEventListener("change", (event) => {
    const box = event.target as HTMLInputElement;
    if (!box.classList.contains("export-column")) return;
    if (box.checked) exportColumns.add(box.value as CsvColumn);
    else exportColumns.delete(box.value as CsvColumn);
    void refreshExportPreview();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeExportModal();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await requestWatchCsv();
    if (!result) return;
    // A byte order mark makes Excel read the file as UTF-8, so titles in other scripts survive.
    downloadText(`﻿${result.csv}`, "text/csv;charset=utf-8", `study-harvester-history-${new Date().toISOString().slice(0, 10)}.csv`);
    closeExportModal();
  });
}
