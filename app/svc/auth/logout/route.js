import { NextResponse } from 'next/server';

// There's no server-side session/blacklist for JWTs today — logout just
// clears the httpOnly cookie the browser can no longer touch itself.
export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set('auth_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
