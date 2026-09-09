import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  type DmmControlChange,
  type DmmRange,
  type DmmState,
} from "../../shared/dmm-types.js";
import type { DmmBinding } from "./dmm-binding.js";
import { DmmBrowserConnectionKind, useDmmStore } from "./dmm-store.js";

export type DmmActionBinding = Pick<DmmBinding, "setDmmControl">;

export class DmmActions {
  public constructor(private readonly binding: DmmActionBinding) {}

  public setFunction(value: DmmMeasurementFunction): Promise<void> {
    return this.applyControl({
      kind: DmmControlKind.Function,
      value,
    });
  }

  public setRange(value: DmmRange): Promise<void> {
    const connection = useDmmStore.getState().connection;
    if (
      connection.kind !== DmmBrowserConnectionKind.Connected ||
      connection.state.range === null
    ) {
      return Promise.resolve();
    }

    return this.applyControl({
      kind: DmmControlKind.Range,
      function: connection.state.function,
      value,
    });
  }

  public setAcquisitionRate(value: DmmAcquisitionRate): Promise<void> {
    const connection = useDmmStore.getState().connection;
    if (
      connection.kind !== DmmBrowserConnectionKind.Connected ||
      connection.state.acquisitionRate === null
    ) {
      return Promise.resolve();
    }

    return this.applyControl({
      kind: DmmControlKind.AcquisitionRate,
      function: connection.state.function,
      value,
    });
  }

  private async applyControl(control: DmmControlChange): Promise<void> {
    const store = useDmmStore.getState();
    if (store.connection.kind !== DmmBrowserConnectionKind.Connected) {
      return;
    }
    if (dmmControlMatchesState(store.connection.state, control)) {
      return;
    }

    const ownership = store.beginControl(control);
    try {
      await this.binding.setDmmControl(control);
      useDmmStore.getState().finishControl(ownership);
    } catch (error) {
      useDmmStore.getState().failControl(
        ownership,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export function dmmControlMatchesState(
  state: DmmState,
  control: DmmControlChange,
): boolean {
  switch (control.kind) {
    case DmmControlKind.Function:
      return state.function === control.value;
    case DmmControlKind.Range:
      return control.function === state.function &&
        state.range !== null &&
        sameRange(state.range, control.value);
    case DmmControlKind.AcquisitionRate:
      return control.function === state.function &&
        state.acquisitionRate === control.value;
  }
}

function sameRange(left: DmmRange, right: DmmRange): boolean {
  if (left.mode !== right.mode) {
    return false;
  }
  if (left.mode === DmmRangeMode.Auto || right.mode === DmmRangeMode.Auto) {
    return true;
  }
  return left.value === right.value;
}
