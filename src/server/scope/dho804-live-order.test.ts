import { describe, expect, it } from "vitest";

import { Channel } from "../../shared/scope-types.js";
import {
  ScpiOperationKind,
  ScpiPriority,
  type ScpiOperation,
  type ScpiOperationRecorder,
  type ScpiScheduler,
} from "../scpi/scpi-scheduler.js";
import type { ScpiTransport } from "../scpi/scpi-transport.js";
import { Dho804Driver } from "./dho804-driver.js";

function createDriver(calls: string[]): Dho804Driver {
  const transport = {
    command: async (command: string): Promise<void> => {
      calls.push(command);
    },
    queryText: async (command: string): Promise<string> => {
      calls.push(command);
      if (command === ":WAVeform:PREamble?") {
        return "0,0,2,1,1e-6,0,0,0.5,10,0";
      }
      if (command === ":CHANnel1:UNITs?") {
        return "VOLT";
      }
      throw new Error(`Unexpected text query ${command}`);
    },
    queryBinary: async (command: string): Promise<Uint8Array> => {
      calls.push(command);
      return Uint8Array.from([10, 12]);
    },
  } as unknown as ScpiTransport;
  const recorder: ScpiOperationRecorder = { addBinaryBytes: () => undefined };
  const execute = <T>(operation: ScpiOperation<T>): Promise<T> => operation.execute(transport, recorder);
  const scheduler = {
    schedule: execute,
    scheduleLatest: <T>(
      _priority: ScpiPriority,
      _key: unknown,
      _kind: ScpiOperationKind,
      run: ScpiOperation<T>["execute"],
    ) => run(transport, recorder),
    scheduleInteractive: <T>(
      _kind: ScpiOperationKind,
      _key: unknown,
      run: ScpiOperation<T>["execute"],
    ) => run(transport, recorder),
  } as unknown as ScpiScheduler;
  return new Dho804Driver(scheduler);
}

describe("Dho804Driver live recovery order", () => {
  it("refreshes an invalidated preamble before asking for waveform data", async () => {
    const calls: string[] = [];
    const driver = createDriver(calls);

    await driver.readLiveWaveform(Channel.Ch1, 2);
    await driver.setHorizontalPosition(0.001, ScpiPriority.Interactive);
    calls.length = 0;

    await driver.readLiveWaveform(Channel.Ch1, 2);

    const preambleIndex = calls.indexOf(":WAVeform:PREamble?");
    const dataIndex = calls.indexOf(":WAVeform:SOURce CHANnel1;:WAVeform:DATA?");
    expect(preambleIndex).toBeGreaterThanOrEqual(0);
    expect(dataIndex).toBeGreaterThan(preambleIndex);
  });
});
