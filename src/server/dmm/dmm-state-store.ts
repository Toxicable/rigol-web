import {
  DmmRangeMode,
  type DmmRange,
  type DmmState,
} from "../../shared/dmm-types.js";

export type DmmStateListener = (state: DmmState) => void;

export class DmmStateStore {
  private state: DmmState;
  private readonly listeners = new Set<DmmStateListener>();

  public constructor(initialState: DmmState) {
    this.state = initialState;
  }

  public getState(): DmmState {
    return this.state;
  }

  public replaceState(state: DmmState): void {
    if (sameDmmState(this.state, state)) {
      return;
    }

    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  public subscribe(listener: DmmStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function sameDmmState(left: DmmState, right: DmmState): boolean {
  return (
    left.function === right.function &&
    sameRange(left.range, right.range) &&
    left.acquisitionRate === right.acquisitionRate
  );
}

function sameRange(left: DmmRange | null, right: DmmRange | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.mode !== right.mode) {
    return false;
  }
  if (left.mode === DmmRangeMode.Auto) {
    return true;
  }
  return right.mode === DmmRangeMode.Fixed && left.value === right.value;
}
