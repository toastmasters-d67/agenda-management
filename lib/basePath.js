// The app can be served under a sub-path (e.g. /club-management on the shared
// Azure VM). Next.js adds basePath to <Link>, redirects and rewrites on its
// own, but not to plain <a href>, <img src>, fetch() or location.href — those
// go through withBase(). Inlined at build time; empty on Vercel.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

export function withBase(path) {
  return `${BASE_PATH}${path}`;
}

// Scope the auth cookie to the app's own path: other apps share the host on
// the VM, and a host-wide `auth_token` would collide with theirs.
export const COOKIE_PATH = BASE_PATH || '/';
