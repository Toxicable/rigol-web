import type { ScopeControllerDriver } from "./scope-controller.js";
import { ScopeController } from "./scope-controller.js";

const BACKGROUND_PRIORITY = 4 as const;
const DEFAULT_POLL_PERIOD_MS = 1_000;

export class ScopePoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private cycleInFlight = false;

  public constructor(
    private readonly driver: Pick<ScopeControllerDriver, "readScopeState">,
    private readonly controller: ScopeController,
    private readonly onError: (error: unknown) => void,
    private readonly periodMs = DEFAULT_POLL_PERIOD_MS,
  ) {
    if (!Number.isFinite(periodMs) || periodMs <= 0) {
      throw new Error("Poll period must be greater than zero");
    }
  }

  public start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce().catch(this.onError);
    }, this.periodMs);
  }

  public stop(): void {
    if (this.timer === undefined) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  public async runOnce(): Promise<boolean> {
    if (this.cycleInFlight) {
      return false;
    }

    this.cycleInFlight = true;
    const revision = this.controller.getMutationRevision();

    try {
      const state = await this.driver.readScopeState(BACKGROUND_PRIORITY);
      return this.controller.applyPolledState(state, revision);
    } finally {
      this.cycleInFlight = false;
    }
  }
}
