import { describe, expect, it, vi } from "vitest";

import { Dho804PowerControl, type AdbRunner } from "./dho804-power-control.js";

describe("Dho804PowerControl", () => {
  it("connects to the configured DHO ADB endpoint and sends KEYCODE_SLEEP", async () => {
    const adb = vi.fn<AdbRunner>(async (args) => ({
      stdout: args[0] === "connect" ? "connected to 192.168.1.8:55555\n" : "",
      stderr: "",
    }));
    const control = new Dho804PowerControl("192.168.1.8", 55_555, adb);

    await control.sleep();

    expect(adb.mock.calls.map(([args]) => args)).toEqual([
      ["connect", "192.168.1.8:55555"],
      ["-s", "192.168.1.8:55555", "shell", "input", "keyevent", "223"],
    ]);
  });

  it("accepts an existing ADB connection", async () => {
    const adb = vi.fn<AdbRunner>(async () => ({
      stdout: "already connected to 192.168.1.8:55555\n",
      stderr: "",
    }));
    const control = new Dho804PowerControl("192.168.1.8", 55_555, adb);

    await expect(control.sleep()).resolves.toBeUndefined();
    expect(adb).toHaveBeenCalledTimes(2);
  });

  it("does not send the sleep key if ADB did not connect", async () => {
    const adb = vi.fn<AdbRunner>(async () => ({
      stdout: "failed to connect to 192.168.1.8:55555\n",
      stderr: "",
    }));
    const control = new Dho804PowerControl("192.168.1.8", 55_555, adb);

    await expect(control.sleep()).rejects.toThrow("ADB did not connect");
    expect(adb).toHaveBeenCalledTimes(1);
  });
});
