// Shared helper for app/svc/** route handlers — resolves the FastAPI base URL.
// Local dev: FastAPI runs standalone on :8001 (see README `uvicorn` instructions).
// Production (Vercel): same deployment origin, where vercel.json already
// rewrites /api/:path* to api/index.py — completely unchanged.
export function backendUrl(request, path, search = '') {
  const base =
    process.env.FASTAPI_BASE_URL ||
    (process.env.NODE_ENV === 'production' ? new URL(request.url).origin : 'http://localhost:8001');
  return `${base}/api/${path}${search}`;
}
