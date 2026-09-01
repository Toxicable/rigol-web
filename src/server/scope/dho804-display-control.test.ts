import { describe, expect, it, vi } from "vitest";

import { Dho804DisplayControl, type AdbRunner } from "./dho804-display-control.js";

describe("Dho804DisplayControl", () => {
  it("connects to the configured DHO ADB endpoint and sends KEYCODE_SLEEP for screen off", async () => {
    const adb = vi.fn<AdbRunner>(async (args) => ({
      stdout: args[0] === "connect" ? "connected to 192.168.1.8:55555\n" : "",
      stderr: "",
    }));
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb);

    await control.screenOff();

    expect(adb.mock.calls.map(([args]) => args)).toEqual([
      ["connect", "192.168.1.8:55555"],
      ["-s", "192.168.1.8:55555", "shell", "input", "keyevent", "223"],
    ]);
  });

  it("connects to the configured DHO ADB endpoint and sends KEYCODE_WAKEUP for screen on", async () => {
    const adb = vi.fn<AdbRunner>(async (args) => ({
      stdout: args[0] === "connect" ? "connected to 192.168.1.8:55555\n" : "",
      stderr: "",
    }));
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb);

    await control.screenOn();

    expect(adb.mock.calls.map(([args]) => args)).toEqual([
      ["connect", "192.168.1.8:55555"],
      ["-s", "192.168.1.8:55555", "shell", "input", "keyevent", "224"],
    ]);
  });

  it("accepts an existing ADB connection", async () => {
    const adb = vi.fn<AdbRunner>(async () => ({
      stdout: "already connected to 192.168.1.8:55555\n",
      stderr: "",
    }));
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb);

    await expect(control.screenOff()).resolves.toBeUndefined();
    expect(adb).toHaveBeenCalledTimes(2);
  });

  it("does not send a key event if ADB did not connect", async () => {
    const adb = vi.fn<AdbRunner>(async () => ({
      stdout: "failed to connect to 192.168.1.8:55555\n",
      stderr: "",
    }));
    const control = new Dho804DisplayControl("192.168.1.8", 55_555, adb);

    await expect(control.screenOn()).rejects.toThrow("ADB did not connect");
    expect(adb).toHaveBeenCalledTimes(1);
  });
});
