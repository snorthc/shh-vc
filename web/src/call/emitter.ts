/** Minimal typed event emitter, so the UI layer has no framework dependency. */
export class Emitter<E> {
  private handlers = new Map<keyof E, Set<(payload: never) => void>>();

  on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(fn as (payload: never) => void);
    return () => {
      set!.delete(fn as (payload: never) => void);
    };
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (p: E[K]) => void)(payload);
      } catch (err) {
        console.error(`handler for ${String(event)} threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
