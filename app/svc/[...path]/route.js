import { NextResponse } from 'next/server';
import { backendUrl } from '../_backend';

// Generic authenticated proxy: browser calls /svc/<path>, we read the
// httpOnly auth_token cookie server-side, attach it as a Bearer header,
// and forward to the (untouched) FastAPI backend at /api/<path>.
async function proxy(request, { params }) {
  const token = request.cookies.get('auth_token')?.value;
  const url = backendUrl(request, params.path.join('/'), request.nextUrl.search);

  const headers = {};
  const contentType = request.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  if (token) headers['authorization'] = `Bearer ${token}`;

  const hasBody = !['GET', 'HEAD'].includes(request.method);

  const res = await fetch(url, {
    method: request.method,
    headers,
    body: hasBody ? await request.text() : undefined,
    cache: 'no-store',
  });

  const buffer = await res.arrayBuffer();
  return new NextResponse(buffer, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') || 'application/octet-stream',
      'cache-control': res.headers.get('cache-control') || 'no-store',
    },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
