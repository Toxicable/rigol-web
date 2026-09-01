import { SupportedInstrument } from "../../shared/instrument-types.js";

export interface InstrumentEndpoint {
  host: string;
  port: number;
}

export interface InstrumentRuntime {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  subscriberAdded?(): void | Promise<void>;
}

interface InstrumentEntry {
  endpoint: InstrumentEndpoint;
  runtime: InstrumentRuntime;
  subscribers: Set<object>;
  running: boolean;
  revision: number;
  transition: Promise<void>;
}

export interface InstrumentRegistration {
  endpoint: InstrumentEndpoint;
  runtime: InstrumentRuntime;
}

export interface InstrumentRegistrations {
  dho804: InstrumentRegistration;
  dm858e: InstrumentRegistration;
}

function validateEndpoint(name: string, endpoint: InstrumentEndpoint): void {
  if (endpoint.host.trim().length === 0) {
    throw new Error(`${name} host must be a non-empty string`);
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
    throw new Error(`${name} port must be an integer from 1 through 65535`);
  }
}

function debugLifecycle(
  event: string,
  instrument: SupportedInstrument,
  entry: InstrumentEntry,
): void {
  console.debug(`[SCPI] instrument ${event}`, {
    instrument,
    subscribers: entry.subscribers.size,
    running: entry.running,
    revision: entry.revision,
    host: entry.endpoint.host,
    port: entry.endpoint.port,
  });
}

export class InstrumentRegistry {
  private readonly entries: Map<SupportedInstrument, InstrumentEntry>;

  public constructor(registrations: InstrumentRegistrations) {
    validateEndpoint("DHO804", registrations.dho804.endpoint);
    validateEndpoint("DM858E", registrations.dm858e.endpoint);

    this.entries = new Map([
      [SupportedInstrument.Dho804, this.createEntry(registrations.dho804)],
      [SupportedInstrument.Dm858e, this.createEntry(registrations.dm858e)],
    ]);
  }

  public isSubscribed(session: object, instrument: SupportedInstrument): boolean {
    return this.entry(instrument).subscribers.has(session);
  }

  public endpoint(instrument: SupportedInstrument): InstrumentEndpoint {
    return this.entry(instrument).endpoint;
  }

  public async subscribe(session: object, instrument: SupportedInstrument): Promise<void> {
    const entry = this.entry(instrument);
    if (entry.subscribers.has(session)) {
      await entry.transition;
      return;
    }

    entry.subscribers.add(session);
    entry.revision += 1;
    debugLifecycle("subscribe", instrument, entry);

    try {
      await this.queueReconcile(instrument, entry);
      if (entry.subscribers.has(session)) {
        await entry.runtime.subscriberAdded?.();
      }
    } catch (error) {
      if (entry.subscribers.delete(session)) {
        entry.revision += 1;
        debugLifecycle("subscribe-rollback", instrument, entry);
        await this.queueReconcile(instrument, entry).catch(() => undefined);
      }
      throw error;
    }
  }

  public unsubscribe(session: object, instrument: SupportedInstrument): Promise<void> {
    const entry = this.entry(instrument);
    if (!entry.subscribers.delete(session)) {
      return entry.transition;
    }

    entry.revision += 1;
    debugLifecycle("unsubscribe", instrument, entry);
    return this.queueReconcile(instrument, entry);
  }

  public async releaseSession(session: object): Promise<void> {
    const transitions: Promise<void>[] = [];
    for (const [instrument, entry] of this.entries) {
      if (!entry.subscribers.delete(session)) {
        continue;
      }
      entry.revision += 1;
      debugLifecycle("release-session", instrument, entry);
      transitions.push(this.queueReconcile(instrument, entry));
    }
    await Promise.all(transitions);
  }

  public async stopAll(): Promise<void> {
    const transitions: Promise<void>[] = [];
    for (const [instrument, entry] of this.entries) {
      entry.subscribers.clear();
      entry.revision += 1;
      debugLifecycle("stop-all", instrument, entry);
      transitions.push(this.queueReconcile(instrument, entry));
    }
    await Promise.all(transitions);
  }

  private createEntry(registration: InstrumentRegistration): InstrumentEntry {
    return {
      endpoint: registration.endpoint,
      runtime: registration.runtime,
      subscribers: new Set(),
      running: false,
      revision: 0,
      transition: Promise.resolve(),
    };
  }

  private entry(instrument: SupportedInstrument): InstrumentEntry {
    const entry = this.entries.get(instrument);
    if (entry === undefined) {
      throw new Error(`Unsupported instrument ${instrument}`);
    }
    return entry;
  }

  private queueReconcile(
    instrument: SupportedInstrument,
    entry: InstrumentEntry,
  ): Promise<void> {
    const transition = entry.transition.then(
      () => this.reconcile(instrument, entry),
      () => this.reconcile(instrument, entry),
    );
    entry.transition = transition.catch(() => undefined);
    return transition;
  }

  private async reconcile(
    instrument: SupportedInstrument,
    entry: InstrumentEntry,
  ): Promise<void> {
    while (true) {
      const revision = entry.revision;
      const shouldRun = entry.subscribers.size > 0;

      if (shouldRun && !entry.running) {
        debugLifecycle("runtime-start", instrument, entry);
        await entry.runtime.start();
        entry.running = true;
        debugLifecycle("runtime-started", instrument, entry);
      } else if (!shouldRun && entry.running) {
        entry.running = false;
        debugLifecycle("runtime-stop", instrument, entry);
        await entry.runtime.stop();
        debugLifecycle("runtime-stopped", instrument, entry);
      }

      if (revision === entry.revision) {
        return;
      }
    }
  }
}
