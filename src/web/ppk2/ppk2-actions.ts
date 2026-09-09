import { AcquisitionOperationState } from "../../shared/acquisition-types.js";
import type { Ppk2Binding } from "./ppk2-binding.js";
import { usePpk2Store } from "./ppk2-store.js";

const HISTORY_BUCKETS = 1_200;

export class Ppk2Actions {
  public constructor(private readonly binding: Ppk2Binding) {}

  public async startCapture(): Promise<void> {
    const store = usePpk2Store.getState();
    const current = store.stats.operation;
    if (current?.state === AcquisitionOperationState.Running) {
      throw new Error(`PPK2 acquisition ${current.id} is already running`);
    }

    const ownership = store.beginRequest("start");
    try {
      const operation = await this.binding.startCapture();
      usePpk2Store.getState().replaceOperation(operation);
      usePpk2Store.getState().finishRequest(ownership);
    } catch (error) {
      usePpk2Store.getState().failRequest(ownership, errorMessage(error));
      throw error;
    }
  }

  public async stopCapture(): Promise<void> {
    const store = usePpk2Store.getState();
    const operation = store.stats.operation;
    if (operation === null || operation.state !== AcquisitionOperationState.Running) {
      throw new Error("No running PPK2 acquisition to stop");
    }

    const ownership = store.beginRequest("stop");
    try {
      const stopped = await this.binding.stopCapture(operation.id);
      usePpk2Store.getState().replaceOperation(stopped);
      usePpk2Store.getState().finishRequest(ownership);
    } catch (error) {
      usePpk2Store.getState().failRequest(ownership, errorMessage(error));
      throw error;
    }
  }

  public async loadRetainedHistory(): Promise<void> {
    const store = usePpk2Store.getState();
    const operation = store.stats.operation;
    const latestSequence = store.stats.latestSequence;
    if (operation === null || latestSequence === null) {
      throw new Error("No retained PPK2 acquisition history is available");
    }

    const ownership = store.beginRequest("viewport");
    try {
      const viewport = await this.binding.requestViewport(
        operation.id,
        0,
        latestSequence + 1,
        HISTORY_BUCKETS,
      );
      usePpk2Store.getState().replaceViewport(viewport);
      usePpk2Store.getState().finishRequest(ownership);
    } catch (error) {
      usePpk2Store.getState().failRequest(ownership, errorMessage(error));
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
