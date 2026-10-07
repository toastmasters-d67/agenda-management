import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

// ================================================================
// AGENDA EXPORT  (server-side JPG / PDF)
// ================================================================
// The agenda sheet is drawn in the browser — per-club templates, row-height
// equalising, html2canvas — and the "下載 JPG / PDF" buttons capture that DOM.
// Re-implementing any of it server-side would be a second renderer that
// drifts from the first. So this route opens the real /agenda page in a
// headless Chromium, signed in as the requesting user, and asks the page for
// the very same capture the buttons make (window.__agendaExport in
// app/agenda/page.js). What comes out is byte-for-byte the web download.
//
// Called by the MCP tool `export_agenda` (api/index.py), which:
//   - mints a short-lived login token for the caller (the token *is* the
//     authorisation here: this route can render only what that person's own
//     browser session could), and
//   - hands over presigned R2 PUT URLs, so the files go straight to storage
//     without passing back through either function's response size limit.
//
// Without `uploads` the files come back inline as data URLs — for local
// testing, where nothing should be written to the real bucket.

export const runtime = 'nodejs';
export const maxDuration = 60;

const FORMATS = ['jpg', 'pdf'];
// Of the 60 s: launching Chromium and loading the agenda page get this much,
// counted from the start of the request; capture and upload get the rest.
const LOAD_BUDGET_MS = 40000;

// Chromium on Vercel ships with no CJK font at all, so every 中文 glyph would
// render as an empty box. @sparticuz/chromium unpacks its fonts.tar.br —
// fonts.conf included — into /tmp/fonts and points fontconfig there, so the
// CJK font is added to that same folder once per warm instance. Google Fonts
// answers a non-browser client with plain TTF.
//
// Order matters: the package skips unpacking if /tmp/fonts already exists.
// Creating the folder first leaves Chromium with no fonts.conf, and it dies
// on its first navigation ("Navigating frame was detached").
const FONT_DIR = '/tmp/fonts';
// Noto Emoji (monochrome) covers the symbols the templates use, such as the
// ⏱ in front of 學習路徑, which would otherwise also draw as a box.
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;700&family=Noto+Emoji';
// Bump when FONT_CSS changes, so a warm instance fetches the new set.
const FONT_TAG = 'web2-';

/** A /tmp/fonts without fonts.conf (made by an older build) blocks unpacking; clear it. */
async function clearBrokenFontDir() {
  const fs = await import('node:fs/promises');
  try {
    const have = await fs.readdir(FONT_DIR);
    if (!have.includes('fonts.conf')) await fs.rm(FONT_DIR, { recursive: true, force: true });
  } catch { /* not there — nothing to clear */ }
}

/** Runs after chromium.executablePath(), which is what unpacks fonts.conf. */
async function ensureCjkFont() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const have = await fs.readdir(FONT_DIR);
  if (have.some((f) => f.startsWith(FONT_TAG))) return;
  const css = await (await fetch(FONT_CSS, { headers: { 'User-Agent': 'curl/8' } })).text();
  const urls = [...css.matchAll(/url\((https:[^)]+\.ttf)\)/g)].map((m) => m[1]);
  if (!urls.length) throw new Error('無法取得中文字型');
  await Promise.all(urls.map(async (u, i) => {
    const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
    await fs.writeFile(path.join(FONT_DIR, `${FONT_TAG}${i}.ttf`), buf);
  }));
}

async function launchBrowser() {
  const puppeteer = (await import('puppeteer-core')).default;
  // Anywhere but Vercel: an installed Chrome/Chromium — local development, or
  // a container image that ships one. The bundled Chromium is an Amazon
  // Linux binary and does not run elsewhere (not on Alpine, not on Windows).
  if (process.env.CHROME_EXECUTABLE_PATH) {
    return puppeteer.launch({
      executablePath: process.env.CHROME_EXECUTABLE_PATH,
      headless: true,
      // Container defaults: no user namespaces for the sandbox, small /dev/shm.
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  if (!process.env.VERCEL) {
    throw new Error('這個部署沒有可用的 Chromium，無法輸出議程。'
      + '請在執行環境安裝 Chromium 與中文字型，並設定 CHROME_EXECUTABLE_PATH');
  }
  const chromium = (await import('@sparticuz/chromium')).default;
  chromium.setGraphicsMode = false;
  await clearBrokenFontDir();
  const executablePath = await chromium.executablePath();   // unpacks /tmp/fonts
  await ensureCjkFont();
  return puppeteer.launch({
    args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
    executablePath,
    headless: 'shell',
  });
}

/** Only our own bucket may be written to — the URLs arrive in the request. */
function uploadAllowed(url) {
  try {
    const u = new URL(url);
    const acct = process.env.R2_ACCOUNT_ID;
    return u.protocol === 'https:' && !!acct && u.hostname.endsWith(`${acct}.r2.cloudflarestorage.com`);
  } catch {
    return false;
  }
}

async function putDataUrl(url, dataUrl, contentType) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: Buffer.from(b64, 'base64'),
  });
  if (!res.ok) throw new Error(`上傳失敗（${res.status}）`);
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: '請求格式錯誤' }, { status: 400 });
  }
  const { token, agendaId, clubId, uploads } = body || {};
  const formats = (body?.formats || FORMATS).filter((f) => FORMATS.includes(f));
  if (!token || !Number.isInteger(agendaId) || !formats.length) {
    return NextResponse.json({ detail: '缺少 token、agendaId 或 formats' }, { status: 400 });
  }

  try {
    await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET));
  } catch {
    return NextResponse.json({ detail: '授權無效或已過期' }, { status: 401 });
  }

  if (uploads) {
    const all = [uploads.pdf, ...(uploads.jpg || [])].filter(Boolean);
    if (!all.every(uploadAllowed)) {
      return NextResponse.json({ detail: '上傳網址不在允許的儲存空間' }, { status: 400 });
    }
  }

  // The page is always this deployment's own — never a host named in the
  // request, which would hand the login token to whoever runs that host. On
  // Vercel that is the URL this request came in on. In a container it is this
  // same Next.js server on its own port: behind nginx, request.url carries
  // the public host, and the app may sit under a sub-path (basePath).
  const origin = process.env.VERCEL
    ? new URL(request.url).origin
    : (process.env.AGENDA_RENDER_PAGE_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3000}`);
  const base = process.env.NEXT_PUBLIC_BASE_PATH || '';

  const started = Date.now();
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    // The editor reports load failures with alert(), which would otherwise
    // hang a headless page until the timeout. Dismiss, but keep the text —
    // it is the actual reason ("找不到此議程", a 403, …).
    const alerts = [];
    page.on('dialog', (d) => { alerts.push(d.message()); d.dismiss().catch(() => {}); });
    // A4 at the editor's layout width; scale stays 1 so the preview is not
    // shrunk (applyPreviewScale only scales down for narrow screens).
    await page.setViewport({ width: 1400, height: 1200, deviceScaleFactor: 1 });
    await page.setCookie({
      name: 'auth_token', value: token, url: origin,
      httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'Lax',
    });
    // Act in the agenda's club (a member of several clubs reads only the club
    // they are acting in). Only a preference: the API checks membership.
    if (Number.isInteger(clubId)) {
      await page.setCookie({ name: 'active_club', value: String(clubId), url: origin, sameSite: 'Lax' });
    }

    // Wait for the page to say it is ready, not for the network to go quiet.
    // `networkidle0` was the first try and timed out intermittently: the page
    // makes several /svc calls into the API function — which is busy serving
    // the very MCP call that asked for this export — so on Vercel they often
    // land on freshly started instances, and one slow cold start was enough to
    // blow a fixed 30 s. `ready` is set once the agenda has loaded and drawn;
    // images are awaited later, by the capture itself (waitForImages).
    // One budget for loading, leaving the rest of maxDuration for capture
    // and upload.
    const loadBy = started + LOAD_BUDGET_MS;
    const left = () => Math.max(1000, loadBy - Date.now());
    await page.goto(`${origin}${base}/agenda?id=${agendaId}`,
      { waitUntil: 'domcontentloaded', timeout: left() });
    try {
      await page.waitForFunction(
        () => window.__agendaExport && window.__agendaExport.ready
          && window.html2canvas && window.html2pdf,
        { timeout: left(), polling: 250 },
      );
    } catch (e) {
      if (new URL(page.url()).pathname !== `${base}/agenda`) {
        throw new Error('帳號需要先到網站變更密碼，或登入已失效');
      }
      throw new Error(`議程頁在 ${Math.round(LOAD_BUDGET_MS / 1000)} 秒內沒有載入完成`
        + `（伺服器可能剛啟動，請稍後再試一次）${alerts.length ? '：' + alerts.join('；') : ''}`);
    }
    const failure = await page.evaluate(() => window.__agendaExport.error || '');
    if (failure) throw new Error([failure, ...alerts].join('：'));
    if (new URL(page.url()).pathname !== `${base}/agenda`) {
      // checkAuth() sends a must-change-password account elsewhere.
      throw new Error('帳號需要先到網站變更密碼');
    }

    const out = await page.evaluate(async (wanted) => {
      await document.fonts.ready;
      // Fonts can land after the first layout; re-render so row heights are
      // measured with the glyphs that will actually be drawn.
      await window.__agendaExport.rerender();
      const res = { name: window.__agendaExport.baseName() };
      if (wanted.includes('jpg')) res.jpg = await window.__agendaExport.jpg();
      if (wanted.includes('pdf')) res.pdf = await window.__agendaExport.pdf();
      return res;
    }, formats);

    if (!uploads) return NextResponse.json(out);

    const jpgUrls = uploads.jpg || [];
    if (out.jpg && out.jpg.length > jpgUrls.length) {
      throw new Error(`議程有 ${out.jpg.length} 頁，超過可上傳的 ${jpgUrls.length} 頁`);
    }
    await Promise.all([
      ...(out.jpg || []).map((d, i) => putDataUrl(jpgUrls[i], d, 'image/jpeg')),
      out.pdf ? putDataUrl(uploads.pdf, out.pdf, 'application/pdf') : null,
    ].filter(Boolean));
    return NextResponse.json({ name: out.name, jpgPages: (out.jpg || []).length, pdf: !!out.pdf });
  } catch (e) {
    console.error('agenda-export failed', e);
    return NextResponse.json({ detail: `議程輸出失敗：${e.message || e}` }, { status: 502 });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
