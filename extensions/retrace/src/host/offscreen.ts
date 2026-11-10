/**
 * Entry of the offscreen document (Chrome's store host). Glue only: build the
 * platform-neutral {@link StoreHost} and serve it to the service worker.
 */

import { notifyHostClosed, serveHost } from '../platform/index.ts';
import { StoreHost } from './store-host.ts';

/**
 * Close the store (and let the document be reaped) after five quiet minutes.
 * `localStorage['retrace.hostIdleMs']` overrides it (the end-to-end test uses
 * a few seconds to exercise the close/recreate path).
 */
function idleMs(): number {
  try {
    const override = Number(localStorage.getItem('retrace.hostIdleMs'));
    if (Number.isFinite(override) && override >= 1000) return override;
  } catch {
    /* no storage */
  }
  return 5 * 60_000;
}

const host = new StoreHost({
  assetBase: new URL('/', location.href).href,
  idleMs: idleMs(),
  onClosed: notifyHostClosed,
});

serveHost((req) => host.handle(req));
