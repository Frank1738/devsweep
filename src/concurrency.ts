// Imports nothing from the rest of src, so any module can use it without a circular import.

/**
 * Calls `work` on every item, with at most `limit` calls running at once, and returns the
 * results in the same order as `items`. Like Promise.all, but without opening thousands of
 * files at the same moment.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * A gate that lets at most `limit` tasks run at once, across every caller that shares it. Unlike
 * mapLimit, tasks can be added while others run, such as files found while a folder is listed.
 */
export function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
