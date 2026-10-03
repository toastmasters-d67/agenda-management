'use client';

import { useEffect } from 'react';
import Script from 'next/script';
import { apiJson } from '@/lib/api';
import { setAuth, clearAuth, applyRoleUI, isSystemAdmin, canWrite } from '@/lib/auth';
import Sidebar from '@/components/Sidebar';
import './member.css';

// This page is the single entry point for managing people. It used to be split
// into /member (names, levels, bulk import) and /admin (roles, club assignment),
// but both read the same `/users` endpoint, so they were merged. The
// admin-only pieces — the 角色 / 所屬分會 fields and columns, and the
// admin/member head-count cards — are marked .system-admin-only and hidden by
// applyRoleUI() for everyone else. The backend gates the same fields anyway.
let members = [];
let editingUsername = null;
let levelChart = null;
let allClubs = [];
let selectedClubId = null;
let sortKey = null;
let sortDir = 'asc';
let filterStatus = 'active'; // 'active' | 'pending'
let addTab = 'single';

const LEVEL_CONFIG = [
  { key: 'TM', label: 'TM', color: '#a9b2b1' },
  { key: 'L1', label: 'Level 1', color: '#93c5fd' },
  { key: 'L2', label: 'Level 2', color: '#60a5fa' },
  { key: 'L3', label: 'Level 3', color: '#3b82f6' },
  { key: 'L4', label: 'Level 4', color: '#004165' },
  { key: 'L5', label: 'Level 5', color: '#f2df74' },
  { key: 'DTM', label: 'DTM', color: '#772432' },
];

const ROLE_LABEL = { system_admin: '系統管理員', club_admin: '分會管理員', club_member: '一般會員' };

// The 角色 column only renders for system_admin, so colspan has to follow.
function colCount() {
  return isSystemAdmin() ? 5 : 4;
}

function parseLevel(level) {
  const s = (level || '').toUpperCase();
  if (s.includes('DTM')) return 'DTM';
  const nums = s.match(/[1-5]/g);
  if (nums) return 'L' + Math.max(...nums.map(Number));
  return 'TM';
}

async function checkMemberAuth() {
  try {
    const data = await apiJson('/auth/verify');
    setAuth(data.username, data.role, data.club_id, data.must_change_pw);
    if (data.must_change_pw) { location.href = '/change-password'; return false; }
    document.getElementById('navUser').textContent = data.username;
    document.getElementById('userAvatar').textContent = data.username.slice(0, 1).toUpperCase();
    applyRoleUI();
    return true;
  } catch {
    clearAuth();
    location.href = '/login';
    return false;
  }
}

async function loadClubs() {
  try {
    allClubs = await apiJson('/clubs');
    const options = allClubs.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
    const select = document.getElementById('clubPickerSelect');
    select.innerHTML = '<option value="">— 全部分會 —</option>' + options;
    document.getElementById('clubPickerBar').style.display = '';
    // Same club list feeds the 所屬分會 selects in both modals.
    document.getElementById('addClubId').innerHTML = '<option value="">— 未分配 —</option>' + options;
    document.getElementById('fClubId').innerHTML = '<option value="">— 未分配 —</option>' + options;
  } catch {
    console.error('載入分會失敗');
  }
}

function onClubPickerChange() {
  const val = document.getElementById('clubPickerSelect').value;
  selectedClubId = val ? parseInt(val) : null;
  fetchMembers(selectedClubId ?? undefined);
}

async function fetchMembers(clubId) {
  document.getElementById('memberTableBody').innerHTML =
    `<tr><td colspan="${colCount()}"><div class="loading-spinner"><div class="spinner"></div></div></td></tr>`;
  try {
    let path = '/users';
    if (isSystemAdmin() && clubId != null) path += `?club_id=${clubId}`;
    members = await apiJson(path);
    updateStats();
    renderList();
  } catch {
    document.getElementById('memberTableBody').innerHTML =
      `<tr><td colspan="${colCount()}"><div class="table-empty">載入失敗</div></td></tr>`;
  }
}

function setFilter(status) {
  filterStatus = status;
  document.getElementById('filterActive').classList.toggle('active', status === 'active');
  document.getElementById('filterPending').classList.toggle('active', status === 'pending');
  document.getElementById('searchInput').value = '';
  renderList();
}

function updateStats() {
  const activeMembers = members.filter((m) => (m.status || 'active') === 'active');
  const pendingMembers = members.filter((m) => m.status === 'pending');

  document.getElementById('statTotal').textContent = activeMembers.length;
  document.getElementById('statDtm').textContent =
    activeMembers.filter((m) => (m.level || '').toUpperCase().includes('DTM')).length;
  document.getElementById('statAdmins').textContent =
    activeMembers.filter((m) => m.role === 'system_admin' || m.role === 'club_admin').length;
  document.getElementById('statMembers').textContent =
    activeMembers.filter((m) => m.role === 'club_member').length;

  const badge = document.getElementById('pendingBadge');
  if (badge) {
    badge.textContent = pendingMembers.length;
    badge.className = 'pending-badge' + (pendingMembers.length === 0 ? ' zero' : '');
  }

  const counts = Object.fromEntries(LEVEL_CONFIG.map((c) => [c.key, 0]));
  activeMembers.forEach((m) => {
    const k = parseLevel(m.level);
    if (counts[k] !== undefined) counts[k]++;
  });

  const labels = LEVEL_CONFIG.map((c) => c.label);
  const data = LEVEL_CONFIG.map((c) => counts[c.key]);
  const colors = LEVEL_CONFIG.map((c) => c.color);

  document.getElementById('chartSubtitle').textContent =
    LEVEL_CONFIG.filter((c) => counts[c.key] > 0)
      .map((c) => `${c.label} ${counts[c.key]}`)
      .join('　');

  document.getElementById('levelLegend').innerHTML = LEVEL_CONFIG.map((c) => `
    <div class="legend-item">
      <div class="legend-dot" style="background:${c.color}"></div>
      ${c.label} <strong>${counts[c.key]}</strong>
    </div>`).join('');

  // Chart.js loads async via next/script — skip until it's ready; the
  // Script's onLoad handler re-runs updateStats() once it is.
  if (typeof window === 'undefined' || !window.Chart) return;

  if (levelChart) {
    levelChart.data.datasets[0].data = data;
    levelChart.update();
    return;
  }

  const canvas = document.getElementById('levelChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  levelChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: 'rgba(0, 65, 101, 0.08)',
        borderColor: '#004165',
        borderWidth: 2.5,
        pointBackgroundColor: colors,
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointRadius: 7,
        pointHoverRadius: 9,
        fill: true,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => ` ${c.raw} 位` } },
      },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 11 } }, grid: { color: '#f1f5f9' } },
        x: { ticks: { font: { size: 12 } }, grid: { display: false } },
      },
    },
  });
}

function openAddModal() {
  document.getElementById('addNameZh').value = '';
  document.getElementById('addNameEn').value = '';
  document.getElementById('addLevel').value = 'TM';
  document.getElementById('addUsername').value = '';
  document.getElementById('addPassword').value = 'Toastmasters1';
  document.getElementById('addRole').value = 'club_member';
  // Default the new user into whichever club is currently being viewed.
  document.getElementById('addClubId').value = selectedClubId != null ? String(selectedClubId) : '';
  document.getElementById('bulkText').value = '';
  document.getElementById('addResults').style.display = 'none';
  const btn = document.getElementById('addSubmitBtn');
  btn.textContent = '儲存';
  btn.onclick = submitAdd;
  switchAddTab('single');
  document.getElementById('addModal').classList.add('open');
  applyRoleUI();
  setTimeout(() => document.getElementById('addNameZh').focus(), 50);
}

function closeAddModal() {
  document.getElementById('addModal').classList.remove('open');
}

function switchAddTab(tab) {
  addTab = tab;
  document.getElementById('addSingle').style.display = tab === 'single' ? '' : 'none';
  document.getElementById('addBulk').style.display = tab === 'bulk' ? '' : 'none';
  document.querySelectorAll('.modal-tab').forEach((t) => t.classList.remove('active'));
  document.querySelector(`.modal-tab[data-tab="${tab}"]`).classList.add('active');
  document.getElementById('addSubmitBtn').textContent = tab === 'single' ? '儲存' : '匯入';
  document.getElementById('addResults').style.display = 'none';
  if (tab === 'single') applyRoleUI();
}

function autoUsername() {
  const en = document.getElementById('addNameEn').value;
  const base = en.toLowerCase().replace(/[^a-z0-9]/g, '');
  document.getElementById('addUsername').value = base;
}

async function submitAdd() {
  if (addTab === 'single') await addSingle(); else await addBulk();
}

async function addSingle() {
  const name_zh = document.getElementById('addNameZh').value.trim();
  const name_en = document.getElementById('addNameEn').value.trim();
  const level = document.getElementById('addLevel').value.trim() || 'TM';
  const username = document.getElementById('addUsername').value.trim();
  const password = document.getElementById('addPassword').value.trim();
  if (!name_zh || !name_en) { alert('請填入中英文姓名'); return; }
  if (username.length < 3) { alert('帳號至少需要 3 個字元'); return; }
  if (password.length < 6) { alert('密碼至少需要 6 個字元'); return; }
  const body = { username, password, name_zh, name_en, level, role: 'club_member' };
  if (isSystemAdmin()) {
    // Only system_admin may pick a role / club; the backend forces a
    // club_admin's new users to club_member in their own club regardless.
    const clubVal = document.getElementById('addClubId').value;
    body.role = document.getElementById('addRole').value;
    body.club_id = clubVal ? parseInt(clubVal) : null;
  }
  try {
    await apiJson('/users', { method: 'POST', body });
    closeAddModal();
    await fetchMembers(isSystemAdmin() ? selectedClubId : undefined);
  } catch (e) { alert(e.message); }
}

async function addBulk() {
  const text = document.getElementById('bulkText').value.trim();
  const password = document.getElementById('bulkPassword').value.trim();
  if (isSystemAdmin() && !selectedClubId) { alert('多筆匯入請先在上方選擇分會'); return; }
  if (!text) { alert('請輸入會員資料'); return; }
  if (password.length < 6) { alert('密碼至少需要 6 個字元'); return; }
  const bulkMembers = text.split('\n')
    .map((l) => l.trim()).filter((l) => l)
    .map((line) => {
      const p = line.split(',').map((x) => x.trim());
      return { name_zh: p[0] || '', name_en: p[1] || '', level: p[2] || 'TM' };
    });
  const body = { members: bulkMembers, default_password: password };
  if (isSystemAdmin()) body.club_id = selectedClubId;
  try {
    const { results, defaultPassword } = await apiJson('/users/bulk', { method: 'POST', body });
    const ok = results.filter((r) => r.ok);
    const fail = results.filter((r) => !r.ok);
    const el = document.getElementById('addResults');
    el.style.display = '';
    el.innerHTML = `<div class="bulk-results">
      <div class="bulk-result-summary">成功 ${ok.length} 筆${fail.length ? `，失敗 ${fail.length} 筆` : ''}</div>
      ${ok.length ? `<div class="bulk-result-head">預設密碼：<code>${defaultPassword}</code></div>` : ''}
      ${ok.map((r) => `<div class="bulk-result-row ok">✓ ${r.nameZh}（帳號：${r.username}）</div>`).join('')}
      ${fail.map((r) => `<div class="bulk-result-row err">✗ ${r.nameZh || '?'} — ${r.error}</div>`).join('')}
    </div>`;
    const btn = document.getElementById('addSubmitBtn');
    btn.textContent = '完成';
    btn.onclick = async () => { closeAddModal(); await fetchMembers(isSystemAdmin() ? selectedClubId : undefined); };
  } catch (e) { alert(e.message); }
}

function sortBy(key) {
  sortDir = (sortKey === key && sortDir === 'asc') ? 'desc' : 'asc';
  sortKey = key;
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    const ic = th.querySelector('.sort-icon');
    if (ic) ic.textContent = '↕';
  });
  const active = document.querySelector(`th[data-key="${key}"]`);
  if (active) {
    active.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    const ic = active.querySelector('.sort-icon');
    if (ic) ic.textContent = sortDir === 'asc' ? '↑' : '↓';
  }
  renderList();
}

function renderList() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();

  let filtered = members.filter((m) => (m.status || 'active') === filterStatus);

  if (q) {
    filtered = filtered.filter((m) =>
      (m.nameZh || '').toLowerCase().includes(q) ||
      (m.nameEn || '').toLowerCase().includes(q) ||
      (m.level || '').toLowerCase().includes(q) ||
      (m.username || '').toLowerCase().includes(q));
  }

  if (sortKey) {
    filtered = [...filtered].sort((a, b) => {
      const av = (a[sortKey] ?? '').toString().toLowerCase();
      const bv = (b[sortKey] ?? '').toString().toLowerCase();
      const cmp = av.localeCompare(bv, 'zh-TW');
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  document.getElementById('badgeCount').textContent = `${filtered.length} 位`;

  const tbody = document.getElementById('memberTableBody');
  if (!filtered.length) {
    const emptyMsg = filterStatus === 'pending' ? '目前沒有待審核的申請' : '沒有符合的會員';
    tbody.innerHTML = `<tr><td colspan="${colCount()}"><div class="table-empty">${emptyMsg}</div></td></tr>`;
    return;
  }

  const canEdit = canWrite();
  const showRole = isSystemAdmin();
  tbody.innerHTML = filtered.map((m) => {
    const isPending = filterStatus === 'pending';
    // The seeded `admin` account must stay deletable-proof (backend rejects it too).
    const isRootAdmin = m.username === 'admin';
    const roleLabel = ROLE_LABEL[m.role] || m.role;
    const actions = isPending
      ? `<button class="btn-approve-row" onclick="window.__memberApprove('${m.username}')">批准</button>
         <button class="btn-reject-row"  onclick="window.__memberReject('${m.username}')">拒絕</button>`
      : (canEdit
          ? `<button class="btn-edit-row" onclick="window.__memberOpenModal('${m.username}')">
              <svg class="btn-edit-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              <span class="btn-edit-label">編輯</span>
             </button>
             <button class="btn-del-row" onclick="window.__memberDelete('${m.username}')" title="${isRootAdmin ? 'admin 帳號不可刪除' : '刪除會員'}" ${isRootAdmin ? 'disabled' : ''}>
               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
             </button>`
          : '—');
    return `
    <tr>
      <td>
        <div class="td-member">
          <div class="mc-avatar">${(m.nameZh || m.username).charAt(0)}</div>
          <div>
            <div class="mc-name-zh">${m.nameZh || '—'}</div>
            <div class="mc-name-en">${m.nameEn || '—'}</div>
            <div class="mc-username">@${m.username}</div>
            ${showRole ? `<div class="mc-role-inline">${roleLabel}</div>` : ''}
          </div>
        </div>
      </td>
      <td class="col-level"><span class="level-badge">${m.level || 'TM'}</span></td>
      ${showRole ? `<td class="col-role"><span class="role-badge ${m.role}">${roleLabel}</span></td>` : ''}
      <td class="col-club" style="font-size:12px;color:${m.clubName ? '#0f172a' : '#94a3b8'}">${m.clubName || '—'}</td>
      <td class="col-actions td-actions">${actions}</td>
    </tr>`;
  }).join('');
}

async function approveUser(username) {
  try {
    await apiJson(`/users/${username}/approve`, { method: 'PUT' });
    await fetchMembers(isSystemAdmin() ? selectedClubId : undefined);
  } catch (e) { alert(e.message); }
}

async function rejectUser(username) {
  if (!confirm(`確定要拒絕「${username}」的加入申請嗎？此操作無法復原。`)) return;
  try {
    await apiJson(`/users/${username}/reject`, { method: 'DELETE' });
    await fetchMembers(isSystemAdmin() ? selectedClubId : undefined);
  } catch (e) { alert(e.message); }
}

async function deleteMember(username) {
  if (username === 'admin') return;
  if (!confirm(`確定要刪除會員「${username}」嗎？此操作無法復原。`)) return;
  try {
    await apiJson(`/users/${username}`, { method: 'DELETE' });
    await fetchMembers(isSystemAdmin() ? selectedClubId : undefined);
  } catch (e) { alert(e.message); }
}

function openModal(username) {
  const m = members.find((m) => m.username === username);
  if (!m) return;
  editingUsername = username;
  document.getElementById('mUsername').textContent = m.username;
  document.getElementById('mUserFullname').textContent =
    [m.nameZh, m.nameEn].filter(Boolean).join(' / ') || '—';
  document.getElementById('fNameZh').value = m.nameZh || '';
  document.getElementById('fNameEn').value = m.nameEn || '';
  document.getElementById('fLevel').value = m.level || 'TM';
  document.getElementById('fRole').value = m.role || 'club_member';
  document.getElementById('fClubId').value = m.clubId ?? '';
  // admin's role is fixed — the backend rejects changing it.
  document.getElementById('fRole').disabled = username === 'admin';
  document.getElementById('fResetPw').value = '';
  const resetMsg = document.getElementById('resetPwMsg');
  resetMsg.textContent = '';
  resetMsg.className = 'resetpw-msg';
  document.getElementById('modal').classList.add('open');
  applyRoleUI();
  document.getElementById('fNameZh').focus();
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
  editingUsername = null;
}

async function resetMemberPassword() {
  const input = document.getElementById('fResetPw');
  const msgEl = document.getElementById('resetPwMsg');
  const pw = input.value.trim();
  msgEl.textContent = '';
  msgEl.className = 'resetpw-msg';
  if (pw.length < 6) {
    msgEl.textContent = '新密碼至少需要 6 個字元';
    msgEl.classList.add('is-error');
    return;
  }
  if (!confirm(`確定要將「${editingUsername}」的密碼重設為你輸入的臨時密碼嗎？\n對方下次登入時會被要求重新設定密碼。`)) return;
  try {
    await apiJson(`/users/${editingUsername}/reset-password`, { method: 'PUT', body: { new_password: pw } });
    input.value = '';
    msgEl.textContent = '密碼已重設，請將臨時密碼告知對方。';
    msgEl.classList.add('is-success');
  } catch (e) {
    msgEl.textContent = e.message;
    msgEl.classList.add('is-error');
  }
}

async function saveMember() {
  const body = {
    name_zh: document.getElementById('fNameZh').value.trim(),
    name_en: document.getElementById('fNameEn').value.trim(),
    level: document.getElementById('fLevel').value.trim() || 'TM',
  };
  if (!body.name_zh || !body.name_en) { alert('請填入中英文姓名'); return; }
  if (isSystemAdmin()) {
    const clubVal = document.getElementById('fClubId').value;
    body.role = document.getElementById('fRole').value;
    body.club_id = clubVal ? parseInt(clubVal) : null;
  }
  try {
    await apiJson(`/users/${editingUsername}`, { method: 'PUT', body });
    closeModal();
    await fetchMembers(isSystemAdmin() ? selectedClubId : undefined);
  } catch (e) {
    alert(e.message);
  }
}

export default function MemberPage() {
  useEffect(() => {
    window.__memberApprove = approveUser;
    window.__memberReject = rejectUser;
    window.__memberOpenModal = openModal;
    window.__memberDelete = deleteMember;

    const addModalOutsideClick = (e) => {
      const modal = document.getElementById('addModal');
      if (e.target === modal) closeAddModal();
    };
    const modalOutsideClick = (e) => {
      const modal = document.getElementById('modal');
      if (e.target === modal) closeModal();
    };
    document.getElementById('addModal').addEventListener('click', addModalOutsideClick);
    document.getElementById('modal').addEventListener('click', modalOutsideClick);

    applyRoleUI();

    (async function init() {
      applyRoleUI();
      const ok = await checkMemberAuth();
      if (!ok) return;
      if (isSystemAdmin()) await loadClubs();
      await fetchMembers();
    })();

    return () => {
      document.getElementById('addModal')?.removeEventListener('click', addModalOutsideClick);
      document.getElementById('modal')?.removeEventListener('click', modalOutsideClick);
      delete window.__memberApprove;
      delete window.__memberReject;
      delete window.__memberOpenModal;
      delete window.__memberDelete;
      if (levelChart) { levelChart.destroy(); levelChart = null; }
    };
  }, []);

  return (
    <>
      <Script
        src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"
        strategy="afterInteractive"
        onLoad={() => updateStats()}
      />
      <Sidebar active="member" />

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">會員管理</div>
          <div className="topbar-actions">
            <button className="btn-add write-action" onClick={openAddModal}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
              新增會員
            </button>
          </div>
        </header>

        <div className="content">
          <div id="clubPickerBar" style={{ display: 'none' }}>
            <div className="picker-card">
              <span className="picker-label">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                查看分會
              </span>
              <select id="clubPickerSelect" className="picker-select" onChange={onClubPickerChange}>
                <option value="">— 請選擇分會 —</option>
              </select>
            </div>
          </div>

          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-icon blue">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statTotal">—</div>
                <div className="stat-label">會員總數</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon gold">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statDtm">—</div>
                <div className="stat-label">DTM 會員</div>
              </div>
            </div>
            <div className="stat-card system-admin-only" style={{ display: 'none' }}>
              <div className="stat-icon red">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/><path d="M16 11l1.5 1.5L21 9"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statAdmins">—</div>
                <div className="stat-label">管理員數</div>
              </div>
            </div>
            <div className="stat-card system-admin-only" style={{ display: 'none' }}>
              <div className="stat-icon green">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statMembers">—</div>
                <div className="stat-label">一般會員數</div>
              </div>
            </div>
          </div>

          <div className="chart-card">
            <div className="chart-header">
              <span className="chart-title">等級分布</span>
              <span className="chart-subtitle" id="chartSubtitle"></span>
            </div>
            <div className="chart-body">
              <canvas id="levelChart"></canvas>
            </div>
            <div className="level-legend" id="levelLegend"></div>
          </div>

          <div className="table-card">
            <div className="table-header">
              <div className="table-header-left">
                <span className="table-title">會員名單</span>
                <span className="badge-count" id="badgeCount">0 位</span>
              </div>
            </div>

            <div className="filter-tabs write-action">
              <button className="filter-tab active" id="filterActive" onClick={() => setFilter('active')}>正式會員</button>
              <button className="filter-tab" id="filterPending" onClick={() => setFilter('pending')}>
                待審核申請 <span className="pending-badge zero" id="pendingBadge">0</span>
              </button>
            </div>

            <div className="search-wrap">
              <input type="text" className="search-input" id="searchInput" placeholder="搜尋帳號、姓名或等級…" onInput={renderList} />
            </div>

            <div className="member-table-wrap">
              <table className="member-list">
                <thead>
                  <tr>
                    <th className="sortable" data-key="nameZh" onClick={() => sortBy('nameZh')}>會員 <i className="sort-icon">↕</i></th>
                    <th className="sortable col-level" data-key="level" onClick={() => sortBy('level')}>等級 <i className="sort-icon">↕</i></th>
                    <th className="sortable col-role system-admin-only" data-key="role" style={{ display: 'none' }} onClick={() => sortBy('role')}>角色 <i className="sort-icon">↕</i></th>
                    <th className="sortable col-club" data-key="clubName" onClick={() => sortBy('clubName')}>分會 <i className="sort-icon">↕</i></th>
                    <th className="col-actions" style={{ textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody id="memberTableBody">
                  <tr><td colSpan="5"><div className="loading-spinner"><div className="spinner"></div></div></td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div className="modal-overlay" id="addModal">
        <div className="modal modal-wide">
          <div className="modal-header">
            <h3>新增會員</h3>
            <button className="modal-close" onClick={closeAddModal}>✕</button>
          </div>
          <div className="modal-tabs">
            <button className="modal-tab active" data-tab="single" onClick={() => switchAddTab('single')}>單筆</button>
            <button className="modal-tab" data-tab="bulk" onClick={() => switchAddTab('bulk')}>多筆匯入</button>
          </div>
          <div id="addSingle">
            <div className="modal-field">
              <label>中文姓名</label>
              <input type="text" id="addNameZh" placeholder="蔡宜容" />
            </div>
            <div className="modal-field">
              <label>英文姓名</label>
              <input type="text" id="addNameEn" placeholder="Lia Tsai" onInput={autoUsername} />
            </div>
            <div className="modal-field">
              <label>等級</label>
              <input type="text" id="addLevel" placeholder="TM" defaultValue="TM" />
            </div>
            <div className="modal-field">
              <label>帳號（自動產生，可修改）</label>
              <input type="text" id="addUsername" placeholder="liatsai" />
            </div>
            <div className="modal-field">
              <label>預設密碼</label>
              <input type="text" id="addPassword" defaultValue="Toastmasters1" />
            </div>
            <div className="modal-field system-admin-only" style={{ display: 'none' }}>
              <label>角色</label>
              <select id="addRole" defaultValue="club_member">
                <option value="club_member">club_member — 一般會員（唯讀）</option>
                <option value="club_admin">club_admin — 分會管理員（可編輯本分會）</option>
                <option value="system_admin">system_admin — 系統管理員（全權限）</option>
              </select>
            </div>
            <div className="modal-field system-admin-only" style={{ display: 'none' }}>
              <label>所屬分會</label>
              <select id="addClubId">
                <option value="">— 未分配 —</option>
              </select>
            </div>
          </div>
          <div id="addBulk" style={{ display: 'none' }}>
            <div className="bulk-hint">
              每行一筆：<code>中文姓名,英文姓名,等級</code><br />
              等級可省略（預設 TM）。帳號自動依英文姓名產生，角色一律為一般會員。
            </div>
            <textarea id="bulkText" className="bulk-textarea" placeholder={'李大明,David Li,L2\n王小明,Xiao Ming Wang,TM\n陳美麗,Mary Chen'}></textarea>
            <div className="modal-field" style={{ marginTop: 10 }}>
              <label>預設密碼（所有人相同）</label>
              <input type="text" id="bulkPassword" defaultValue="Toastmasters1" />
            </div>
          </div>
          <div id="addResults" style={{ display: 'none' }}></div>
          <div className="modal-actions">
            <button className="btn-modal-cancel" onClick={closeAddModal}>取消</button>
            <button className="btn-modal-save" id="addSubmitBtn" onClick={submitAdd}>儲存</button>
          </div>
        </div>
      </div>

      <div className="modal-overlay" id="modal">
        <div className="modal">
          <div className="modal-header">
            <h3>編輯會員資料</h3>
            <button className="modal-close" onClick={closeModal}>✕</button>
          </div>
          <div className="modal-user-info">
            <div className="modal-user-info-name" id="mUsername"></div>
            <div className="modal-user-info-sub" id="mUserFullname"></div>
          </div>
          <div className="modal-field">
            <label>中文姓名</label>
            <input type="text" id="fNameZh" placeholder="蔡宜容" />
          </div>
          <div className="modal-field">
            <label>英文姓名</label>
            <input type="text" id="fNameEn" placeholder="Lia Tsai" />
          </div>
          <div className="modal-field">
            <label>等級</label>
            <input type="text" id="fLevel" placeholder="TM / L1 / L2 / L3 / L4 / L5 / DTM" />
          </div>
          <div className="modal-field system-admin-only" style={{ display: 'none' }}>
            <label>角色</label>
            <select id="fRole">
              <option value="club_member">club_member — 一般會員（唯讀）</option>
              <option value="club_admin">club_admin — 分會管理員（可編輯本分會）</option>
              <option value="system_admin">system_admin — 系統管理員（全權限）</option>
            </select>
          </div>
          <div className="modal-field system-admin-only" style={{ display: 'none' }}>
            <label>所屬分會</label>
            <select id="fClubId">
              <option value="">— 未分配 —</option>
            </select>
          </div>
          <div className="modal-field modal-field-resetpw">
            <label>重設密碼</label>
            <div className="modal-resetpw-row">
              <input type="text" id="fResetPw" placeholder="輸入新的臨時密碼（至少 6 碼）" autoComplete="off" />
              <button type="button" className="btn-resetpw" onClick={resetMemberPassword}>重設</button>
            </div>
            <div id="resetPwMsg" className="resetpw-msg"></div>
          </div>
          <div className="modal-actions">
            <button className="btn-modal-cancel" onClick={closeModal}>取消</button>
            <button className="btn-modal-save" onClick={saveMember}>儲存</button>
          </div>
        </div>
      </div>
    </>
  );
}
