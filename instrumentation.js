// Runs once when the Next.js server starts. In a container that ships its own
// Chromium, start it now, so the first agenda export does not pay for the
// launch (see lib/agendaBrowser.js).
//
// The import sits inside this exact NEXT_RUNTIME check: that is the form the
// build strips from the edge bundle, which cannot hold puppeteer-core.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (!process.env.CHROME_EXECUTABLE_PATH || process.env.VERCEL) return;
    const { warmAgendaBrowser } = await import('./lib/agendaBrowser');
    warmAgendaBrowser();
  }
}
