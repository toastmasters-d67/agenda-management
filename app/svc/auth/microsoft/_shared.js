// Shared by the Microsoft sign-in start / callback routes.
import { publicUrl } from '../../_backend';

export const MS_COOKIE = 'ms_oauth';

// Must match a redirect URI registered on the Entra app, exactly.
export function callbackUrl(request) {
  return publicUrl(request, '/svc/auth/microsoft/callback').toString();
}

// Only same-site paths. `next` comes from a query string, so it is
// attacker-controlled; "//evil.example" and "/\evil.example" are both
// protocol-relative URLs to a browser and must not pass.
export function safeNext(raw) {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '';
  return raw;
}
