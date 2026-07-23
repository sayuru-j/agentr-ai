import {
  app,
  Tray,
  Menu,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeImage,
  shell,
  Notification,
  powerMonitor,
} from "electron";
import {
  AgentRelayWorker,
  loadWorkerConfig,
  ensureConfigDir,
  DEFAULT_CONFIG_DIR,
  DEFAULT_CONFIG_PATH,
  saveWorkerConfig,
  defaultConfig,
  resolveAgentCommand,
  preferResolvedAgentCommand,
  coerceProjects,
  type WorkerConfig,
  type WorkerStatus,
  type ResolveAgentResult,
} from "@agentr/worker";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGithubReleaseUpdate, type UpdateCheckResult } from "./updates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = join(__dirname, "..", "preload.cjs");
const UI_PATH = join(__dirname, "..", "ui", "index.html");
const CONSOLE_UI_PATH = join(__dirname, "..", "ui", "console.html");
const PACKAGE_JSON = join(__dirname, "..", "package.json");
const LOGO_CANDIDATES = [
  join(__dirname, "..", "ui", "logo.png"),
  join(__dirname, "ui", "logo.png"),
  ...(typeof process.resourcesPath === "string"
    ? [join(process.resourcesPath, "logo.png")]
    : []),
  join(__dirname, "..", "..", "assets", "logo.png"),
];

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let consoleWindow: BrowserWindow | null = null;
let worker: AgentRelayWorker | null = null;
let pairingCode = "--------";
let status: WorkerStatus = "offline";
let pairedUsers = 0;
let cachedAppIcon: Electron.NativeImage | null = null;
let cachedTrayIcon: Electron.NativeImage | null = null;
let lastUpdate: UpdateCheckResult | null = null;
let sessionLocked = false;

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      version?: string;
    };
    return pkg.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function resolveLogoPath(): string | null {
  for (const candidate of LOGO_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function appIcon(): Electron.NativeImage {
  if (cachedAppIcon) return cachedAppIcon;
  const logoPath = resolveLogoPath();
  cachedAppIcon = logoPath
    ? nativeImage.createFromPath(logoPath)
    : nativeImage.createEmpty();
  return cachedAppIcon;
}

/** Tray icons look best at ~16–32px on Windows. */
function trayIcon(): Electron.NativeImage {
  if (cachedTrayIcon) return cachedTrayIcon;
  const base = appIcon();
  cachedTrayIcon = base.isEmpty() ? base : base.resize({ width: 16, height: 16 });
  return cachedTrayIcon;
}

function broadcastStatus(): void {
  settingsWindow?.webContents.send("status:changed", {
    status,
    pairingCode,
    pairedUsers,
    checklist: buildChecklist(),
    update: lastUpdate,
    sessionLocked,
  });
}

function applyLoginItemSettings(config: WorkerConfig): void {
  if (process.platform !== "win32") return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(config.openAtLogin),
      openAsHidden: true,
      path: process.execPath,
      args: app.isPackaged ? [] : [join(__dirname, "..")],
    });
  } catch (err) {
    console.warn("[tray] setLoginItemSettings failed", err);
  }
}

async function runUpdateCheck(force = false): Promise<UpdateCheckResult> {
  const config = loadWorkerConfig();
  if (!force && config.checkUpdates === false) {
    lastUpdate = {
      checked: false,
      updateAvailable: false,
      localVersion: appVersion(),
      error: "Update checks disabled",
    };
    broadcastStatus();
    return lastUpdate;
  }
  lastUpdate = await checkGithubReleaseUpdate({
    localVersion: appVersion(),
  });
  broadcastStatus();
  rebuildMenu();
  if (lastUpdate.updateAvailable && Notification.isSupported()) {
    new Notification({
      title: "AgentR update available",
      body: `v${lastUpdate.remoteVersion} is out (you have v${lastUpdate.localVersion}).`,
    }).show();
  }
  return lastUpdate;
}

interface ChecklistState {
  relayOk: boolean;
  tokenSet: boolean;
  agentFound: boolean;
  paired: boolean;
  agent: ResolveAgentResult;
  allOk: boolean;
}

function buildChecklist(): ChecklistState {
  const config = loadWorkerConfig();
  const tokenSet = Boolean(
    config.workerToken?.trim() && !config.workerToken.includes("PASTE_"),
  );
  const agent = resolveAgentCommand(config.agentCommand);
  const agentFound = config.dryRun || agent.found;
  const relayOk = status === "online" || status === "busy";
  const paired = pairedUsers > 0;
  return {
    relayOk,
    tokenSet,
    agentFound,
    paired,
    agent,
    allOk: relayOk && tokenSet && agentFound && paired,
  };
}

/** Persist a concrete agent path when config still says bare `agent`. */
function autoPersistResolvedAgent(config: WorkerConfig): WorkerConfig {
  const preferred = preferResolvedAgentCommand(config.agentCommand);
  if (preferred === config.agentCommand) return config;
  const next = { ...config, agentCommand: preferred };
  saveWorkerConfig(next);
  console.log(`[tray] Resolved agent CLI → ${preferred}`);
  return next;
}

function rebuildMenu(): void {
  if (!tray) return;
  const updateLabel = lastUpdate?.updateAvailable
    ? `Update available (v${lastUpdate.remoteVersion})…`
    : "Check for updates…";
  const menu = Menu.buildFromTemplate([
    {
      label: `AgentR — ${status}${sessionLocked ? " · locked" : ""}`,
      enabled: false,
    },
    {
      label: `Pairing: /pair ${pairingCode}`,
      click: () => {
        if (Notification.isSupported()) {
          new Notification({
            title: "AgentR pairing code",
            body: `In Teams send: /pair ${pairingCode}`,
          }).show();
        }
      },
    },
    { type: "separator" },
    {
      label: "Open AgentR…",
      click: () => openSettings(),
    },
    {
      label: "Reconnect",
      click: () => worker?.reconnect(),
    },
    {
      label: updateLabel,
      click: () => {
        if (lastUpdate?.updateAvailable && lastUpdate.releaseUrl) {
          void shell.openExternal(
            lastUpdate.portableUrl || lastUpdate.releaseUrl,
          );
        } else {
          void runUpdateCheck(true);
        }
      },
    },
    {
      label: "Open config folder",
      click: () => {
        ensureConfigDir();
        void shell.openPath(DEFAULT_CONFIG_DIR);
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        worker?.stop();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`AgentR (${status}) — /pair ${pairingCode}`);
  tray.setImage(trayIcon());
  broadcastStatus();
}

function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 440,
    height: 760,
    minWidth: 380,
    minHeight: 560,
    title: "AgentR",
    icon: appIcon(),
    backgroundColor: "#f7f6f3",
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: "hidden",
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  void settingsWindow.loadFile(UI_PATH);
  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function openAgentConsole(info: {
  taskId: string;
  prompt: string;
  cwd: string;
}): void {
  if (!consoleWindow || consoleWindow.isDestroyed()) {
    consoleWindow = new BrowserWindow({
      width: 720,
      height: 480,
      minWidth: 420,
      minHeight: 280,
      title: "AgentR Console",
      icon: appIcon(),
      backgroundColor: "#0c0d0f",
      autoHideMenuBar: true,
      frame: false,
      titleBarStyle: "hidden",
      show: false,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    void consoleWindow.loadFile(CONSOLE_UI_PATH);
    consoleWindow.on("closed", () => {
      consoleWindow = null;
    });
  }

  const sendInit = () => {
    consoleWindow?.webContents.send("console:init", info);
  };

  if (consoleWindow.webContents.isLoading()) {
    consoleWindow.webContents.once("did-finish-load", sendInit);
  } else {
    sendInit();
  }

  consoleWindow.show();
  consoleWindow.focus();
}

function startWorker(): void {
  ensureConfigDir();
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    const cfg = defaultConfig();
    cfg.dryRun = true;
    saveWorkerConfig(cfg);
  }

  const config = autoPersistResolvedAgent(loadWorkerConfig());
  console.log(
    `[tray] Config ${DEFAULT_CONFIG_PATH} · token ${config.workerToken ? `${config.workerToken.length} chars (…${config.workerToken.slice(-4)})` : "MISSING"}`,
  );
  const agent = resolveAgentCommand(config.agentCommand);
  console.log(
    `[tray] Agent CLI: ${agent.found ? `${agent.command} (${agent.source})` : "NOT FOUND — set path in Settings"}`,
  );
  worker = new AgentRelayWorker(config);
  worker.on("status", (s) => {
    status = s;
    rebuildMenu();
  });
  worker.on("pairingCode", (code) => {
    pairingCode = code;
    rebuildMenu();
  });
  worker.on("pairedUsers", (count) => {
    pairedUsers = count;
    rebuildMenu();
  });
  worker.on("log", (line) => {
    console.log(`[tray] ${line}`);
  });
  worker.on("error", (err) => {
    console.error(`[tray] ${err.message}`);
  });
  worker.on("unauthorized", (message) => {
    console.error(`[tray] ${message}`);
    if (Notification.isSupported()) {
      new Notification({
        title: "AgentR — unauthorized",
        body: "Worker token rejected. Paste the VM WORKER_TOKEN and Save & connect.",
      }).show();
    }
    openSettings();
  });
  worker.on("taskStart", (info) => {
    openAgentConsole(info);
  });
  worker.on("taskLog", (info) => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send("console:log", info);
    }
  });
  worker.on("taskEnd", (info) => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send("console:end", info);
    }
  });

  const needsSetup =
    !config.workerToken ||
    config.workerToken.includes("PASTE_") ||
    config.relayUrl.includes("localhost") ||
    config.relayUrl.includes("example.com") ||
    (!config.dryRun && !resolveAgentCommand(config.agentCommand).found);

  if (needsSetup) {
    console.warn("[tray] Open settings to paste worker token and relay URL.");
  }

  applyLoginItemSettings(config);
  worker.start();
  pairingCode = worker.getPairingCode();
  rebuildMenu();

  if (needsSetup || !config.startMinimized) {
    openSettings();
  }

  if (config.checkUpdates !== false) {
    void runUpdateCheck(false);
  }
}

function registerIpc(): void {
  ipcMain.handle("config:get", () => {
    return autoPersistResolvedAgent(loadWorkerConfig());
  });

  ipcMain.handle("config:save", (_event, partial: Partial<WorkerConfig>) => {
    const current = loadWorkerConfig();
    const next: WorkerConfig = {
      ...current,
      ...partial,
      projects: coerceProjects(partial.projects ?? current.projects),
    };
    if (!next.relayUrl?.trim()) {
      throw new Error("Relay URL is required");
    }
    if (!next.workerToken?.trim()) {
      throw new Error("Worker token is required");
    }
    if (!next.agentCommand?.trim() || next.agentCommand.trim() === "agent") {
      next.agentCommand = preferResolvedAgentCommand(
        next.agentCommand || "agent",
      );
    }
    saveWorkerConfig(next);
    applyLoginItemSettings(next);
    worker?.updateConfig(next);
    worker?.reconnect();
    broadcastStatus();
    if (next.checkUpdates) {
      void runUpdateCheck(false);
    }
    return next;
  });

  ipcMain.handle("status:get", () => ({
    status,
    pairingCode,
    pairedUsers,
    checklist: buildChecklist(),
    update: lastUpdate,
    sessionLocked,
    version: appVersion(),
    packaged: app.isPackaged,
  }));

  ipcMain.handle("checklist:get", () => buildChecklist());

  ipcMain.handle("updates:check", () => runUpdateCheck(true));

  ipcMain.handle("updates:open", () => {
    const url = lastUpdate?.portableUrl || lastUpdate?.releaseUrl;
    if (url) void shell.openExternal(url);
    return { ok: Boolean(url) };
  });

  ipcMain.handle("agent:resolve", (_event, configured?: string) => {
    const cmd =
      typeof configured === "string" && configured.trim()
        ? configured.trim()
        : loadWorkerConfig().agentCommand;
    return resolveAgentCommand(cmd);
  });

  ipcMain.handle("worker:reconnect", () => {
    worker?.reconnect();
    return { ok: true };
  });

  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle("dialog:pickFolder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, {
          properties: ["openDirectory"],
          title: "Select project folder",
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory"],
          title: "Select project folder",
        });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    openSettings();
  });

  app.whenReady().then(() => {
    if (process.platform === "darwin") {
      app.dock?.hide();
    }

    registerIpc();
    tray = new Tray(trayIcon());
    tray.on("double-click", () => openSettings());
    rebuildMenu();

    powerMonitor.on("lock-screen", () => {
      sessionLocked = true;
      console.warn("[tray] Screen locked — /ss will fail until unlock");
      rebuildMenu();
    });
    powerMonitor.on("unlock-screen", () => {
      sessionLocked = false;
      rebuildMenu();
    });

    startWorker();
  });

  app.on("window-all-closed", () => {
    // Keep running in tray
  });
}
