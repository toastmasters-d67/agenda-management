import { NextResponse } from 'next/server';
import { backendUrl } from '../../_backend';

// Registration never issues a token (new accounts start as "pending"),
// so this is a plain passthrough — no cookie handling needed.
export async function POST(request) {
  const body = await request.text();
  const res = await fetch(backendUrl(request, 'auth/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => null);
  return NextResponse.json(data, { status: res.status });
}
