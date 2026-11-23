import {
  createAppWorkspace,
  readAppTool,
  type AppCallToolResult,
} from "chumbo/app";
import "./style.css";

interface AppPayload {
  readonly items: readonly { readonly id: string; readonly title: string }[];
}

const root = document.querySelector<HTMLElement>(".shell")!;
const eyebrowElement = document.querySelector<HTMLElement>("#eyebrow")!;
const contentElement = document.querySelector<HTMLElement>("#content")!;
const noticeElement = document.querySelector<HTMLElement>("#notice")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const expandButton = document.querySelector<HTMLButtonElement>("#expand")!;

const workspace = createAppWorkspace(
  { name: "{{APP_TITLE}}", version: "0.1.0" },
  { root },
);
const { app, presentation } = workspace;

if (presentation.productName) {
  eyebrowElement.textContent = presentation.productName;
}

function isAppPayload(value: unknown): value is AppPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Partial<AppPayload>).items)
  );
}

function setNotice(message?: string, tone: "error" | "success" = "error") {
  noticeElement.hidden = !message;
  noticeElement.textContent = message ?? "";
  noticeElement.dataset.tone = tone;
}

function render(payload: AppPayload) {
  contentElement.replaceChildren();
  if (payload.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No items yet.";
    contentElement.append(empty);
    return;
  }
  for (const item of payload.items) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("h2");
    title.textContent = item.title;
    card.append(title);
    contentElement.append(card);
  }
}

function applyToolResult(result: AppCallToolResult) {
  if (result.isError) {
    const message =
      result.content?.find((block) => block.type === "text")?.text ??
      "The action could not be completed.";
    setNotice(message);
    return;
  }
  if (!isAppPayload(result.structuredContent)) {
    setNotice("The server returned an unreadable payload. Refresh to try again.");
    return;
  }
  setNotice();
  render(result.structuredContent);
}

async function refresh() {
  refreshButton.disabled = true;
  setNotice();
  try {
    const outcome = await readAppTool<AppPayload>(
      workspace,
      "refresh_{{APP_SNAKE}}",
      {},
      { guard: isAppPayload },
    );
    if (outcome.status === "applied") {
      render(outcome.data);
    } else {
      setNotice(outcome.message);
    }
  } finally {
    refreshButton.disabled = false;
  }
}

function updateDisplayControls() {
  const context = workspace.getHostContext();
  expandButton.hidden = !workspace.canFullscreen();
  expandButton.textContent =
    context?.displayMode === "fullscreen" ? "Collapse" : "Expand";
}

app.ontoolresult = (result) => applyToolResult(result as AppCallToolResult);
app.addEventListener("hostcontextchanged", updateDisplayControls);
app.onerror = () =>
  setNotice("The app lost its connection to the host. Reopen it to reconnect.");

refreshButton.addEventListener("click", () => void refresh());
expandButton.addEventListener("click", async () => {
  expandButton.disabled = true;
  await workspace.toggleFullscreen().catch(() => undefined);
  expandButton.disabled = false;
  updateDisplayControls();
});

await workspace.connect();
updateDisplayControls();
