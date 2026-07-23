import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DisplayState {
  locked: boolean;
  woke: boolean;
  detail?: string;
}

/** True when Windows LogonUI is present (session locked / secure desktop). */
export async function isWorkstationLocked(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Process -Name LogonUI -ErrorAction SilentlyContinue) -ne $null",
      ],
      { timeout: 5000, windowsHide: true },
    );
    return stdout.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

/**
 * Nudge monitors awake (ScrollLock toggle). Does not unlock a locked session.
 */
export async function wakeDisplays(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "Add-Type -AssemblyName System.Windows.Forms;",
          "[System.Windows.Forms.SendKeys]::SendWait('{SCROLLLOCK}');",
          "Start-Sleep -Milliseconds 80;",
          "[System.Windows.Forms.SendKeys]::SendWait('{SCROLLLOCK}');",
        ].join(" "),
      ],
      { timeout: 5000, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

/** Ensure the desktop is unlocked and try to wake displays before /ss. */
export async function prepareForScreenshot(): Promise<DisplayState> {
  if (process.platform !== "win32") {
    return { locked: false, woke: false };
  }
  const locked = await isWorkstationLocked();
  if (locked) {
    return {
      locked: true,
      woke: false,
      detail:
        "Windows session is locked. Unlock the PC, then retry /ss or /sshq.",
    };
  }
  const woke = await wakeDisplays();
  if (woke) {
    await new Promise((r) => setTimeout(r, 350));
  }
  return { locked: false, woke, detail: woke ? "Displays nudged awake" : undefined };
}
