import { SupportedInstrument } from "../../shared/instrument-types.js";
import { isRigolScpiLoggingEnabled } from "../logging.js";

export interface InstrumentRuntime {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

interface InstrumentEntry {
  runtime: InstrumentRuntime;
  running: boolean;
  transition: Promise<void>;
}

export interface InstrumentRegistrations {
  dho804: InstrumentRuntime;
  dm858e: InstrumentRuntime;
  ppk2: InstrumentRuntime;
}

function debugLifecycle(
  event: string,
  instrument: SupportedInstrument,
  entry: InstrumentEntry,
): void {
  if (!isRigolScpiLoggingEnabled()) {
    return;
  }
  console.debug(`[runtime] instrument ${event}`, {
    instrument,
    running: entry.running,
  });
}

export class InstrumentRegistry {
  private readonly entries: Map<SupportedInstrument, InstrumentEntry>;

  public constructor(registrations: InstrumentRegistrations) {
    this.entries = new Map([
      [SupportedInstrument.Dho804, this.createEntry(registrations.dho804)],
      [SupportedInstrument.Dm858e, this.createEntry(registrations.dm858e)],
      [SupportedInstrument.Ppk2, this.createEntry(registrations.ppk2)],
    ]);
  }

  public async startAll(): Promise<void> {
    await Promise.all(
      [...this.entries].map(([instrument, entry]) =>
        this.queueTransition(instrument, entry, true),
      ),
    );
  }

  public async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries].map(([instrument, entry]) =>
        this.queueTransition(instrument, entry, false),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) {
      throw failure.reason;
    }
  }

  private createEntry(runtime: InstrumentRuntime): InstrumentEntry {
    return {
      runtime,
      running: false,
      transition: Promise.resolve(),
    };
  }

  private queueTransition(
    instrument: SupportedInstrument,
    entry: InstrumentEntry,
    shouldRun: boolean,
  ): Promise<void> {
    const transition = entry.transition.then(
      () => this.reconcile(instrument, entry, shouldRun),
      () => this.reconcile(instrument, entry, shouldRun),
    );
    entry.transition = transition.catch(() => undefined);
    return transition;
  }

  private async reconcile(
    instrument: SupportedInstrument,
    entry: InstrumentEntry,
    shouldRun: boolean,
  ): Promise<void> {
    if (shouldRun === entry.running) {
      return;
    }

    if (shouldRun) {
      debugLifecycle("runtime-start", instrument, entry);
      await entry.runtime.start();
      entry.running = true;
      debugLifecycle("runtime-started", instrument, entry);
      return;
    }

    debugLifecycle("runtime-stop", instrument, entry);
    await entry.runtime.stop();
    entry.running = false;
    debugLifecycle("runtime-stopped", instrument, entry);
  }
}
