import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  // /svc/* and /api/* handle their own auth (FastAPI 401s on missing/bad
  // token, login/register are unauthenticated by design) — don't redirect
  // API calls to an HTML page.
  // /.well-known is OAuth discovery: an MCP client reads it *before* it has
  // a token, so redirecting it to /login would break authorization at the
  // first step.
  if (pathname.startsWith('/svc') || pathname.startsWith('/api')
      || pathname.startsWith('/.well-known')) {
    return NextResponse.next();
  }

  const token = request.cookies.get('auth_token')?.value;
  let validToken = false;
  if (token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET));
      validToken = true;
    } catch {
      validToken = false;
    }
  }

  // Already logged in and hitting /login → skip straight to /home
  // (mirrors the old onLoad() check in login.html, now done at the edge
  // since the token itself isn't readable by client JS anymore).
  if (pathname === '/login') {
    return validToken ? NextResponse.redirect(new URL('/home', request.url)) : NextResponse.next();
  }

  if (!validToken) {
    // Remember where they were headed. The OAuth consent screen is reached
    // from outside the app, so a user who is not logged in lands here
    // mid-flow — sending them to /home afterwards would silently abandon the
    // authorization they were in the middle of granting.
    const login = new URL('/login', request.url);
    login.searchParams.set('next', pathname + request.nextUrl.search);
    const response = NextResponse.redirect(login);
    if (token) response.cookies.set('auth_token', '', { path: '/', maxAge: 0 });
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|media|\.well-known).*)'],
};
