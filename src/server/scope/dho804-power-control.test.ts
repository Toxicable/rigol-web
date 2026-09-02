import { describe, expect, it, vi } from "vitest";

import {
  Dho804PowerControl,
  type AdbDispatcher,
  type AdbRunner,
} from "./dho804-power-control.js";

const TARGET = "192.168.1.8:55555";

function connectedAdb() {
  return vi.fn<AdbRunner>(async (args) => ({
    stdout: args[0] === "connect" ? `connected to ${TARGET}\n` : "",
    stderr: "",
  }));
}

function dispatcher() {
  return vi.fn<AdbDispatcher>(async () => undefined);
}

describe("Dho804PowerControl", () => {
  it("opens the Rigol power popup, waits for it to settle, then dispatches the stock Sleep tap", async () => {
    const adb = connectedAdb();
    const dispatch = dispatcher();
    const log = vi.fn();
    const noWait = vi.fn(async () => undefined);
    const control = new Dho804PowerControl("192.168.1.8", 55_555, adb, log, noWait, dispatch);

    await control.sleep();

    expect(noWait).toHaveBeenCalledWith(1_500);
    expect(adb.mock.calls.map(([args]) => args)).toEqual([
      ["connect", TARGET],
      ["-s", TARGET, "shell", "input", "keyevent", "1073741851"],
      ["connect", TARGET],
    ]);
    expect(dispatch).toHaveBeenCalledWith([
      "-s",
      TARGET,
      "shell",
      "input",
      "tap",
      "324",
      "375",
    ]);
    expect(log).toHaveBeenCalledWith("[DHO804 sleep] dispatched native Rigol Sleep control at 324,375");
  });

  it("fails sleep if the final ADB dispatch cannot be launched", async () => {
    const adb = connectedAdb();
    const dispatch = vi.fn<AdbDispatcher>(async () => {
      throw new Error("adb launch failed");
    });
    const control = new Dho804PowerControl(
      "192.168.1.8",
      55_555,
      adb,
      vi.fn(),
      async () => undefined,
      dispatch,
    );

    await expect(control.sleep()).rejects.toThrow("adb launch failed");
  });

  it("accepts an existing ADB connection", async () => {
    const adb = vi.fn<AdbRunner>(async () => ({
      stdout: `already connected to ${TARGET}\n`,
      stderr: "",
    }));
    const dispatch = dispatcher();
    const control = new Dho804PowerControl(
      "192.168.1.8",
      55_555,
      adb,
      vi.fn(),
      async () => undefined,
      dispatch,
    );

    await expect(control.sleep()).resolves.toBeUndefined();
    expect(adb).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not send a key event if ADB did not connect", async () => {
    const adb = vi.fn<AdbRunner>(async () => ({
      stdout: `failed to connect to ${TARGET}\n`,
      stderr: "",
    }));
    const dispatch = dispatcher();
    const control = new Dho804PowerControl(
      "192.168.1.8",
      55_555,
      adb,
      vi.fn(),
      async () => undefined,
      dispatch,
    );

    await expect(control.sleep()).rejects.toThrow("ADB did not connect");
    expect(adb).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
