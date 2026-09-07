import type { DmmInfo, DmmState } from "../../shared/dmm-types.js";
import type { ScopeInfo, ScopeState } from "../../shared/scope-types.js";

export enum ScopeConnectionKind {
  Disconnected = 1,
  Connected = 2,
}

export type ScopeConnection =
  | {
      kind: ScopeConnectionKind.Disconnected;
      reason: string;
    }
  | {
      kind: ScopeConnectionKind.Connected;
      info: ScopeInfo;
      state: ScopeState;
    };

export enum DmmConnectionKind {
  Disconnected = 1,
  Connected = 2,
}

export type DmmConnection =
  | {
      kind: DmmConnectionKind.Disconnected;
      reason: string;
    }
  | {
      kind: DmmConnectionKind.Connected;
      info: DmmInfo;
      state: DmmState;
    };
