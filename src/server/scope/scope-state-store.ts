import type { ScopeState } from "../../shared/scope-types.js";

export type ScopeStateListener = (state: ScopeState) => void;

export class ScopeStateStore {
  private state: ScopeState;
  private readonly listeners = new Set<ScopeStateListener>();

  public constructor(initialState: ScopeState) {
    this.state = initialState;
  }

  public getState(): ScopeState {
    return this.state;
  }

  public replaceState(state: ScopeState): void {
    if (Object.is(this.state, state)) {
      return;
    }

    this.state = state;

    for (const listener of this.listeners) {
      listener(state);
    }
  }

  public update(updater: (state: ScopeState) => ScopeState): void {
    this.replaceState(updater(this.state));
  }

  public subscribe(listener: ScopeStateListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
}
