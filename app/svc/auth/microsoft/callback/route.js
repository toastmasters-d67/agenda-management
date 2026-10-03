import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { backendUrl } from '../../../_backend';
import { MS_COOKIE, callbackUrl, safeNext } from '../_shared';

// Step 2: Microsoft sends the browser back here with ?code&state. Check state
// against the cookie from step 1, let FastAPI exchange the code and decide
// which account it is, then turn its answer into a cookie and a redirect —
// the same httpOnly auth_token cookie the password login sets.
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  let saved = null;
  try { saved = JSON.parse(request.cookies.get(MS_COOKIE)?.value || 'null'); } catch { /* bad cookie */ }
  const mode = saved?.mode === 'link' ? 'link' : 'login';

  const finish = (path, query = {}) => {
    const url = new URL(path, request.url);
    Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = NextResponse.redirect(url);
    res.cookies.set(MS_COOKIE, '', { path: '/svc/auth/microsoft', maxAge: 0 });
    return res;
  };
  const fail = (msg) => finish(mode === 'link' ? '/settings' : '/login', { ms_error: msg });

  if (params.get('error')) {
    // The user pressed Cancel, or the tenant blocked the app.
    const desc = params.get('error') === 'access_denied'
      ? '已取消 Microsoft 登入'
      : (params.get('error_description') || '').split('\n')[0] || 'Microsoft 登入失敗';
    return fail(desc);
  }

  const state = params.get('state') || '';
  const code = params.get('code') || '';
  if (!saved || !code || state.length !== saved.state.length
      || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state))) {
    return fail('登入流程已失效，請重新登入');
  }

  const headers = { 'content-type': 'application/json' };
  const token = request.cookies.get('auth_token')?.value;
  if (mode === 'link' && token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(backendUrl(request, 'auth/microsoft/callback'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      code, code_verifier: saved.verifier, nonce: saved.nonce,
      redirect_uri: callbackUrl(request), mode,
    }),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) return fail(data?.detail || 'Microsoft 登入失敗');

  switch (data.result) {
    case 'linked':
      return finish('/settings', { ms_linked: '1' });
    case 'pending':
      return finish('/login', { ms_status: 'pending' });
    case 'signup':
      return finish('/login', { ms_signup: data.ticket });
    case 'login': {
      const next = data.must_change_pw ? '/change-password' : (safeNext(saved.next) || '/home');
      const response = finish(next);
      response.cookies.set('auth_token', data.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24, // matches JWT_EXPIRE_HOURS in api/index.py
      });
      return response;
    }
    default:
      return fail('Microsoft 登入失敗');
  }
}
