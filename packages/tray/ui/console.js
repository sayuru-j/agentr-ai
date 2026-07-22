/* global agentr from preload */
const out = document.getElementById("out");
const meta = document.getElementById("meta");

document.getElementById("win-min").addEventListener("click", () => {
  window.agentr?.windowMinimize?.();
});
document.getElementById("win-close").addEventListener("click", () => {
  window.agentr?.windowClose?.();
});

function append(chunk, stream) {
  const span = document.createElement("span");
  if (stream === "stderr") span.className = "stderr";
  span.textContent = chunk;
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}

function banner(text) {
  const span = document.createElement("span");
  span.className = "banner";
  span.textContent = text;
  out.appendChild(span);
}

window.agentr?.onConsoleInit?.((info) => {
  meta.textContent = info?.cwd ? info.cwd : "";
  out.textContent = "";
  banner(
    `── task ${String(info?.taskId || "").slice(0, 8)} ──\n${info?.prompt || ""}\n\n`,
  );
});

window.agentr?.onConsoleLog?.((info) => {
  append(info.chunk || "", info.stream || "stdout");
});

window.agentr?.onConsoleEnd?.((info) => {
  banner(`\n── exit ${info?.exitCode ?? "?"} ──\n`);
});
