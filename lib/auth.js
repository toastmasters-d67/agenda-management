'use client';
import { withBase, COOKIE_PATH } from './basePath';

// Client-side auth helpers. The JWT itself lives in an httpOnly cookie
// (set by app/svc/auth/login) and is never readable from JS — only the
// non-sensitive fields below are kept in localStorage, same as before.

export function getUsername() {
  return typeof window === 'undefined' ? null : localStorage.getItem('auth_username');
}

export function getRole() {
  if (typeof window === 'undefined') return 'club_member';
  return localStorage.getItem('auth_role') || 'club_member';
}

export function getClubId() {
  if (typeof window === 'undefined') return null;
  const v = localStorage.getItem('auth_club_id');
  return v ? parseInt(v) : null;
}

export function mustChangePw() {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem('auth_must_change_pw') === 'true';
}

export function isSystemAdmin() { return getRole() === 'system_admin'; }
export function isClubAdmin() { return getRole() === 'club_admin'; }
export function canWrite() { return getRole() !== 'club_member'; }

// `role` / `clubId` are for the CURRENT club — a member of several clubs acts
// in one at a time (see switchClub). `memberships` is every club they belong
// to, [{clubId, clubName, role}], as /auth/verify returns it.
export function setAuth(username, role, clubId, mustChangePwFlag, memberships) {
  localStorage.setItem('auth_username', username);
  localStorage.setItem('auth_role', role || 'club_member');
  localStorage.setItem('auth_club_id', clubId != null ? String(clubId) : '');
  localStorage.setItem('auth_must_change_pw', mustChangePwFlag ? 'true' : 'false');
  if (memberships !== undefined) {
    localStorage.setItem('auth_memberships', JSON.stringify(memberships || []));
  }
  window.dispatchEvent(new Event('auth-changed'));
}

export function getMemberships() {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem('auth_memberships') || '[]');
  } catch {
    return [];
  }
}

// The club to act in, as a cookie the /svc proxy forwards (X-Active-Club).
// The API honours it only for a club the user belongs to, so it is a
// preference, not a permission.
export function switchClub(clubId) {
  document.cookie = `active_club=${encodeURIComponent(clubId)}; path=${COOKIE_PATH}; max-age=31536000; samesite=lax`;
  window.location.reload();
}

export function clearActiveClub() {
  document.cookie = `active_club=; path=${COOKIE_PATH}; max-age=0; samesite=lax`;
}

export function clearAuth() {
  localStorage.removeItem('auth_username');
  localStorage.removeItem('auth_role');
  localStorage.removeItem('auth_club_id');
  localStorage.removeItem('auth_must_change_pw');
  localStorage.removeItem('auth_memberships');
  clearActiveClub();
}

export function logout() {
  if (!confirm('確定要登出嗎？')) return;
  clearAuth();
  fetch(withBase('/svc/auth/logout'), { method: 'POST' }).finally(() => { window.location.href = withBase('/login'); });
}

/**
 * Apply role-based UI visibility.
 * - .write-action        → hidden for club_member
 * - .system-admin-only   → hidden for club_admin and club_member
 * - .form-scroll-body    → all inputs/selects/textareas disabled for club_member
 */
export function applyRoleUI() {
  document.querySelectorAll('.write-action').forEach((el) => {
    el.style.display = canWrite() ? '' : 'none';
  });
  document.querySelectorAll('.system-admin-only').forEach((el) => {
    el.style.display = isSystemAdmin() ? '' : 'none';
  });
  const formBody = document.querySelector('.form-scroll-body');
  if (formBody) {
    const readOnly = !canWrite();
    formBody.querySelectorAll('input, select, textarea').forEach((el) => {
      el.disabled = readOnly;
    });
  }
}
