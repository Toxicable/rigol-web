import type { DmmBinding } from "./dmm-binding.js";

export type DmmLifecycleBinding = Pick<DmmBinding, "activate" | "deactivate">;

export function bindDmmRoute(binding: DmmLifecycleBinding): () => void {
  binding.activate();
  return () => binding.deactivate();
}
