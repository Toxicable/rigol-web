import {
  DmmReadingKind,
  type DmmReadingSnapshot,
} from "../../shared/dmm-types.js";
import { ScpiPriority } from "../scpi/scpi-scheduler.js";
import type { Dm858eDriver } from "./dm858e-driver.js";
import type { DmmStateStore } from "./dmm-state-store.js";

const DEFAULT_READING_INTERVAL_MS = 100;
const DEFAULT_STATE_INTERVAL_MS = 500;

export interface DmmPollerOptions {
  driver: Dm858eDriver;
  stateStore: DmmStateStore;
  publishSnapshot: (snapshot: DmmReadingSnapshot) => void;
  reportError: (error: unknown) => void;
  readingIntervalMs?: number;
  stateIntervalMs?: number;
}

export class DmmPoller {
  private readonly driver: Dm858eDriver;
  private readonly stateStore: DmmStateStore;
  private readonly publishSnapshot: DmmPollerOptions["publishSnapshot"];
  private readonly reportError: DmmPollerOptions["reportError"];
  private readonly readingIntervalMs: number;
  private readonly stateIntervalMs: number;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeDelay: (() => void) | null = null;
  private lastSnapshot: DmmReadingSnapshot | null = null;

  public constructor(options: DmmPollerOptions) {
    validateInterval(options.readingIntervalMs ?? DEFAULT_READING_INTERVAL_MS, "readingIntervalMs");
    validateInterval(options.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS, "stateIntervalMs");

    this.driver = options.driver;
    this.stateStore = options.stateStore;
    this.publishSnapshot = options.publishSnapshot;
    this.reportError = options.reportError;
    this.readingIntervalMs = options.readingIntervalMs ?? DEFAULT_READING_INTERVAL_MS;
    this.stateIntervalMs = options.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  public stop(): void {
    this.running = false;
    this.wakeDelayNow();
  }

  public async waitForIdle(): Promise<void> {
    const loop = this.loopPromise;
    if (loop !== null) {
      await loop;
    }
    this.loopPromise = null;
  }

  private async runLoop(): Promise<void> {
    let nextStateReadAt = performance.now();

    while (this.running) {
      try {
        if (performance.now() >= nextStateReadAt) {
          const state = await this.driver.readDmmState(ScpiPriority.Background);
          if (!this.running) {
            break;
          }
          this.stateStore.replaceState(state);
          nextStateReadAt = performance.now() + this.stateIntervalMs;
        }

        const state = this.stateStore.getState();
        if (this.lastSnapshot !== null && this.lastSnapshot.function !== state.function) {
          this.lastSnapshot = null;
        }
        const snapshot = await this.driver.readPrimarySnapshot(
          state.function,
          ScpiPriority.Background,
        );
        if (!this.running) {
          break;
        }
        if (snapshot !== null && !sameSnapshot(snapshot, this.lastSnapshot)) {
          this.lastSnapshot = snapshot;
          this.publishSnapshot(snapshot);
        }
      } catch (error) {
        if (this.running) {
          this.reportError(error);
        }
        return;
      }

      await this.waitDelay(this.readingIntervalMs);
    }
  }

  private waitDelay(delayMs: number): Promise<void> {
    if (!this.running || delayMs === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (this.delayTimer !== null) {
          clearTimeout(this.delayTimer);
          this.delayTimer = null;
        }
        this.wakeDelay = null;
        resolve();
      };

      this.wakeDelay = finish;
      this.delayTimer = setTimeout(finish, delayMs);
    });
  }

  private wakeDelayNow(): void {
    const wake = this.wakeDelay;
    this.wakeDelay = null;
    wake?.();
  }
}

function sameSnapshot(
  left: DmmReadingSnapshot,
  right: DmmReadingSnapshot | null,
): boolean {
  if (
    right === null ||
    left.kind !== right.kind ||
    left.function !== right.function ||
    left.unit !== right.unit
  ) {
    return false;
  }

  switch (left.kind) {
    case DmmReadingKind.Value:
      return right.kind === DmmReadingKind.Value && left.value === right.value;
    case DmmReadingKind.Overload:
      return right.kind === DmmReadingKind.Overload;
    case DmmReadingKind.Unavailable:
      return right.kind === DmmReadingKind.Unavailable && left.reason === right.reason;
  }
}

function validateInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}
