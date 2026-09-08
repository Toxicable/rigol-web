import type { ScopeBinding } from "./scope-binding.js";

export type ScopeLifecycleBinding = Pick<ScopeBinding, "activate" | "deactivate">;

export function bindScopeRoute(binding: ScopeLifecycleBinding): () => void {
  binding.activate();
  return () => binding.deactivate();
}
