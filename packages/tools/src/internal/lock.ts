// Per-key promise chain. Concurrent calls with the same key are serialized
// so two tool invocations on the same file path can't trample each other.
// The map grows with the set of unique keys seen — fine for typical agent
// runs where the working set is small.

const locks = new Map<string, Promise<unknown>>();

export function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}
