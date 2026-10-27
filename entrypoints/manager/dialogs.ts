

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDanger?: boolean;
}

export function showNameSessionModal(defaultName: string, heading = "Name this session"): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.getElementById("name-session-modal");
    const input = document.getElementById("name-session-input") as HTMLInputElement;
    const cancelBtn = document.getElementById("name-session-cancel");
    const saveBtn = document.getElementById("name-session-save");
    const titleEl = document.getElementById("name-session-title");
    if (!modal || !input || !cancelBtn || !saveBtn) {
      resolve(null);
      return;
    }
    if (titleEl) titleEl.textContent = heading;
    input.value = defaultName;
    input.select();
    const close = (result: string | null) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex", "items-center", "justify-center");
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      saveBtn.removeEventListener("click", onSave);
      modal.removeEventListener("click", onBackdrop);
      input.removeEventListener("keydown", onKeydown);
    };
    const onCancel = () => close(null);
    const onSave = () => close((input.value?.trim() || defaultName));
    const onBackdrop = (event: MouseEvent) => {
      if ((event.target as HTMLElement).id === "name-session-modal") close(null);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(null);
      if (event.key === "Enter") onSave();
    };
    cancelBtn.addEventListener("click", onCancel);
    saveBtn.addEventListener("click", onSave);
    modal.addEventListener("click", onBackdrop);
    input.addEventListener("keydown", onKeydown);
    modal.classList.remove("hidden");
    modal.classList.add("flex", "items-center", "justify-center");
    requestAnimationFrame(() => input.focus());
  });
}

export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-title");
    const messageEl = document.getElementById("confirm-message");
    const cancelBtn = document.getElementById("confirm-cancel");
    const okBtn = document.getElementById("confirm-ok");
    if (!modal || !titleEl || !messageEl || !cancelBtn || !okBtn) {
      resolve(false);
      return;
    }
    titleEl.textContent = options.title;
    messageEl.textContent = options.message;
    okBtn.textContent = options.confirmLabel ?? "OK";
    cancelBtn.textContent = options.cancelLabel ?? "Cancel";
    okBtn.classList.remove("bg-accent", "hover:bg-accent-hover", "bg-danger", "hover:bg-danger-hover");
    okBtn.classList.add("text-on-accent");
    if (options.confirmDanger) {
      okBtn.classList.add("bg-danger", "hover:bg-danger-hover");
    } else {
      okBtn.classList.add("bg-accent", "hover:bg-accent-hover");
    }
    const close = (result: boolean) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex", "items-center", "justify-center");
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onOk);
      modal.removeEventListener("click", onBackdrop);
    };
    const onCancel = () => close(false);
    const onOk = () => close(true);
    const onBackdrop = (event: MouseEvent) => {
      if ((event.target as HTMLElement).id === "confirm-modal") close(false);
    };
    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
    modal.addEventListener("click", onBackdrop);
    modal.classList.remove("hidden");
    modal.classList.add("flex", "items-center", "justify-center");
  });
}
