import { describe, expect, it, vi } from "vitest";

import { Dho804DisplayControl, type AdbRunner } from "./dho804-display-control.js";

const TARGET = "192.168.1.8:55555";

function connectedAdb(): ReturnType<typeof vi.fn<AdbRunner>> {
  return vi.fn<AdbRunner>(async (args) => ({
    stdout: args[0] === "connect" ? `connected to ${TARGET}\n` : "",
    stderr: "",
  }));
}

describe("Dho804DisplayControl", () => {
  it("connects to the configured DHO ADB endpoint and sends KEYCODE_SLEEP for screen off", async () => {
    const adb = connectedAdb();
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb);

    await control.screenOff();

    expect(adb.mock.calls.map(([args]) => args)).toEqual([
      ["connect", TARGET],
      ["-s", TARGET, "shell", "input", "keyevent", "223"],
    ]);
  });

  it("connects to the configured DHO ADB endpoint and sends KEYCODE_WAKEUP for screen on", async () => {
    const adb = connectedAdb();
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb);

    await control.screenOn();

    expect(adb.mock.calls.map(([args]) => args)).toEqual([
      ["connect", TARGET],
      ["-s", TARGET, "shell", "input", "keyevent", "224"],
    ]);
  });

  it("opens the Rigol power popup and clicks its native Sleep button", async () => {
    const adb = vi.fn<AdbRunner>(async (args) => {
      if (args[0] === "connect") {
        return { stdout: `connected to ${TARGET}\n`, stderr: "" };
      }
      if (args.includes("cat")) {
        return {
          stdout: '<hierarchy><node text="Sleep" resource-id="com.rigol.scope:id/button_sleep" bounds="[80,460][300,540]" /></hierarchy>',
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const log = vi.fn();
    const noWait = vi.fn(async () => undefined);
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb, log, noWait);

    await control.sleep();

    expect(noWait).toHaveBeenCalledWith(300);
    expect(adb.mock.calls.map(([args]) => args)).toEqual([
      ["connect", TARGET],
      ["-s", TARGET, "shell", "input", "keyevent", "1073741851"],
      ["-s", TARGET, "shell", "uiautomator", "dump", "/sdcard/rigol-web-window.xml"],
      ["-s", TARGET, "shell", "cat", "/sdcard/rigol-web-window.xml"],
      ["-s", TARGET, "shell", "input", "tap", "190", "500"],
    ]);
    expect(log).toHaveBeenCalledWith("[DHO804 sleep] clicked native Rigol Sleep control at 190,500");
  });

  it("does not tap an arbitrary location when the native Sleep control is missing", async () => {
    const adb = vi.fn<AdbRunner>(async (args) => ({
      stdout: args[0] === "connect"
        ? `connected to ${TARGET}\n`
        : args.includes("cat")
          ? "<hierarchy></hierarchy>"
          : "",
      stderr: "",
    }));
    const control = new Dho804DisplayControl(
      "192.168.1.8",
      55_555,
      adb,
      vi.fn(),
      async () => undefined,
    );

    await expect(control.sleep()).rejects.toThrow("was not found in the UI hierarchy");
    expect(adb.mock.calls.some(([args]) => args.includes("tap"))).toBe(false);
  });

  it("attempts both wake methods and logs their command results plus power state", async () => {
    const adb = vi.fn<AdbRunner>(async (args) => {
      if (args[0] === "connect") {
        return { stdout: `connected to ${TARGET}\n`, stderr: "" };
      }
      if (args.at(-1) === "1073741851") {
        throw new Error("panel-key injection failed");
      }
      if (args.includes("dumpsys")) {
        return { stdout: "Power Manager State:\n  mWakefulness=Awake\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const log = vi.fn();
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb, log);

    await expect(control.wake()).resolves.toBeUndefined();

    expect(adb.mock.calls.map(([args]) => args)).toEqual([
      ["connect", TARGET],
      ["-s", TARGET, "shell", "input", "keyevent", "1073741851"],
      ["connect", TARGET],
      ["-s", TARGET, "shell", "input", "keyevent", "224"],
      ["connect", TARGET],
      ["-s", TARGET, "shell", "dumpsys", "power"],
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Rigol panel power key: failed"));
    expect(log).toHaveBeenCalledWith("[DHO804 wake] Android KEYCODE_WAKEUP: command succeeded");
    expect(log).toHaveBeenCalledWith("[DHO804 wake] power-state probe after attempts: Awake");
  });

  it("fails wake only after both wake methods have been attempted", async () => {
    const adb = vi.fn<AdbRunner>(async (args) => {
      if (args[0] === "connect") {
        return { stdout: `connected to ${TARGET}\n`, stderr: "" };
      }
      throw new Error(`failed ${args.at(-1)}`);
    });
    const log = vi.fn();
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb, log);

    await expect(control.wake()).rejects.toThrow("All DHO804 wake attempts failed");
    expect(adb.mock.calls.map(([args]) => args).filter((args) => args.includes("keyevent"))).toEqual([
      ["-s", TARGET, "shell", "input", "keyevent", "1073741851"],
      ["-s", TARGET, "shell", "input", "keyevent", "224"],
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Rigol panel power key: failed"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Android KEYCODE_WAKEUP: failed"));
  });

  it("accepts an existing ADB connection", async () => {
    const adb = vi.fn<AdbRunner>(async () => ({
      stdout: `already connected to ${TARGET}\n`,
      stderr: "",
    }));
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb);

    await expect(control.screenOff()).resolves.toBeUndefined();
    expect(adb).toHaveBeenCalledTimes(2);
  });

  it("does not send a key event if ADB did not connect", async () => {
    const adb = vi.fn<AdbRunner>(async () => ({
      stdout: `failed to connect to ${TARGET}\n`,
      stderr: "",
    }));
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb);

    await expect(control.screenOn()).rejects.toThrow("ADB did not connect");
    expect(adb).toHaveBeenCalledTimes(1);
  });
});
