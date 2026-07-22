import {
  app,
  Tray,
  Menu,
  BrowserWindow,
  ipcMain,
  nativeImage,
  shell,
  Notification,
} from "electron";
import {
  AgentRelayWorker,
  loadWorkerConfig,
  ensureConfigDir,
  DEFAULT_CONFIG_DIR,
  DEFAULT_CONFIG_PATH,
  saveWorkerConfig,
  defaultConfig,
  type WorkerConfig,
  type WorkerStatus,
} from "@agentr/worker";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = join(__dirname, "..", "preload.cjs");
const UI_PATH = join(__dirname, "..", "ui", "index.html");

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let worker: AgentRelayWorker | null = null;
let pairingCode = "--------";
let status: WorkerStatus = "offline";

function iconForStatus(s: WorkerStatus): Electron.NativeImage {
  const colors: Record<WorkerStatus, string> = {
    offline: "#9CA3AF",
    connecting: "#F59E0B",
    online: "#22C55E",
    busy: "#3B82F6",
  };
  const color = colors[s];
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const rgb = hexToRgb(color);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    buf[o] = rgb.r;
    buf[o + 1] = rgb.g;
    buf[o + 2] = rgb.b;
    buf[o + 3] = 255;
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function broadcastStatus(): void {
  settingsWindow?.webContents.send("status:changed", {
    status,
    pairingCode,
  });
}

function rebuildMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: `AgentR — ${status}`,
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
  tray.setImage(iconForStatus(status));
  broadcastStatus();
}

function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 380,
    minHeight: 520,
    title: "AgentR",
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

function startWorker(): void {
  ensureConfigDir();
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    const cfg = defaultConfig();
    cfg.dryRun = true;
    saveWorkerConfig(cfg);
  }

  const config = loadWorkerConfig();
  console.log(
    `[tray] Config ${DEFAULT_CONFIG_PATH} · token ${config.workerToken ? `${config.workerToken.length} chars (…${config.workerToken.slice(-4)})` : "MISSING"}`,
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

  const needsSetup =
    !config.workerToken ||
    config.workerToken.includes("PASTE_") ||
    config.relayUrl.includes("localhost");

  if (needsSetup) {
    console.warn("[tray] Open settings to paste worker token and relay URL.");
  }

  worker.start();
  pairingCode = worker.getPairingCode();
  rebuildMenu();

  if (needsSetup) {
    openSettings();
  }
}

function registerIpc(): void {
  ipcMain.handle("config:get", () => loadWorkerConfig());

  ipcMain.handle("config:save", (_event, partial: Partial<WorkerConfig>) => {
    const next: WorkerConfig = {
      ...loadWorkerConfig(),
      ...partial,
      projects: partial.projects ?? loadWorkerConfig().projects,
    };
    if (!next.relayUrl?.trim()) {
      throw new Error("Relay URL is required");
    }
    if (!next.workerToken?.trim()) {
      throw new Error("Worker token is required");
    }
    saveWorkerConfig(next);
    worker?.updateConfig(next);
    worker?.reconnect();
    return next;
  });

  ipcMain.handle("status:get", () => ({ status, pairingCode }));

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
    tray = new Tray(iconForStatus("offline"));
    tray.on("double-click", () => openSettings());
    rebuildMenu();
    startWorker();
  });

  app.on("window-all-closed", () => {
    // Keep running in tray
  });
}
