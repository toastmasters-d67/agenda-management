// One Chromium kept running for /svc/agenda-export in a container
// (CHROME_EXECUTABLE_PATH set: the Azure VM's web image).
//
// Launching Chromium per export does not fit the VM: on a 1 GB B1s a cold
// start measured 80 s and a warm one 44 s, nearly all of it swapping, so the
// 40 s load budget was gone before the agenda page was even opened. Here it
// is started once — at server boot by instrumentation.js — and each export
// gets its own browser context, so one person's login cookie is never seen
// by another's render.
//
// Kept on globalThis, not in a module variable: instrumentation.js and the
// route are bundled separately, and each bundle would get its own copy of
// this file — and so its own Chromium.
//
// Not on Vercel: a frozen function cannot keep a browser alive between
// invocations, so the route still launches one per request there.

const KEY = Symbol.for('agenda-export.browser');

function launch() {
  return import('puppeteer-core').then(({ default: puppeteer }) => puppeteer.launch({
    executablePath: process.env.CHROME_EXECUTABLE_PATH,
    headless: true,
    // Container defaults: no user namespaces for the sandbox, small /dev/shm.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  }));
}

/** The running browser, started on first use; started again if it has died. */
export async function sharedBrowser() {
  let pending = globalThis[KEY];
  if (pending) {
    const browser = await pending.catch(() => null);
    if (browser?.connected) return browser;
    if (globalThis[KEY] === pending) globalThis[KEY] = null;
  }
  if (!globalThis[KEY]) {
    pending = launch().then((browser) => {
      browser.on('disconnected', () => {
        if (globalThis[KEY] === pending) globalThis[KEY] = null;
      });
      return browser;
    });
    // A failed launch is not kept: the next export tries again.
    pending.catch(() => { if (globalThis[KEY] === pending) globalThis[KEY] = null; });
    globalThis[KEY] = pending;
  }
  return globalThis[KEY];
}

/** Start the browser ahead of the first export; failures only get logged. */
export function warmAgendaBrowser() {
  sharedBrowser().then(
    () => console.log('agenda-export: Chromium ready'),
    (e) => console.error('agenda-export: Chromium did not start', e),
  );
}
