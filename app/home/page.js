'use client';

import { useEffect } from 'react';
import { apiJson, apiFetch } from '@/lib/api';
import { setAuth, clearAuth, applyRoleUI, isSystemAdmin } from '@/lib/auth';
import Sidebar from '@/components/Sidebar';
import './home.css';

// Module-level state mirrors the original inline <script> globals — this
// page is a deliberate lift-and-shift port (imperative DOM ops kept as-is)
// rather than a state-driven rewrite. See migration plan for rationale.
let currentItems = [];
let sortKey = null;
let sortDir = 'asc';
let selectedClubId = null;
let currentDate = '';
let currentPage = 1;
const PAGE_SIZE = 10;
let homeCalYear = new Date().getFullYear();
let homeCalMonth = new Date().getMonth();
let homeCalSelected = '';
let homeCalDates = new Set();

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
  renderItems();
}

function renderItems() {
  const tbody = document.getElementById('agendaTableBody');
  let items = currentItems;
  if (!items.length) return;
  if (sortKey) {
    items = [...items].sort((a, b) => {
      const av = (a[sortKey] ?? '').toString().toLowerCase();
      const bv = (b[sortKey] ?? '').toString().toLowerCase();
      const cmp = av.localeCompare(bv, 'zh-TW');
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }
  tbody.innerHTML = items.map((item) => {
    const d = item.meetingDate || null;
    const mmdd = d ? d.slice(5).replace('-', '/') : '—';
    const year = d ? d.slice(0, 4) : '';
    const theme = item.meetingTheme || '（無主題）';
    const no = item.meetingNo ? `No.${item.meetingNo}` : '—';
    const ts = item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    return `<tr onclick="window.__homeEditAgenda(${item.id})">
      <td class="td-date">
        <div class="date-badge">
          <span class="date-badge-md">${mmdd}</span>
          <span class="date-badge-y">${year}</span>
        </div>
      </td>
      <td class="td-club system-admin-only">${item.clubName || '—'}</td>
      <td class="td-theme">${theme}</td>
      <td class="td-no">${no}</td>
      <td class="td-updated">${ts}</td>
      <td class="td-actions">
        <button class="btn-edit-row write-action" onclick="event.stopPropagation(); window.__homeEditAgenda(${item.id})">
          <svg class="btn-edit-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          <span class="btn-edit-label">編輯</span>
        </button>
        <button class="btn-del-row write-action" onclick="event.stopPropagation(); window.__homeDeleteItem(${item.id}, this)" title="刪除">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
  applyRoleUI();
}

async function loadClubs() {
  try {
    const allClubs = await apiJson('/clubs');
    const select = document.getElementById('clubPickerSelect');
    select.innerHTML = '<option value="">— 全部分會 —</option>' +
      allClubs.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
    document.getElementById('clubPickerBar').style.display = '';
  } catch { console.error('載入分會失敗'); }
}

// New agenda: carry the chosen club so /index applies that club's template.
function goNewAgenda() {
  let url = '/index';
  if (isSystemAdmin() && selectedClubId != null) url += `?club_id=${selectedClubId}`;
  location.href = url;
}

function onClubPickerChange() {
  const val = document.getElementById('clubPickerSelect').value;
  selectedClubId = val ? parseInt(val) : null;
  homeCalSelected = '';
  homeRenderCalendar();
  fetchStats();
  fetchList('');
}

async function checkHomeAuth() {
  applyRoleUI();
  try {
    const data = await apiJson('/auth/verify');
    setAuth(data.username, data.role, data.club_id, data.must_change_pw);
    if (data.must_change_pw) { location.href = '/change-password'; return; }
    document.getElementById('navUser').textContent = data.username;
    document.getElementById('userAvatar').textContent = data.username.slice(0, 1).toUpperCase();
    applyRoleUI();
  } catch {
    clearAuth();
    location.href = '/login';
  }
}

async function fetchStats() {
  try {
    const params = new URLSearchParams({ limit: 500 });
    if (isSystemAdmin() && selectedClubId != null) params.set('club_id', selectedClubId);
    const { items, total } = await apiJson(`/agendas?${params}`);

    document.getElementById('statTotal').textContent = total;

    const now = new Date();
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthCount = items.filter((i) => (i.meetingDate || '').startsWith(prefix)).length;
    document.getElementById('statMonth').textContent = monthCount;

    const withDate = items.filter((i) => i.meetingDate).sort((a, b) => b.meetingDate.localeCompare(a.meetingDate));
    if (withDate.length) {
      const d = withDate[0].meetingDate;
      const [y, m, day] = d.split('-');
      document.getElementById('statLastDate').textContent = `${y}/${m}/${day}`;
    }

    homeCalDates = new Set(items.map((i) => i.meetingDate).filter((d) => d && d.includes('-')));
    homeRenderCalendar();
  } catch { /* ignore */ }
}

function homeRenderCalendar() {
  const label = document.getElementById('homeCalLabel');
  const grid = document.getElementById('homeCalGrid');
  if (!label || !grid) return;
  label.textContent = `${homeCalYear} 年 ${homeCalMonth + 1} 月`;
  const today = new Date().toISOString().slice(0, 10);
  const firstDow = new Date(homeCalYear, homeCalMonth, 1).getDay();
  const daysInMonth = new Date(homeCalYear, homeCalMonth + 1, 0).getDate();
  let html = '';
  for (let i = 0; i < firstDow; i++) html += '<div class="cal-day cal-empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${homeCalYear}-${String(homeCalMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dot = homeCalDates.has(ds) ? '<span class="cal-dot"></span>' : '';
    let cls = 'cal-day';
    if (ds === homeCalSelected) cls += ' cal-sel';
    else if (ds === today) cls += ' cal-today';
    html += `<div class="${cls}" onclick="window.__homeCalSelectDate('${ds}')"><span>${d}</span>${dot}</div>`;
  }
  grid.innerHTML = html;
}

function homePrevMonth() {
  homeCalMonth--;
  if (homeCalMonth < 0) { homeCalMonth = 11; homeCalYear--; }
  homeRenderCalendar();
}
function homeNextMonth() {
  homeCalMonth++;
  if (homeCalMonth > 11) { homeCalMonth = 0; homeCalYear++; }
  homeRenderCalendar();
}
function homeCalSelectDate(ds) {
  homeCalSelected = ds;
  homeRenderCalendar();
  fetchList(ds, 1);
}
function homeClearFilter() {
  homeCalSelected = '';
  homeRenderCalendar();
  fetchList('', 1);
}
function toggleHomeCal() {
  const panel = document.getElementById('homeCalCard');
  const btn = document.getElementById('calToggleBtn');
  const open = !panel.classList.contains('open');
  if (open) {
    const rect = btn.getBoundingClientRect();
    panel.style.top = (rect.bottom + 6) + 'px';
    panel.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
    panel.style.left = 'auto';
  }
  panel.classList.toggle('open', open);
  btn.classList.toggle('active', open);
}

async function fetchList(date, page = 1) {
  currentDate = date;
  currentPage = page;
  const tbody = document.getElementById('agendaTableBody');
  const pgBar = document.getElementById('paginationBar');
  tbody.innerHTML = '<tr><td colspan="6"><div class="loading-spinner"><div class="spinner"></div></div></td></tr>';
  pgBar.style.display = 'none';

  try {
    const params = new URLSearchParams({ limit: PAGE_SIZE, page });
    if (date) params.set('date', date);
    if (isSystemAdmin() && selectedClubId != null) params.set('club_id', selectedClubId);
    const { items, total, pages } = await apiJson(`/agendas?${params}`);

    document.getElementById('badgeCount').textContent = `${total} 筆`;

    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="table-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <div>尚無符合的議程</div>
      </div></td></tr>`;
      currentItems = [];
      return;
    }

    currentItems = items;
    renderItems();
    renderPagination(page, pages, total);
  } catch {
    tbody.innerHTML = '<tr><td colspan="6"><div class="table-empty">載入失敗，請確認後端已啟動</div></td></tr>';
  }
}

function renderPagination(page, pages, total) {
  const pgBar = document.getElementById('paginationBar');
  const pgInfo = document.getElementById('pgInfo');
  const pgBtns = document.getElementById('pgButtons');

  if (pages <= 1) { pgBar.style.display = 'none'; return; }
  pgBar.style.display = 'flex';

  const start = (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);
  pgInfo.textContent = `顯示 ${start}–${end}，共 ${total} 筆`;

  let html = `<button class="pg-btn" onclick="window.__homePage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`;
  const delta = 2;
  const lo = Math.max(1, page - delta);
  const hi = Math.min(pages, page + delta);
  if (lo > 1) html += `<button class="pg-btn" onclick="window.__homePage(1)">1</button>${lo > 2 ? '<span style="padding:0 4px;color:#94a3b8">…</span>' : ''}`;
  for (let p = lo; p <= hi; p++) {
    html += `<button class="pg-btn ${p === page ? 'active' : ''}" onclick="window.__homePage(${p})">${p}</button>`;
  }
  if (hi < pages) html += `${hi < pages - 1 ? '<span style="padding:0 4px;color:#94a3b8">…</span>' : ''}<button class="pg-btn" onclick="window.__homePage(${pages})">${pages}</button>`;
  html += `<button class="pg-btn" onclick="window.__homePage(${page + 1})" ${page === pages ? 'disabled' : ''}>›</button>`;
  pgBtns.innerHTML = html;
}

function editAgenda(id) { location.href = `/index?id=${id}`; }

async function deleteItem(id, btn) {
  if (!confirm('確定要刪除這份議程嗎？')) return;
  try {
    const res = await apiFetch(`/agendas/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    btn.closest('tr').remove();
    fetchStats();
  } catch { alert('刪除失敗'); }
}

export default function HomePage() {
  useEffect(() => {
    // Bridge for onclick="..." strings inside innerHTML-generated markup
    // (table rows / calendar / pagination) — same approach the legacy
    // pages used via global functions, just namespaced on window here.
    window.__homeEditAgenda = editAgenda;
    window.__homeDeleteItem = deleteItem;
    window.__homeCalSelectDate = homeCalSelectDate;
    // Takes only a page number: an inline onclick runs in global scope, so it
    // cannot read this module's `currentDate` — the bridge supplies it instead.
    window.__homePage = (page) => fetchList(currentDate, page);

    const outsideClickHandler = (e) => {
      const panel = document.getElementById('homeCalCard');
      const btn = document.getElementById('calToggleBtn');
      if (panel.classList.contains('open') && !panel.contains(e.target) && !btn.contains(e.target)) {
        panel.classList.remove('open');
        btn.classList.remove('active');
      }
    };
    document.addEventListener('click', outsideClickHandler);

    applyRoleUI();

    (async function init() {
      await checkHomeAuth();
      homeRenderCalendar();
      if (isSystemAdmin()) {
        await loadClubs();
      }
      fetchStats();
      fetchList('');
    })();

    return () => {
      document.removeEventListener('click', outsideClickHandler);
      delete window.__homeEditAgenda;
      delete window.__homeDeleteItem;
      delete window.__homeCalSelectDate;
      delete window.__homePage;
    };
  }, []);

  return (
    <>
      <Sidebar active="home" navOverrides={{ index: goNewAgenda }} />

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">議程管理</div>
          <div className="topbar-actions">
            <button className="btn-primary write-action" onClick={goNewAgenda}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
              新建議程
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
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statTotal">—</div>
                <div className="stat-label">議程總數</div>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon green">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statMonth">—</div>
                <div className="stat-label">本月議程</div>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon red">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <div className="stat-body">
                <div className="stat-value" id="statLastDate" style={{ fontSize: 18 }}>—</div>
                <div className="stat-label">最近一次會議</div>
              </div>
            </div>
          </div>

          <div className="table-card">
            <div className="table-header">
              <div className="table-header-left">
                <span className="table-title">過往議程</span>
                <span className="badge-count" id="badgeCount">0 筆</span>
              </div>
              <button id="calToggleBtn" className="btn-cal-toggle" onClick={toggleHomeCal}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                日期篩選
              </button>

              <div className="cal-panel" id="homeCalCard">
                <div className="cal-nav">
                  <button className="cal-nav-btn" onClick={homePrevMonth}>&#8249;</button>
                  <span id="homeCalLabel" className="cal-month-label"></span>
                  <button className="cal-nav-btn" onClick={homeNextMonth}>&#8250;</button>
                  <button className="btn-cal-all" onClick={homeClearFilter}>全部</button>
                </div>
                <div className="cal-weekdays">
                  <div>日</div><div>一</div><div>二</div><div>三</div><div>四</div><div>五</div><div>六</div>
                </div>
                <div id="homeCalGrid" className="cal-grid"></div>
              </div>
            </div>

            <div className="agenda-table-wrap">
              <table className="agenda-list">
                <thead>
                  <tr>
                    <th className="sortable" data-key="meetingDate" onClick={() => sortBy('meetingDate')}>日期 <i className="sort-icon">↕</i></th>
                    <th className="sortable system-admin-only" data-key="clubName" onClick={() => sortBy('clubName')}>分會 <i className="sort-icon">↕</i></th>
                    <th className="sortable" data-key="meetingTheme" onClick={() => sortBy('meetingTheme')}>會議主題 <i className="sort-icon">↕</i></th>
                    <th className="sortable" data-key="meetingNo" onClick={() => sortBy('meetingNo')}>編號 <i className="sort-icon">↕</i></th>
                    <th className="sortable" data-key="updatedAt" onClick={() => sortBy('updatedAt')}>最後更新 <i className="sort-icon">↕</i></th>
                    <th style={{ textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody id="agendaTableBody">
                  <tr><td colSpan="6"><div className="loading-spinner"><div className="spinner"></div></div></td></tr>
                </tbody>
              </table>
            </div>

            <div className="pagination" id="paginationBar" style={{ display: 'none' }}>
              <span className="pg-info" id="pgInfo"></span>
              <div className="pg-buttons" id="pgButtons"></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
