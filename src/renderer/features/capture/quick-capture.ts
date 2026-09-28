import { openIdeaPanelFromUrl } from "../ideas/project-ideas";

const dialog = () => document.querySelector<HTMLDialogElement>("#quick-capture-dialog")!;
const input = () => document.querySelector<HTMLInputElement>("#quick-capture-url")!;
const errorBox = () => document.querySelector<HTMLElement>("#quick-capture-error")!;
let captureToastTimer = 0;

function showCaptureConfirmation(url: string) {
  const toast = document.querySelector<HTMLElement>("#toast");
  if (!toast) return;
  window.clearTimeout(captureToastTimer);
  toast.className = "";
  toast.textContent = `Link recebido do navegador: ${new URL(url).hostname}. Preparando a captura…`;
  toast.classList.add("show");
  captureToastTimer = window.setTimeout(
    () => toast.classList.remove("show"),
    5000,
  );
}

function showQuickCapture() {
  errorBox().hidden = true;
  input().value = "";
  if (!dialog().open) dialog().showModal();
  requestAnimationFrame(() => input().focus());
}

function parseArticleUrl(raw: string): string | null {
  const value = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function setupQuickCapture() {
  document
    .querySelector<HTMLButtonElement>("#capture-link")!
    .addEventListener("click", showQuickCapture);
  document
    .querySelector<HTMLButtonElement>("#close-quick-capture")!
    .addEventListener("click", () => dialog().close());
  document
    .querySelector<HTMLButtonElement>("#cancel-quick-capture")!
    .addEventListener("click", () => dialog().close());
  document
    .querySelector<HTMLFormElement>("#quick-capture-form")!
    .addEventListener("submit", (event) => {
      event.preventDefault();
      const url = parseArticleUrl(input().value.trim());
      if (!url) {
        errorBox().textContent = "Informe um link público começando com http:// ou https://.";
        errorBox().hidden = false;
        input().focus();
        return;
      }
      dialog().close();
      void openIdeaPanelFromUrl(url);
    });

  window.contentApp.onCaptureRequest((url) => {
    if (url) {
      if (dialog().open) dialog().close();
      showCaptureConfirmation(url);
      void openIdeaPanelFromUrl(url);
    } else showQuickCapture();
  });
}
