import { openSync, mkdirSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const logPath = join(root, ".dev", "tauri-dev-background.log");
mkdirSync(dirname(logPath), { recursive: true });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const logFd = openSync(logPath, "a");
const child = spawn(npm, ["run", "tauri:dev"], {
  cwd: root,
  detached: true,
  stdio: ["ignore", logFd, logFd],
  windowsHide: true,
});

child.unref();
closeSync(logFd);

console.log(`Started Skills Manager dev server in the background. Log: ${logPath}`);
