import type { DataSource } from 'typeorm';

export interface Checkpoint {
  // resolves once the paused call has finished and is holding whatever it locked
  reached: Promise<void>;
  release(): void;
}

type AnyFunction = (...args: unknown[]) => unknown;

// Pauses the first matching call of object[method] right after the original
// resolves, until release() is called. Later calls pass straight through.
export function pauseAfterFirstCall<T extends object>(
  object: T,
  method: keyof T & string,
  matches: (self: unknown, args: unknown[]) => boolean = () => true,
): Checkpoint {
  const original = object[method] as unknown as AnyFunction;
  let paused = false;
  let signalReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (signalReached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));

  jest.spyOn(object, method as never).mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args);

    if (!paused && matches(this, args)) {
      paused = true;
      signalReached();
      await released;
    }

    return result;
  } as never);

  return { reached, release };
}

// Waits until another connection is executing a statement matching the LIKE
// pattern. Called while a checkpoint holds the lock that statement needs, a
// match means the statement is sent and blocked on that lock. Reads only the
// test user's own threads, so it needs no PROCESS privilege.
export async function waitForBlockedStatement(
  dataSource: DataSource,
  likePattern: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows: unknown[] = await dataSource.query(
      `SELECT ID FROM information_schema.PROCESSLIST
       WHERE ID <> CONNECTION_ID() AND COMMAND = 'Query' AND INFO LIKE ?`,
      [likePattern],
    );

    if (rows.length) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`No statement matching ${likePattern} was blocked within ${timeoutMs}ms`);
}

export const LOCK_SPACE = '%FROM `spaces` `space`%FOR UPDATE%';
export const LOCK_USER = '%FROM `users` `user`%FOR UPDATE%';
export const INSERT_USER = 'INSERT INTO `users`%';

function failWhenSettled(promise: Promise<unknown>, message: string): Promise<never> {
  return promise.then(
    () => Promise.reject(new Error(message)),
    () => Promise.reject(new Error(message)),
  );
}

// Runs `first` until it holds the checkpoint's lock, then sends `second` and
// waits until it is blocked on `blockedOn` before letting `first` go, so the
// two always overlap. Fails instead of hanging when either side skips its
// part (e.g. the lock under test is missing and `second` just completes).
export async function overlap<A, B>(
  dataSource: DataSource,
  checkpoint: Checkpoint,
  blockedOn: string,
  first: () => PromiseLike<A>,
  second: () => PromiseLike<B>,
): Promise<[A, B]> {
  const a = Promise.resolve(first());
  let b: Promise<B> | undefined;

  try {
    await Promise.race([checkpoint.reached, failWhenSettled(a, 'The first request finished before its checkpoint')]);
    b = Promise.resolve(second());
    await Promise.race([
      waitForBlockedStatement(dataSource, blockedOn),
      failWhenSettled(b, `The second request finished without blocking on ${blockedOn}`),
    ]);
  } finally {
    checkpoint.release();
  }

  return [await a, await b];
}
