'use client';

import { useEffect } from 'react';
import { apiJson } from '@/lib/api';
import { setAuth, clearAuth, applyRoleUI, isSystemAdmin, canWrite } from '@/lib/auth';
import Sidebar from '@/components/Sidebar';
import SearchableSelect from '@/components/SearchableSelect';
import './machines.css';
import { withBase } from '@/lib/basePath';

// 機台管理 — electronic name badges. A badge registers itself and shows a
// pairing code; a club admin (or above) enters the code here and picks the
// member it should show. Club admins see their current club's badges; a
// system admin picks a club (or sees all) and must pick one to pair into.
// Ordinary members never reach this page (nav hidden, backend 403s).
let machines = [];
let clubMembers = [];      // active members of the club being paired into / edited
let membersClubId = null;  // which club `clubMembers` was loaded for
let selectedClubId = null; // system admin's club picker
let editingId = null;

// A badge reads its content about once a minute; a few missed reads is offline.
const ONLINE_WINDOW_MS = 3 * 60 * 1000;

const STATUS_LABEL = { active: '使用中', pending: '未綁定', disabled: '已停用' };

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function isOnline(m) {
  return !!m.lastSeenAt && Date.now() - new Date(m.lastSeenAt).getTime() < ONLINE_WINDOW_MS;
}

function formatSeen(iso) {
  if (!iso) return '從未上線';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return '剛剛';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  return `${Math.floor(hr / 24)} 天前`;
}

function formatTime(iso) {
  return iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '';
}

async function checkMachinesAuth() {
  try {
    const data = await apiJson('/auth/verify');
    setAuth(data.username, data.role, data.club_id, data.must_change_pw, data.memberships);
    if (data.must_change_pw) { location.href = withBase('/change-password'); return false; }
    if (!canWrite()) { location.href = withBase('/home'); return false; }
    document.getElementById('navUser').textContent = data.username;
    document.getElementById('userAvatar').textContent = data.username.slice(0, 1).toUpperCase();
    applyRoleUI();
    return true;
  } catch {
    clearAuth();
    location.href = withBase('/login');
    return false;
  }
}

async function loadClubs() {
  try {
    const clubs = await apiJson('/clubs');
    const options = clubs.map((c) => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
    document.getElementById('clubPickerSelect').innerHTML = '<option value="">— 全部分會 —</option>' + options;
    document.getElementById('clubPickerBar').style.display = '';
  } catch {
    console.error('載入分會失敗');
  }
}

function onClubPickerChange() {
  const val = document.getElementById('clubPickerSelect').value;
  selectedClubId = val ? parseInt(val) : null;
  fetchMachines();
}

async function fetchMachines() {
  document.getElementById('machineTableBody').innerHTML =
    '<tr><td colspan="5"><div class="loading-spinner"><div class="spinner"></div></div></td></tr>';
  try {
    const qs = isSystemAdmin() && selectedClubId != null ? `?club_id=${selectedClubId}` : '';
    machines = await apiJson(`/machines${qs}`);
    updateStats();
    renderList();
  } catch (e) {
    document.getElementById('machineTableBody').innerHTML =
      `<tr><td colspan="5"><div class="table-empty">載入失敗：${escHtml(e.message)}</div></td></tr>`;
  }
}

function updateStats() {
  document.getElementById('statTotal').textContent = machines.length;
  document.getElementById('statActive').textContent = machines.filter((m) => m.status === 'active').length;
  document.getElementById('statOnline').textContent = machines.filter(isOnline).length;
  document.getElementById('statDisabled').textContent = machines.filter((m) => m.status === 'disabled').length;
}

function renderList() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const list = q
    ? machines.filter((m) => [m.name, m.serial, m.nameZh, m.nameEn, m.username, m.clubName]
        .some((v) => (v || '').toLowerCase().includes(q)))
    : machines;
  document.getElementById('badgeCount').textContent = `${list.length} 台`;

  const tbody = document.getElementById('machineTableBody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="table-empty">${machines.length ? '沒有符合的機台' : '尚無機台，按右上角「配對新名牌」開始'}</div></td></tr>`;
    return;
  }
  const showClub = isSystemAdmin() && selectedClubId == null;
  tbody.innerHTML = list.map((m) => {
    const member = m.username
      ? `<div class="mc-name-zh">${escHtml(m.nameZh || m.username)}</div>
         <div class="mc-name-en">${escHtml(m.nameEn)}${m.level ? ` · ${escHtml(m.level)}` : ''}</div>
         ${m.bindingValid ? '' : '<div class="mc-warn">已不是本分會會員，名牌不會顯示</div>'}`
      : '<span class="mc-muted">—</span>';
    return `
    <tr>
      <td>
        <div class="mc-name-zh">${escHtml(m.name) || '<span class="mc-muted">未命名</span>'}</div>
        <div class="mc-username">${escHtml(m.serial)}</div>
        ${showClub ? `<div class="mc-name-en">${escHtml(m.clubName)}</div>` : ''}
      </td>
      <td>${member}</td>
      <td class="col-status"><span class="status-badge ${m.status}">${STATUS_LABEL[m.status] || m.status}</span></td>
      <td class="col-seen" title="${escHtml(formatTime(m.lastSeenAt))}">
        <span class="online-dot ${isOnline(m) ? 'on' : ''}"></span>${formatSeen(m.lastSeenAt)}
      </td>
      <td class="col-actions td-actions">
        <button class="btn-edit-row" onclick="window.__machineEdit(${m.id})">編輯</button>
        <button class="btn-del-row" onclick="window.__machineDelete(${m.id})" title="刪除機台">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

// Fills a member <select> with the active members of `clubId`.
async function loadClubMembers(clubId) {
  if (membersClubId === clubId && clubMembers.length) return;
  const qs = isSystemAdmin() ? `?club_id=${clubId}` : '';
  const users = await apiJson(`/users${qs}`);
  clubMembers = users.filter((u) => (u.status || 'active') === 'active');
  membersClubId = clubId;
}

function memberOptions(placeholder) {
  return `<option value="">${placeholder}</option>` + clubMembers.map((u) =>
    `<option value="${escHtml(u.username)}">${escHtml([u.nameZh, u.nameEn].filter(Boolean).join(' / ') || u.username)}（@${escHtml(u.username)}）</option>`,
  ).join('');
}

function setMsg(id, text, isError = true) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'form-msg' + (text ? (isError ? ' is-error' : ' is-success') : '');
}

// ---------------------------------------------------------------- pair
async function openPairModal() {
  const clubId = isSystemAdmin() ? selectedClubId : 'own';
  if (clubId == null) { alert('請先在上方選擇要配對到哪個分會'); return; }
  document.getElementById('pCode').value = '';
  document.getElementById('pName').value = '';
  setMsg('pMsg', '');
  document.getElementById('pairModal').classList.add('open');
  document.getElementById('pCode').focus();
  try {
    await loadClubMembers(clubId);
    document.getElementById('pMember').innerHTML = memberOptions('— 請選擇會員 —');
  } catch (e) { setMsg('pMsg', `載入會員失敗：${e.message}`); }
}

function closePairModal() {
  document.getElementById('pairModal').classList.remove('open');
}

async function submitPair() {
  const code = document.getElementById('pCode').value.trim();
  const username = document.getElementById('pMember').value;
  if (!code) { setMsg('pMsg', '請輸入名牌螢幕上的配對碼'); return; }
  if (!username) { setMsg('pMsg', '請選擇要綁定的會員'); return; }
  try {
    await apiJson('/machines/pair', {
      method: 'POST',
      body: {
        code, username,
        name: document.getElementById('pName').value.trim() || null,
        club_id: isSystemAdmin() ? selectedClubId : null,
      },
    });
    closePairModal();
    await fetchMachines();
  } catch (e) { setMsg('pMsg', e.message); }
}

// ---------------------------------------------------------------- edit
async function openEditModal(id) {
  const m = machines.find((x) => x.id === id);
  if (!m) return;
  editingId = id;
  document.getElementById('eSerial').textContent = m.serial;
  document.getElementById('eSub').textContent = [
    m.clubName,
    m.boundAt ? `綁定於 ${formatTime(m.boundAt)}${m.boundBy ? `（${m.boundBy}）` : ''}` : '',
  ].filter(Boolean).join('・');
  document.getElementById('eName').value = m.name || '';
  document.getElementById('eStatus').value = m.status === 'disabled' ? 'disabled' : 'active';
  document.getElementById('eUnbindBtn').disabled = !m.username;
  setMsg('eMsg', '');
  document.getElementById('editModal').classList.add('open');
  try {
    await loadClubMembers(isSystemAdmin() ? m.clubId : 'own');
    document.getElementById('eMember').innerHTML = memberOptions('— 未綁定 —');
    document.getElementById('eMember').value = m.username || '';
  } catch (e) { setMsg('eMsg', `載入會員失敗：${e.message}`); }
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('open');
  editingId = null;
}

async function saveMachine() {
  const m = machines.find((x) => x.id === editingId);
  if (!m) return;
  const username = document.getElementById('eMember').value;
  if (m.username && !username) {
    setMsg('eMsg', '要取消綁定請按「解除綁定」');
    return;
  }
  try {
    await apiJson(`/machines/${editingId}`, {
      method: 'PUT',
      body: {
        name: document.getElementById('eName').value,
        username: username && username !== m.username ? username : null,
        status: document.getElementById('eStatus').value,
      },
    });
    closeEditModal();
    await fetchMachines();
  } catch (e) { setMsg('eMsg', e.message); }
}

async function unbindMachine() {
  if (!confirm('確定要解除綁定嗎？\n名牌會回到配對畫面，之後需要重新輸入配對碼。')) return;
  try {
    await apiJson(`/machines/${editingId}`, { method: 'PUT', body: { unbind: true } });
    closeEditModal();
    await fetchMachines();
  } catch (e) { setMsg('eMsg', e.message); }
}

async function deleteMachine(id) {
  const m = machines.find((x) => x.id === id);
  if (!m) return;
  if (!confirm(`確定要刪除機台「${m.name || m.serial}」嗎？\n名牌會回到配對畫面，紀錄無法復原。`)) return;
  try {
    await apiJson(`/machines/${id}`, { method: 'DELETE' });
    await fetchMachines();
  } catch (e) { alert(e.message); }
}

export default function MachinesPage() {
  useEffect(() => {
    window.__machineEdit = openEditModal;
    window.__machineDelete = deleteMachine;

    const outside = (id, close) => (e) => { if (e.target === document.getElementById(id)) close(); };
    const pairOutside = outside('pairModal', closePairModal);
    const editOutside = outside('editModal', closeEditModal);
    document.getElementById('pairModal').addEventListener('click', pairOutside);
    document.getElementById('editModal').addEventListener('click', editOutside);

    // "x 分鐘前" goes stale on an open page; redraw it now and then.
    const tick = setInterval(() => { if (machines.length) { updateStats(); renderList(); } }, 30000);

    (async function init() {
      applyRoleUI();
      const ok = await checkMachinesAuth();
      if (!ok) return;
      if (isSystemAdmin()) await loadClubs();
      await fetchMachines();
    })();

    return () => {
      clearInterval(tick);
      document.getElementById('pairModal')?.removeEventListener('click', pairOutside);
      document.getElementById('editModal')?.removeEventListener('click', editOutside);
      delete window.__machineEdit;
      delete window.__machineDelete;
    };
  }, []);

  return (
    <>
      <Sidebar active="machines" />

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">機台管理</div>
          <div className="topbar-actions">
            <button className="btn-add" onClick={openPairModal}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
              配對新名牌
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
              <SearchableSelect id="clubPickerSelect" className="picker-select" onChange={onClubPickerChange} placeholder="輸入分會名稱搜尋…" emptyText="找不到符合的分會">
                <option value="">— 全部分會 —</option>
              </SearchableSelect>
            </div>
          </div>

          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-icon blue">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="6" width="16" height="14" rx="2"/><path d="M9 6V4h6v2"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statTotal">—</div>
                <div className="stat-label">機台總數</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon gold">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statActive">—</div>
                <div className="stat-label">使用中</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon green">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statOnline">—</div>
                <div className="stat-label">目前在線</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon red">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statDisabled">—</div>
                <div className="stat-label">已停用</div>
              </div>
            </div>
          </div>

          <div className="table-card">
            <div className="table-header">
              <div className="table-header-left">
                <span className="table-title">名牌列表</span>
                <span className="badge-count" id="badgeCount">0 台</span>
              </div>
            </div>
            <div className="search-wrap">
              <input type="text" className="search-input" id="searchInput" placeholder="搜尋名稱、序號或會員…" onInput={renderList} />
            </div>
            <div className="machine-table-wrap">
              <table className="machine-list">
                <thead>
                  <tr>
                    <th>名牌</th>
                    <th>綁定會員</th>
                    <th className="col-status">狀態</th>
                    <th className="col-seen">最後上線</th>
                    <th className="col-actions" style={{ textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody id="machineTableBody">
                  <tr><td colSpan="5"><div className="loading-spinner"><div className="spinner"></div></div></td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div className="modal-overlay" id="pairModal">
        <div className="modal">
          <div className="modal-header">
            <h3>配對新名牌</h3>
            <button className="modal-close" onClick={closePairModal}>✕</button>
          </div>
          <p className="modal-hint">
            把名牌開機並連上網路，螢幕會顯示 6 碼配對碼（10 分鐘內有效）。輸入配對碼並選擇會員，名牌就會改顯示這位會員的資料。
          </p>
          <div className="modal-field">
            <label>配對碼</label>
            <input type="text" id="pCode" className="code-input" placeholder="例如 K7QX4M" maxLength={9} autoComplete="off" />
          </div>
          <div className="modal-field">
            <label>綁定會員</label>
            <SearchableSelect id="pMember" placeholder="輸入姓名或帳號搜尋…" emptyText="找不到符合的會員">
              <option value="">— 請選擇會員 —</option>
            </SearchableSelect>
          </div>
          <div className="modal-field">
            <label>名牌名稱（選填）</label>
            <input type="text" id="pName" placeholder="例如 名牌 #3" maxLength={100} />
          </div>
          <div id="pMsg" className="form-msg"></div>
          <div className="modal-actions">
            <button className="btn-modal-cancel" onClick={closePairModal}>取消</button>
            <button className="btn-modal-save" onClick={submitPair}>配對</button>
          </div>
        </div>
      </div>

      <div className="modal-overlay" id="editModal">
        <div className="modal">
          <div className="modal-header">
            <h3>編輯名牌</h3>
            <button className="modal-close" onClick={closeEditModal}>✕</button>
          </div>
          <div className="modal-user-info">
            <div className="modal-user-info-name" id="eSerial"></div>
            <div className="modal-user-info-sub" id="eSub"></div>
          </div>
          <div className="modal-field">
            <label>名牌名稱</label>
            <input type="text" id="eName" maxLength={100} />
          </div>
          <div className="modal-field">
            <label>綁定會員</label>
            <SearchableSelect id="eMember" placeholder="輸入姓名或帳號搜尋…" emptyText="找不到符合的會員">
              <option value="">— 未綁定 —</option>
            </SearchableSelect>
            <div className="field-hint">換成其他會員後，名牌會在一分鐘內自動更新，不需要重新配對。</div>
          </div>
          <div className="modal-field">
            <label>狀態</label>
            <select id="eStatus">
              <option value="active">啟用</option>
              <option value="disabled">停用（名牌顯示「已停用」，保留綁定）</option>
            </select>
          </div>
          <div id="eMsg" className="form-msg"></div>
          <div className="modal-actions">
            <button className="btn-unbind" id="eUnbindBtn" onClick={unbindMachine}>解除綁定</button>
            <button className="btn-modal-cancel" onClick={closeEditModal}>取消</button>
            <button className="btn-modal-save" onClick={saveMachine}>儲存</button>
          </div>
        </div>
      </div>
    </>
  );
}
