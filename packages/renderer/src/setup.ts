import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Downloads the Chromium headless shell matching the bundled playwright-core version. */
export async function installChromium(log: (line: string) => void = (l) => process.stderr.write(l + "\n")): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = require.resolve("playwright-core/cli.js");
  await new Promise<void>((res, rej) => {
    const child = spawn(process.execPath, [cli, "install", "chromium-headless-shell"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => log(d.toString().trimEnd()));
    child.stderr.on("data", (d: Buffer) => log(d.toString().trimEnd()));
    child.on("error", rej);
    child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`Chromium install exited with code ${code}`))));
  });
}

export async function checkFfmpeg(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(path, ["-hide_banner", "-version"], { timeout: 10000 });
    return stdout.split("\n")[0] ?? "ffmpeg";
  } catch {
    return null;
  }
}
