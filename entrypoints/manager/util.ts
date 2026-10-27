

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function positionFixedMenu(menu: HTMLElement, clientX: number, clientY: number): void {
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(clientX, window.innerWidth - rect.width - pad));
  const top = Math.max(pad, Math.min(clientY, window.innerHeight - rect.height - pad));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

export function escapeHtml(raw: string): string {
  if (raw.length === 0) return raw;
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function downloadText(text: string, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
