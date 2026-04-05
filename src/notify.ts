import { execFile } from "node:child_process";
import type { NotificationSettings } from "./config.js";
import { t } from "./i18n/index.js";

/**
 * Send notifications to alert the user that the pipeline is waiting
 * for input.  Fires bell and/or desktop notification based on settings.
 * All errors are silently swallowed — notifications must never block
 * or break the prompt flow.
 */
export function notifyInputWaiting(
  settings: NotificationSettings,
  message: string,
): void {
  if (settings.bell) {
    emitBell();
  }
  if (settings.desktop) {
    sendDesktopNotification(message);
  }
}

/** Emit the BEL character (\x07) to stdout. */
function emitBell(): void {
  try {
    process.stdout.write("\x07");
  } catch {
    // Ignore — stdout may be closed or not writable.
  }
}

/** Send a desktop notification using platform-native commands. */
function sendDesktopNotification(message: string): void {
  try {
    const title = t()["notification.title"];
    if (process.platform === "darwin") {
      execFile("osascript", [
        "-e",
        `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
      ]);
    } else if (process.platform === "linux") {
      execFile("notify-send", [title, message]);
    }
  } catch {
    // Silently ignore — command may not exist, no GUI session, etc.
  }
}

/** Escape double quotes and backslashes for AppleScript string literals. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export { emitBell as _emitBell, sendDesktopNotification as _sendDesktop };
