import { ScpiPriority } from "../scpi/scpi-scheduler.js";
import type { Dm858eDriver } from "./dm858e-driver.js";
import type { DmmStateStore } from "./dmm-state-store.js";
import type { DmmPrimaryReading } from "../../shared/dmm-types.js";

const DEFAULT_READING_INTERVAL_MS = 100;
const DEFAULT_STATE_INTERVAL_MS = 500;

export interface DmmPollerOptions {
  driver: Dm858eDriver;
  stateStore: DmmStateStore;
  publishReading: (reading: DmmPrimaryReading) => void;
  reportError: (error: unknown) => void;
  readingIntervalMs?: number;
  stateIntervalMs?: number;
}

export class DmmPoller {
  private readonly driver: Dm858eDriver;
  private readonly stateStore: DmmStateStore;
  private readonly publishReading: DmmPollerOptions["publishReading"];
  private readonly reportError: DmmPollerOptions["reportError"];
  private readonly readingIntervalMs: number;
  private readonly stateIntervalMs: number;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeDelay: (() => void) | null = null;
  private sequence = 0;

  public constructor(options: DmmPollerOptions) {
    validateInterval(options.readingIntervalMs ?? DEFAULT_READING_INTERVAL_MS, "readingIntervalMs");
    validateInterval(options.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS, "stateIntervalMs");

    this.driver = options.driver;
    this.stateStore = options.stateStore;
    this.publishReading = options.publishReading;
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
          const previousRate = this.stateStore.getState().acquisitionRate;
          const state = await this.driver.readDmmState(previousRate, ScpiPriority.Background);
          if (!this.running) {
            break;
          }
          this.stateStore.replaceState(state);
          nextStateReadAt = performance.now() + this.stateIntervalMs;
        }

        const state = this.stateStore.getState();
        const reading = await this.driver.readPrimaryReading(
          state.function,
          this.sequence,
          ScpiPriority.Background,
        );
        this.sequence += 1;
        if (!this.running) {
          break;
        }
        this.publishReading(reading);
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

function validateInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}
