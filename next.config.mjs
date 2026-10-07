/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle for the Docker image (Dockerfile.web). Vercel
  // packages the app its own way, so it is left off there — the same code
  // deploys to both (see .github/workflows/sync-to-org.yml).
  ...(process.env.VERCEL ? {} : { output: 'standalone' }),
  // Sub-path deploy (e.g. /club-management on the shared VM); unset on Vercel.
  // Also see lib/basePath.js for the places Next.js doesn't prefix itself.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  // app/svc/agenda-export runs a headless Chromium. The package locates its
  // compressed binary by relative path, which bundling breaks, so it stays
  // external — and the binary files themselves are not imports, so they are
  // traced into that one function explicitly.
  serverExternalPackages: ['@sparticuz/chromium', 'puppeteer-core'],
  // Only Vercel uses the bundled binary (67 MB); a container image brings its
  // own Chromium (CHROME_EXECUTABLE_PATH) and should not carry this one.
  ...(process.env.VERCEL ? {
    outputFileTracingIncludes: {
      '/svc/agenda-export': ['./node_modules/@sparticuz/chromium/bin/**'],
    },
  } : {}),
  async headers() {
    // The OAuth consent screen must never render inside someone else's frame:
    // a page that overlays it could steer the "允許" click without the person
    // seeing what they are agreeing to. The login page is covered too, since
    // an unauthenticated consent flow passes through it.
    const noFraming = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    ];
    return [
      { source: '/oauth/:path*', headers: noFraming },
      { source: '/login', headers: noFraming },
    ];
  },
  async redirects() {
    return [
      { source: '/', destination: '/login', permanent: false },
      { source: '/login.html', destination: '/login', permanent: true },
      { source: '/home.html', destination: '/home', permanent: true },
      { source: '/index.html', destination: '/index', permanent: true },
      { source: '/member.html', destination: '/member', permanent: true },
      { source: '/roles.html', destination: '/roles', permanent: true },
      { source: '/club.html', destination: '/club', permanent: true },
      // 用戶管理 was merged into 會員管理; both legacy URLs land on /member.
      { source: '/admin.html', destination: '/member', permanent: true },
      { source: '/admin', destination: '/member', permanent: true },
      { source: '/change-password.html', destination: '/change-password', permanent: true },
    ];
  },
  async rewrites() {
    return [
      // Next.js reserves the literal route segment name "index" internally
      // (causes a prerender crash), so the page actually lives at
      // app/agenda/page.js — this keeps the public URL /index unchanged.
      { source: '/index', destination: '/agenda' },
    ];
  },
};

export default nextConfig;
