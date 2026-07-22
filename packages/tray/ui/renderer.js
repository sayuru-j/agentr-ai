/* global agentr API from preload */
const $ = (id) => document.getElementById(id);

function projectRow(alias = "", path = "") {
  const row = document.createElement("div");
  row.className = "project-row";
  row.innerHTML = `
    <input class="alias" type="text" spellcheck="false" placeholder="alias" value="${escapeAttr(alias)}" />
    <input class="path" type="text" spellcheck="false" placeholder="C:/path/to/repo" value="${escapeAttr(path)}" />
    <button type="button" class="remove" aria-label="Remove">×</button>
  `;
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    if ($("projects").children.length === 0) addProject();
  });
  return row;
}

function escapeAttr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function addProject(alias = "", path = "") {
  $("projects").appendChild(projectRow(alias, path));
}

function readProjects() {
  const out = {};
  for (const row of $("projects").querySelectorAll(".project-row")) {
    const alias = row.querySelector(".alias").value.trim();
    const path = row.querySelector(".path").value.trim();
    if (alias && path) out[alias] = path;
  }
  return out;
}

function setStatus(status, pairingCode) {
  const dot = $("status-dot");
  dot.className = `dot ${status}`;
  $("status-label").textContent = status;
  $("pairing-btn").textContent = `/pair ${pairingCode || "--------"}`;
  $("pairing-btn").dataset.code = pairingCode || "";
}

function fillForm(config) {
  $("relayUrl").value = config.relayUrl || "";
  $("workerToken").value = config.workerToken || "";
  $("agentCommand").value = config.agentCommand || "agent";
  $("dryRun").checked = Boolean(config.dryRun);
  $("projects").innerHTML = "";
  const entries = Object.entries(config.projects || {});
  if (entries.length === 0) addProject("frontend", "");
  else for (const [alias, path] of entries) addProject(alias, path);
}

function readForm() {
  return {
    relayUrl: $("relayUrl").value.trim(),
    workerToken: $("workerToken").value.trim(),
    agentCommand: $("agentCommand").value.trim() || "agent",
    dryRun: $("dryRun").checked,
    projects: readProjects(),
  };
}

function showMsg(text, isError = false) {
  const el = $("save-msg");
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("error", isError);
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

async function boot() {
  const [config, live] = await Promise.all([
    window.agentr.getConfig(),
    window.agentr.getStatus(),
  ]);
  fillForm(config);
  setStatus(live.status, live.pairingCode);

  window.agentr.onStatus((payload) => {
    setStatus(payload.status, payload.pairingCode);
  });

  $("add-project").addEventListener("click", () => addProject());
  $("toggle-token").addEventListener("click", () => {
    const input = $("workerToken");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("toggle-token").textContent = show ? "Hide" : "Show";
  });

  $("pairing-btn").addEventListener("click", async () => {
    const code = $("pairing-btn").dataset.code;
    if (!code) return;
    const text = `/pair ${code}`;
    try {
      await navigator.clipboard.writeText(text);
      showMsg("Pairing command copied");
    } catch {
      showMsg("Could not copy", true);
    }
  });

  $("save").addEventListener("click", async () => {
    const cfg = readForm();
    if (!cfg.relayUrl) {
      showMsg("Relay URL is required", true);
      return;
    }
    if (!cfg.workerToken) {
      showMsg("Paste the worker token from the VM", true);
      return;
    }
    try {
      await window.agentr.saveConfig(cfg);
      showMsg("Saved — connecting…");
    } catch (err) {
      showMsg(err?.message || "Save failed", true);
    }
  });

  $("reconnect").addEventListener("click", async () => {
    await window.agentr.reconnect();
    showMsg("Reconnecting…");
  });
}

boot().catch((err) => {
  console.error(err);
  showMsg(err?.message || "Failed to load", true);
});
