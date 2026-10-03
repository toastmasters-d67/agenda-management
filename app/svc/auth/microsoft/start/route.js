import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { backendUrl } from '../../../_backend';
import { MS_COOKIE, callbackUrl, safeNext } from '../_shared';

// Step 1 of "sign in with Microsoft": mint state / nonce / PKCE verifier, park
// them in a short-lived httpOnly cookie, and send the browser to Microsoft.
// `mode=link` is the settings page connecting a Microsoft account to the
// already signed-in user; anything else is a login.
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  const mode = params.get('mode') === 'link' ? 'link' : 'login';
  const next = safeNext(params.get('next'));

  const b64url = (buf) => buf.toString('base64url');
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

  const qs = new URLSearchParams({
    redirect_uri: callbackUrl(request), state, nonce, code_challenge: challenge,
  });
  const res = await fetch(backendUrl(request, 'auth/microsoft/authorize-url', `?${qs}`),
                          { cache: 'no-store' });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.url) {
    const back = new URL(mode === 'link' ? '/settings' : '/login', request.url);
    back.searchParams.set('ms_error', data?.detail || 'Microsoft 登入目前無法使用');
    return NextResponse.redirect(back);
  }

  const response = NextResponse.redirect(data.url);
  response.cookies.set(MS_COOKIE, JSON.stringify({ state, nonce, verifier, mode, next }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax, not Strict: the callback is a top-level navigation *from Microsoft*,
    // and a Strict cookie would not be sent on it.
    sameSite: 'lax',
    path: '/svc/auth/microsoft',
    maxAge: 600,
  });
  return response;
}
