// Host boundary. Everything the DOCTrace engine needs from the desktop app goes
// through this one object. The guides window installs it at start-up
// (installDesktopHost in assets/index-*.js):
//
//   import { platform } from '../platform/platform.js';
//   await platform.kv.get('key');
//
// The adapter contract (async unless noted):
//   kv.get(keys) -> object      kv.set(object)      kv.remove(keys)      kv.available() (sync)
//   net.fetch(url, init, { timeoutMs }) -> Response-like
//       requests to the AI model on this computer; the main process only
//       allows localhost on ports 11434, 1234 and 8080
//   events.emit(message) (sync)   progress messages for the window, e.g.
//       { type: 'SC_STEP_DONE', sessionId, stepNumber }

const REQUIRED = ['kv', 'net', 'events'];
let current = null;

export const platform = new Proxy({}, {
  get: (_, key) => {
    if (!current) throw new Error('DOCTrace engine used before the desktop host was installed');
    return current[key];
  },
});

/** Called once at start-up by the guides window. */
export function setPlatform(adapter) {
  const missing = REQUIRED.filter((k) => !adapter?.[k]);
  if (missing.length) throw new Error(`Platform adapter is missing: ${missing.join(', ')}`);
  current = adapter;
}

export const platformName = () => current?.name || 'unknown';
