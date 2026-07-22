import {
  app,
  Tray,
  Menu,
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
  type WorkerStatus,
} from "@agentr/worker";
import { existsSync } from "node:fs";

let tray: Tray | null = null;
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

function rebuildMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: `AgentRelay — ${status}`,
      enabled: false,
    },
    {
      label: `Pairing: /pair ${pairingCode}`,
      click: () => {
        if (Notification.isSupported()) {
          new Notification({
            title: "AgentRelay pairing code",
            body: `In Teams send: /pair ${pairingCode}`,
          }).show();
        }
      },
    },
    { type: "separator" },
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
    {
      label: "Edit config.json",
      click: () => {
        ensureConfigDir();
        if (!existsSync(DEFAULT_CONFIG_PATH)) {
          const cfg = defaultConfig();
          cfg.dryRun = true;
          saveWorkerConfig(cfg);
        }
        void shell.openPath(DEFAULT_CONFIG_PATH);
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
  tray.setToolTip(`AgentRelay (${status}) — /pair ${pairingCode}`);
  tray.setImage(iconForStatus(status));
}

function startWorker(): void {
  ensureConfigDir();
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    const cfg = defaultConfig();
    cfg.dryRun = true;
    saveWorkerConfig(cfg);
  }

  const config = loadWorkerConfig();
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

  if (!config.workerToken || config.relayUrl.includes("localhost")) {
    console.warn(
      "[tray] Configure ~/.agent-relay/config.json (relayUrl + workerToken) then Reconnect.",
    );
  }

  worker.start();
  pairingCode = worker.getPairingCode();
  rebuildMenu();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === "darwin") {
      app.dock?.hide();
    }

    tray = new Tray(iconForStatus("offline"));
    rebuildMenu();
    startWorker();
  });

  app.on("window-all-closed", () => {
    // Keep running in tray — do not quit
  });
}
