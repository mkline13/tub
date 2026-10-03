/** In-process fan-out of "scope changed" signals to live streams. */
export class ScopeNotifier {
  private listeners = new Map<string, Set<() => void>>()

  subscribe(scope: string, listener: () => void): () => void {
    let set = this.listeners.get(scope)
    if (!set) this.listeners.set(scope, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(scope)
    }
  }

  notify(scope: string): void {
    for (const listener of [...(this.listeners.get(scope) ?? [])]) listener()
  }
}
