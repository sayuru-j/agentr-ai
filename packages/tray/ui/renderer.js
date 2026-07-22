/* global agentr API from preload */
const $ = (id) => document.getElementById(id);

/** Last token loaded from disk — kept if the password field is left blank on save. */
let savedToken = "";

function projectRow(alias = "", path = "") {
  const row = document.createElement("div");
  row.className = "project-row";
  row.innerHTML = `
    <input class="alias" type="text" spellcheck="false" placeholder="alias" value="${escapeAttr(alias)}" />
    <input class="path" type="text" spellcheck="false" placeholder="No folder selected" value="${escapeAttr(path)}" readonly />
    <button type="button" class="browse">Browse</button>
    <button type="button" class="remove" aria-label="Remove">×</button>
  `;
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    updateProjectsEmpty();
  });
  row.querySelector(".browse").addEventListener("click", async () => {
    const picked = await window.agentr.pickFolder();
    if (picked) {
      row.querySelector(".path").value = picked;
    }
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
  updateProjectsEmpty();
}

function updateProjectsEmpty() {
  const empty = $("projects").children.length === 0;
  $("projects-empty").hidden = !empty;
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
  const el = $("status-label");
  el.textContent = status;
  el.className = `title-status ${status}`;
  $("pairing-btn").textContent = `/pair ${pairingCode || "--------"}`;
  $("pairing-btn").dataset.code = pairingCode || "";
}

function updateTokenSavedLabel(token) {
  const el = $("token-saved");
  if (!token) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = `Saved ····${token.slice(-4)} (${token.length} chars)`;
}

function fillForm(config) {
  savedToken = (config.workerToken || "").trim();
  $("relayUrl").value = config.relayUrl || "";
  $("workerToken").value = savedToken;
  $("agentCommand").value = config.agentCommand || "agent";
  $("agentModel").value = config.agentModel || "auto";
  $("dryRun").checked = Boolean(config.dryRun);
  updateTokenSavedLabel(savedToken);
  $("projects").innerHTML = "";
  const entries = Object.entries(config.projects || {});
  for (const [alias, path] of entries) addProject(alias, path);
  updateProjectsEmpty();
}

function readForm() {
  const typed = $("workerToken").value.trim();
  return {
    relayUrl: $("relayUrl").value.trim(),
    workerToken: typed || savedToken,
    agentCommand: $("agentCommand").value.trim() || "agent",
    agentModel: $("agentModel").value.trim() || "auto",
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
  }, 4000);
}

function switchTab(name) {
  for (const btn of document.querySelectorAll(".tab")) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    const on = panel.id === `tab-${name}`;
    panel.classList.toggle("active", on);
    panel.hidden = !on;
  }
}

async function saveAll(connect = true) {
  const cfg = readForm();
  if (!cfg.relayUrl) {
    showMsg("Relay URL required", true);
    switchTab("settings");
    return;
  }
  if (!cfg.workerToken) {
    showMsg("Token required", true);
    switchTab("settings");
    return;
  }
  try {
    const saved = await window.agentr.saveConfig(cfg);
    savedToken = saved.workerToken;
    $("workerToken").value = savedToken;
    updateTokenSavedLabel(savedToken);
    showMsg(connect ? "Saved — connecting…" : "Projects saved");
  } catch (err) {
    showMsg(err?.message || "Save failed", true);
  }
}

async function boot() {
  $("win-min").addEventListener("click", () => window.agentr.windowMinimize());
  $("win-close").addEventListener("click", () => window.agentr.windowClose());

  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }

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
    try {
      await navigator.clipboard.writeText(`/pair ${code}`);
      showMsg("Copied");
    } catch {
      showMsg("Could not copy", true);
    }
  });

  $("save-home").addEventListener("click", () => saveAll(true));
  $("save-settings").addEventListener("click", () => saveAll(true));
  $("save-projects").addEventListener("click", () => saveAll(false));

  $("reconnect").addEventListener("click", async () => {
    await window.agentr.reconnect();
    showMsg("Reconnecting…");
  });
}

boot().catch((err) => {
  console.error(err);
  showMsg(err?.message || "Failed to load", true);
});
