import type { Ppk2Binding } from "./ppk2-binding.js";

export type Ppk2LifecycleBinding = Pick<Ppk2Binding, "activate" | "deactivate">;

export function bindPpk2Route(binding: Ppk2LifecycleBinding): () => void {
  binding.activate();
  return () => binding.deactivate();
}
