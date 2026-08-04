/* global agentr from preload */
const out = document.getElementById("out");
const meta = document.getElementById("meta");
const filterInput = document.getElementById("filter");
const pinsEl = document.getElementById("pins");

/** @type {{ taskId: string, prompt: string, cwd: string, chunks: Array<{text:string,stream:string,kind?:string}>, exitCode?: number } | null} */
let current = null;
/** @type {Array<{ taskId: string, prompt: string, cwd: string, chunks: Array<{text:string,stream:string,kind?:string}>, exitCode: number }>} */
const pinnedFailed = [];
let viewingPinId = null;

document.getElementById("win-min").addEventListener("click", () => {
  window.agentr?.windowMinimize?.();
});
document.getElementById("win-close").addEventListener("click", () => {
  window.agentr?.windowClose?.();
});

document.getElementById("copy").addEventListener("click", async () => {
  const text = visibleText();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
});

document.getElementById("clear").addEventListener("click", () => {
  if (current) current.chunks = [];
  render();
});

filterInput.addEventListener("input", () => render());

function visibleText() {
  return Array.from(out.querySelectorAll("span"))
    .map((s) => s.textContent || "")
    .join("");
}

function renderPins() {
  pinsEl.innerHTML = "";
  if (pinnedFailed.length > 0) {
    const live = document.createElement("button");
    live.type = "button";
    live.className = "pin" + (viewingPinId === null ? " active" : "");
    live.textContent = "live";
    live.addEventListener("click", () => {
      viewingPinId = null;
      meta.textContent = current?.cwd || "";
      render();
      renderPins();
    });
    pinsEl.appendChild(live);
  }
  for (const pin of pinnedFailed) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pin" + (viewingPinId === pin.taskId ? " active" : "");
    btn.textContent = `fail ${pin.taskId.slice(0, 6)}`;
    btn.title = pin.prompt || pin.taskId;
    btn.addEventListener("click", () => {
      viewingPinId = pin.taskId;
      meta.textContent = pin.cwd || "";
      render();
      renderPins();
    });
    pinsEl.appendChild(btn);
  }
}

function activeSession() {
  if (viewingPinId) {
    return pinnedFailed.find((p) => p.taskId === viewingPinId) || current;
  }
  return current;
}

function render() {
  const session = activeSession();
  out.textContent = "";
  if (!session) return;
  const q = filterInput.value.trim().toLowerCase();
  for (const chunk of session.chunks) {
    if (q && !(chunk.text || "").toLowerCase().includes(q)) continue;
    const span = document.createElement("span");
    if (chunk.kind === "banner") span.className = "banner";
    else if (chunk.stream === "stderr") span.className = "stderr";
    span.textContent = chunk.text;
    out.appendChild(span);
  }
  out.scrollTop = out.scrollHeight;
}

function pushChunk(text, stream, kind) {
  if (!current) return;
  current.chunks.push({ text, stream: stream || "stdout", kind });
  if (!viewingPinId) render();
}

window.agentr?.onConsoleInit?.((info) => {
  viewingPinId = null;
  current = {
    taskId: String(info?.taskId || ""),
    prompt: String(info?.prompt || ""),
    cwd: String(info?.cwd || ""),
    chunks: [],
  };
  meta.textContent = current.cwd;
  pushChunk(
    `── task ${current.taskId.slice(0, 8)} ──\n${current.prompt}\n\n`,
    "stdout",
    "banner",
  );
  renderPins();
});

window.agentr?.onConsoleLog?.((info) => {
  pushChunk(info.chunk || "", info.stream || "stdout");
});

window.agentr?.onConsoleEnd?.((info) => {
  const code = info?.exitCode ?? "?";
  pushChunk(`\n── exit ${code} ──\n`, "stdout", "banner");
  if (current && typeof info?.exitCode === "number" && info.exitCode !== 0) {
    const snap = {
      taskId: current.taskId,
      prompt: current.prompt,
      cwd: current.cwd,
      chunks: current.chunks.slice(),
      exitCode: info.exitCode,
    };
    const idx = pinnedFailed.findIndex((p) => p.taskId === snap.taskId);
    if (idx >= 0) pinnedFailed.splice(idx, 1);
    pinnedFailed.unshift(snap);
    if (pinnedFailed.length > 8) pinnedFailed.length = 8;
    renderPins();
  }
});
