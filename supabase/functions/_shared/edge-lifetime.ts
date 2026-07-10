export interface EdgeRuntimeWaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export interface EdgeLifetime {
  promise: Promise<void>;
  registered: boolean;
  resolve: () => boolean;
}

/**
 * Keep a Supabase Edge Function worker active after a WebSocket upgrade.
 *
 * An upgraded WebSocket is not request-tracked by the Edge Runtime. Without an
 * unresolved waitUntil promise, the supervisor may classify the worker as idle
 * and terminate it with EarlyDrop while the socket is still carrying a call.
 */
export function registerEdgeLifetime(runtime?: EdgeRuntimeWaitUntil): EdgeLifetime {
  let resolved = false;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  runtime?.waitUntil(promise);

  return {
    promise,
    registered: Boolean(runtime),
    resolve: () => {
      if (resolved) return false;
      resolved = true;
      resolvePromise();
      return true;
    },
  };
}
