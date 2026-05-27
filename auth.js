'use strict';

const API_BASE = ['localhost', '127.0.0.1'].includes(window.location.hostname) ? 'http://localhost:8001' : '';

function getToken()        { return localStorage.getItem('auth_token'); }
function getUsername()     { return localStorage.getItem('auth_username'); }
function getRole()         { return localStorage.getItem('auth_role') || 'club_member'; }
function getClubId()       { const v = localStorage.getItem('auth_club_id'); return v ? parseInt(v) : null; }
function mustChangePw()    { return localStorage.getItem('auth_must_change_pw') === 'true'; }

function isSystemAdmin() { return getRole() === 'system_admin'; }
function isClubAdmin()   { return getRole() === 'club_admin'; }
function canWrite()      { return getRole() !== 'club_member'; }

function setAuth(token, username, role, clubId, mustChangePwFlag) {
  localStorage.setItem('auth_token',   token);
  localStorage.setItem('auth_username', username);
  localStorage.setItem('auth_role',    role    || 'club_member');
  localStorage.setItem('auth_club_id', clubId != null ? String(clubId) : '');
  localStorage.setItem('auth_must_change_pw', mustChangePwFlag ? 'true' : 'false');
}

function clearAuth() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_username');
  localStorage.removeItem('auth_role');
  localStorage.removeItem('auth_club_id');
  localStorage.removeItem('auth_must_change_pw');
}

/**
 * Apply role-based UI visibility.
 * - .write-action        → hidden for club_member
 * - .system-admin-only   → hidden for club_admin and club_member
 * - .form-scroll-body    → all inputs/selects/textareas disabled for club_member
 */
function applyRoleUI() {
  document.querySelectorAll('.write-action').forEach(el => {
    el.style.display = canWrite() ? '' : 'none';
  });
  document.querySelectorAll('.system-admin-only').forEach(el => {
    el.style.display = isSystemAdmin() ? '' : 'none';
  });
  const formBody = document.querySelector('.form-scroll-body');
  if (formBody) {
    const readOnly = !canWrite();
    formBody.querySelectorAll('input, select, textarea').forEach(el => {
      el.disabled = readOnly;
    });
  }
}
