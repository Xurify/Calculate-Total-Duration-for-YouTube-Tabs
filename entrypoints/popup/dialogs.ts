

export function showConfirm(options: { title: string; message: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById("popup-confirm-modal");
    const titleEl = document.getElementById("popup-confirm-title");
    const messageEl = document.getElementById("popup-confirm-message");
    const cancelBtn = document.getElementById("popup-confirm-cancel");
    const okBtn = document.getElementById("popup-confirm-ok");
    if (!modal || !titleEl || !messageEl || !cancelBtn || !okBtn) {
      resolve(false);
      return;
    }
    titleEl.textContent = options.title;
    messageEl.textContent = options.message;
    const close = (result: boolean) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onOk);
      modal.removeEventListener("click", onBackdrop);
    };
    const onCancel = () => close(false);
    const onOk = () => close(true);
    const onBackdrop = (e: MouseEvent) => {
      if ((e.target as HTMLElement).id === "popup-confirm-modal") close(false);
    };
    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
    modal.addEventListener("click", onBackdrop);
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  });
}
