import { execFile } from "node:child_process";

export interface AdbCommandResult {
  stdout: string;
  stderr: string;
}

export type AdbRunner = (args: readonly string[]) => Promise<AdbCommandResult>;

const ADB_TIMEOUT_MS = 5_000;
const ANDROID_KEYCODE_SLEEP = "223";

function runAdb(args: readonly string[]): Promise<AdbCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "adb",
      [...args],
      { encoding: "utf8", timeout: ADB_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`adb ${args.join(" ")} failed: ${error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function adbTarget(host: string, port: number): string {
  const normalizedHost = host.trim();
  if (normalizedHost.startsWith("[") && normalizedHost.endsWith("]")) {
    return `${normalizedHost}:${port}`;
  }
  if (normalizedHost.includes(":")) {
    return `[${normalizedHost}]:${port}`;
  }
  return `${normalizedHost}:${port}`;
}

export class Dho804PowerControl {
  public constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly adb: AdbRunner = runAdb,
  ) {}

  public async sleep(): Promise<void> {
    const target = adbTarget(this.host, this.port);
    const connection = await this.adb(["connect", target]);
    const connectionOutput = `${connection.stdout}\n${connection.stderr}`;
    if (!/\b(?:already )?connected to\b/i.test(connectionOutput)) {
      throw new Error(`ADB did not connect to ${target}: ${connectionOutput.trim() || "no response"}`);
    }

    await this.adb([
      "-s",
      target,
      "shell",
      "input",
      "keyevent",
      ANDROID_KEYCODE_SLEEP,
    ]);
  }
}
