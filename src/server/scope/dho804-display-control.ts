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
const RIGOL_SLEEP_TAP_X = "324";
const RIGOL_SLEEP_TAP_Y = "375";
const POWER_POPUP_SETTLE_MS = 500;

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

    // The stock DHO800 power popup is 560x270 dp centred on the fixed
    // 1024x600 instrument UI. Its 110x35 dp Sleep button is centred in the
    // left third, placing the button centre at approximately (324, 375).
    // A real DHO804 framebuffer capture confirmed the popup geometry.
    await this.adb([
      "-s",
      target,
      "shell",
      "input",
      "tap",
      RIGOL_SLEEP_TAP_X,
      RIGOL_SLEEP_TAP_Y,
    ]);
    this.log(`[DHO804 sleep] clicked native Rigol Sleep control at ${RIGOL_SLEEP_TAP_X},${RIGOL_SLEEP_TAP_Y}`);
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
