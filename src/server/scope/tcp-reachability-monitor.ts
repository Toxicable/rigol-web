import { Socket } from "node:net";

export type TcpProbe = (host: string, port: number) => Promise<boolean>;
export type ReachabilityDelay = (milliseconds: number) => Promise<void>;

const PROBE_TIMEOUT_MS = 1_000;
const RECHECK_DELAY_MS = 2_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finish = (reachable: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export async function waitForOfflineThenOnline(
  host: string,
  port: number,
  signal: AbortSignal,
  probe: TcpProbe = probeTcp,
  wait: ReachabilityDelay = delay,
): Promise<boolean> {
  let sawOffline = false;

  while (!signal.aborted) {
    const reachable = await probe(host, port);
    if (signal.aborted) {
      return false;
    }

    if (!reachable) {
      sawOffline = true;
    } else if (sawOffline) {
      return true;
    }

    await wait(RECHECK_DELAY_MS);
  }

  return false;
}
