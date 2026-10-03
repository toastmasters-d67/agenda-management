// Shared helpers for app/svc/** route handlers.
import { withBase } from '@/lib/basePath';

// Resolves the FastAPI base URL.
// Local dev: FastAPI runs standalone on :8001 (see README `uvicorn` instructions).
// Docker (Azure VM): FASTAPI_BASE_URL points at the api container.
// Production (Vercel): same deployment origin, where vercel.json already
// rewrites /api/:path* to api/index.py — completely unchanged.
export function backendUrl(request, path, search = '') {
  const base =
    process.env.FASTAPI_BASE_URL ||
    (process.env.NODE_ENV === 'production' ? new URL(request.url).origin : 'http://localhost:8001');
  return `${base}/api/${path}${search}`;
}

// Absolute URL of an app path as the browser sees it. Behind nginx the
// request reaches Next.js over plain http, so request.url's origin is not the
// public one; PUBLIC_ORIGIN (e.g. https://host) overrides it.
export function publicUrl(request, path) {
  const origin = process.env.PUBLIC_ORIGIN || new URL(request.url).origin;
  return new URL(withBase(path), origin);
}
