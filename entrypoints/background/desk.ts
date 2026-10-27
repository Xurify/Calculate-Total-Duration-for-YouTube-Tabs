

export async function openDesk(): Promise<void> {
  const deskUrl = browser.runtime.getURL("/manager.html");
  const [existing] = await browser.tabs.query({ url: deskUrl });
  if (existing?.id == null) {
    await browser.tabs.create({ url: deskUrl });
    return;
  }
  await browser.tabs.update(existing.id, { active: true });
  if (existing.windowId != null) await browser.windows.update(existing.windowId, { focused: true });
}
