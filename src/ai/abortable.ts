export class TurnAbortedError extends Error {
  override readonly name = 'TurnAbortedError';
}

export async function* untilAborted<T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new TurnAbortedError('The turn was aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (signal.aborted) void iterator.return?.()?.catch(() => undefined);
  }
}
