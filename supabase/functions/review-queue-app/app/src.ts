import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import "./style.css";

type ReviewStatus = "pending" | "approved" | "rejected";

interface ReviewItem {
  id: string;
  title: string;
  summary: string;
  status: ReviewStatus;
  createdAt: string;
  decidedAt: string | null;
}

interface QueuePayload {
  items: ReviewItem[];
  pendingCount: number;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

const root = document.querySelector(".shell") as HTMLElement;
const queueElement = document.querySelector("#queue") as HTMLElement;
const pendingElement = document.querySelector("#pending-count") as HTMLElement;
const noticeElement = document.querySelector("#notice") as HTMLElement;
const refreshButton = document.querySelector("#refresh") as HTMLButtonElement;

const app = new App({ name: "Supa MCP Review Queue", version: "0.1.0" });
let queue: QueuePayload = { items: [], pendingCount: 0 };
let busyItemId: string | null = null;

function isQueuePayload(value: unknown): value is QueuePayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QueuePayload>;
  return (
    Array.isArray(candidate.items) && typeof candidate.pendingCount === "number"
  );
}

function resultError(result: ToolResult): string | null {
  if (!result.isError) return null;
  return (
    result.content?.find((item) => item.type === "text")?.text ??
    "The review action could not be completed."
  );
}

function setNotice(message?: string, tone: "error" | "success" = "error") {
  noticeElement.hidden = !message;
  noticeElement.textContent = message ?? "";
  noticeElement.dataset.tone = tone;
}

function applyPayload(result: ToolResult) {
  const error = resultError(result);
  if (error) {
    setNotice(error);
    return;
  }
  if (!isQueuePayload(result.structuredContent)) {
    setNotice(
      "The server returned an unreadable review queue. Refresh to try again.",
    );
    return;
  }
  queue = result.structuredContent;
  setNotice();
  render();
}

function statusLabel(status: ReviewStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function renderEmpty() {
  const empty = document.createElement("div");
  empty.className = "empty";
  const title = document.createElement("strong");
  title.textContent =
    queue.items.length === 0 ? "Nothing to review" : "Queue cleared";
  const copy = document.createElement("p");
  copy.textContent =
    queue.items.length === 0
      ? "New application items will appear here when they need a decision."
      : "Every item in this queue has been decided.";
  empty.append(title, copy);
  queueElement.append(empty);
}

async function updateModelContext(item: ReviewItem) {
  if (!app.getHostCapabilities()?.updateModelContext?.text) return;
  await app
    .updateModelContext({
      content: [
        {
          type: "text",
          text: `Selected review item: ${item.title}\nStatus: ${item.status}\nSummary: ${item.summary}`,
        },
      ],
    })
    .catch(() => undefined);
}

function renderCard(item: ReviewItem) {
  const article = document.createElement("article");
  article.className = "item";
  article.dataset.status = item.status;

  const heading = document.createElement("div");
  heading.className = "item-heading";
  const title = document.createElement("h2");
  title.textContent = item.title;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = statusLabel(item.status);
  heading.append(title, badge);

  const summary = document.createElement("p");
  summary.textContent = item.summary;
  article.append(heading, summary);
  article.addEventListener("click", () => void updateModelContext(item));

  if (item.status === "pending") {
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const decision of ["rejected", "approved"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = decision === "approved" ? "approve" : "reject";
      button.textContent = decision === "approved" ? "Approve" : "Reject";
      button.disabled = busyItemId !== null;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void decide(item, decision);
      });
      actions.append(button);
    }
    article.append(actions);
  }
  queueElement.append(article);
}

function render() {
  pendingElement.textContent = `${queue.pendingCount} pending item${queue.pendingCount === 1 ? "" : "s"}`;
  queueElement.replaceChildren();
  const pending = queue.items.filter((item) => item.status === "pending");
  if (pending.length === 0) renderEmpty();
  else pending.forEach(renderCard);
}

async function decide(item: ReviewItem, decision: "approved" | "rejected") {
  busyItemId = item.id;
  setNotice();
  render();
  try {
    const result = (await app.callServerTool({
      name: "decide_review_item",
      arguments: { id: item.id, decision },
    })) as ToolResult;
    applyPayload(result);
    if (!result.isError) {
      setNotice(`${item.title} was ${decision}.`, "success");
      await updateModelContext({ ...item, status: decision });
    }
  } catch {
    setNotice(
      "The decision did not reach the server. Refresh before trying again.",
    );
  } finally {
    busyItemId = null;
    render();
  }
}

async function refresh() {
  refreshButton.disabled = true;
  setNotice();
  try {
    const result = (await app.callServerTool({
      name: "refresh_review_queue",
      arguments: {},
    })) as ToolResult;
    applyPayload(result);
  } catch {
    setNotice("The queue could not be refreshed. Try again.");
  } finally {
    refreshButton.disabled = false;
  }
}

function applyHostContext(context: McpUiHostContext) {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  if (context.safeAreaInsets) {
    root.style.padding = `${context.safeAreaInsets.top + 20}px ${context.safeAreaInsets.right + 20}px ${context.safeAreaInsets.bottom + 20}px ${context.safeAreaInsets.left + 20}px`;
  }
}

app.ontoolresult = applyPayload;
app.onhostcontextchanged = applyHostContext;
app.onerror = () =>
  setNotice(
    "The app lost its connection to the host. Reopen the queue to reconnect.",
  );
refreshButton.addEventListener("click", () => void refresh());

await app.connect();
const initialContext = app.getHostContext();
if (initialContext) applyHostContext(initialContext);
