/** @type {import('next').NextConfig} */
const nextConfig = {
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
