import { waitForOfflineThenOnline } from "./tcp-reachability-monitor.js";

export interface ScopeSleepRuntime {
  suspendForSleep(): Promise<void>;
  resumeAfterSleep(): void;
}

export interface ScopePowerControl {
  sleep(): Promise<void>;
}

export type ScopeWakeWaiter = (
  host: string,
  port: number,
  signal: AbortSignal,
) => Promise<boolean>;

export class ScopePowerLifecycle {
  private wakeMonitor: AbortController | null = null;
  private sleeping = false;

  public constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly runtime: ScopeSleepRuntime,
    private readonly powerControl: ScopePowerControl,
    private readonly waitForWake: ScopeWakeWaiter = waitForOfflineThenOnline,
  ) {}

  public async sleep(): Promise<void> {
    if (this.sleeping) {
      throw new Error("DHO804 is already sleeping");
    }

    this.sleeping = true;
    try {
      await this.runtime.suspendForSleep();
      await this.powerControl.sleep();
      this.startWakeMonitor();
    } catch (error) {
      this.sleeping = false;
      this.runtime.resumeAfterSleep();
      throw error;
    }
  }

  public close(): void {
    this.wakeMonitor?.abort();
    this.wakeMonitor = null;
  }

  private startWakeMonitor(): void {
    const controller = new AbortController();
    this.wakeMonitor = controller;

    void this.waitForWake(this.host, this.port, controller.signal).then((woke) => {
      if (controller.signal.aborted || this.wakeMonitor !== controller) {
        return;
      }

      this.wakeMonitor = null;
      this.sleeping = false;
      if (woke) {
        console.log("[DHO804 sleep] SCPI endpoint reachable after physical wake; resuming runtime");
      }
      this.runtime.resumeAfterSleep();
    }).catch((error: unknown) => {
      if (controller.signal.aborted || this.wakeMonitor !== controller) {
        return;
      }

      this.wakeMonitor = null;
      this.sleeping = false;
      console.error("DHO804 physical-wake monitor failed", error);
      this.runtime.resumeAfterSleep();
    });
  }
}
