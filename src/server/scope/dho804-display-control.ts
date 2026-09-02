import { execFile } from "node:child_process";

export interface AdbCommandResult {
  stdout: string;
  stderr: string;
}

export type AdbRunner = (args: readonly string[]) => Promise<AdbCommandResult>;
export type DisplayControlLogger = (message: string) => void;
export type Delay = (milliseconds: number) => Promise<void>;

const ADB_TIMEOUT_MS = 5_000;
const ANDROID_KEYCODE_SLEEP = "223";
const ANDROID_KEYCODE_WAKEUP = "224";
const RIGOL_PANEL_POWER_KEYCODE = "1073741851";
const RIGOL_SLEEP_RESOURCE_ID = "com.rigol.scope:id/button_sleep";
const UI_DUMP_PATH = "/sdcard/rigol-web-window.xml";
const POWER_POPUP_SETTLE_MS = 300;

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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
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

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findResourceCentre(xml: string, resourceId: string): { x: number; y: number } {
  const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
  const node = nodes.find((candidate) => candidate.includes(`resource-id="${resourceId}"`));
  if (node === undefined) {
    throw new Error(`Rigol sleep control ${resourceId} was not found in the UI hierarchy`);
  }

  const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (bounds === null) {
    throw new Error(`Rigol sleep control ${resourceId} has no usable bounds`);
  }

  const [, left, top, right, bottom] = bounds;
  return {
    x: Math.round((Number(left) + Number(right)) / 2),
    y: Math.round((Number(top) + Number(bottom)) / 2),
  };
}

export class Dho804DisplayControl {
  public constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly adb: AdbRunner = runAdb,
    private readonly log: DisplayControlLogger = console.log,
    private readonly wait: Delay = delay,
  ) {}

  public screenOff(): Promise<void> {
    return this.sendKeyEvent(ANDROID_KEYCODE_SLEEP);
  }

  public screenOn(): Promise<void> {
    return this.sendKeyEvent(ANDROID_KEYCODE_WAKEUP);
  }

  public async sleep(): Promise<void> {
    const target = adbTarget(this.host, this.port);
    await this.ensureConnected(target);
    await this.sendConnectedKeyEvent(target, RIGOL_PANEL_POWER_KEYCODE);
    await this.wait(POWER_POPUP_SETTLE_MS);

    await this.adb(["-s", target, "shell", "uiautomator", "dump", UI_DUMP_PATH]);
    const hierarchy = await this.adb(["-s", target, "shell", "cat", UI_DUMP_PATH]);
    const sleepButton = findResourceCentre(hierarchy.stdout, RIGOL_SLEEP_RESOURCE_ID);

    await this.adb([
      "-s",
      target,
      "shell",
      "input",
      "tap",
      String(sleepButton.x),
      String(sleepButton.y),
    ]);
    this.log(`[DHO804 sleep] clicked native Rigol Sleep control at ${sleepButton.x},${sleepButton.y}`);
  }

  public async wake(): Promise<void> {
    const attempts = [
      { label: "Rigol panel power key", keyCode: RIGOL_PANEL_POWER_KEYCODE },
      { label: "Android KEYCODE_WAKEUP", keyCode: ANDROID_KEYCODE_WAKEUP },
    ];
    const failures: string[] = [];

    for (const attempt of attempts) {
      try {
        await this.sendKeyEvent(attempt.keyCode);
        this.log(`[DHO804 wake] ${attempt.label}: command succeeded`);
      } catch (error) {
        const detail = errorDetail(error);
        failures.push(`${attempt.label}: ${detail}`);
        this.log(`[DHO804 wake] ${attempt.label}: failed: ${detail}`);
      }
    }

    try {
      const target = adbTarget(this.host, this.port);
      await this.ensureConnected(target);
      const powerState = await this.adb(["-s", target, "shell", "dumpsys", "power"]);
      const wakefulness = powerState.stdout.match(/mWakefulness=([^\s]+)/)?.[1] ?? "unknown";
      this.log(`[DHO804 wake] power-state probe after attempts: ${wakefulness}`);
    } catch (error) {
      this.log(`[DHO804 wake] power-state probe failed: ${errorDetail(error)}`);
    }

    if (failures.length === attempts.length) {
      throw new Error(`All DHO804 wake attempts failed: ${failures.join("; ")}`);
    }
  }

  private async sendKeyEvent(keyCode: string): Promise<void> {
    const target = adbTarget(this.host, this.port);
    await this.ensureConnected(target);
    await this.sendConnectedKeyEvent(target, keyCode);
  }

  private async ensureConnected(target: string): Promise<void> {
    const connection = await this.adb(["connect", target]);
    const connectionOutput = `${connection.stdout}\n${connection.stderr}`;
    if (!/\b(?:already )?connected to\b/i.test(connectionOutput)) {
      throw new Error(`ADB did not connect to ${target}: ${connectionOutput.trim() || "no response"}`);
    }
  }

  private async sendConnectedKeyEvent(target: string, keyCode: string): Promise<void> {
    await this.adb([
      "-s",
      target,
      "shell",
      "input",
      "keyevent",
      keyCode,
    ]);
  }
}
