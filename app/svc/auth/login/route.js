import { NextResponse } from 'next/server';
import { backendUrl } from '../../_backend';

// Login is special-cased (not the generic [...path] proxy) because it's
// the one call that needs to turn the FastAPI JSON token response into an
// httpOnly cookie instead of handing the raw JWT to the browser.
export async function POST(request) {
  const body = await request.text();
  const res = await fetch(backendUrl(request, 'auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return NextResponse.json(data ?? { detail: '登入失敗' }, { status: res.status });
  }

  const { token, ...userInfo } = data;
  const response = NextResponse.json(userInfo, { status: 200 });
  response.cookies.set('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24, // matches JWT_EXPIRE_HOURS in api/index.py
  });
  return response;
}
