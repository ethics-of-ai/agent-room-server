/**
 * Runs operations that share a key one at a time, in arrival order; different
 * keys run concurrently. A failed operation does not stop the next one.
 */
export class KeyedSerial {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(operation, operation);
    this.chains.set(key, next);
    void next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key); }).catch(() => {});
    return next;
  }
}
