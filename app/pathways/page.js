'use client';

import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api';
import { setAuth, clearAuth, applyRoleUI, isSystemAdmin } from '@/lib/auth';
import { LEVELS, loadPathways, getPathwayCatalog, setPathwayCatalog } from '@/lib/pathways';
import Sidebar from '@/components/Sidebar';
import './pathways.css';
import { withBase } from '@/lib/basePath';

// ================================================================
// Pathways 路徑管理 — edit the catalog behind the Pathways dropdowns
// ================================================================
// Same imperative-DOM style as the other pages (see app/roles/page.js for the
// rationale). The whole catalog is edited as one local draft and saved in one
// PUT /api/pathways, which replaces it atomically on the server.
//
// Inside the draft, lists reference projects by a stable key (`k`), not by
// name: renaming a project is then a one-field edit, and a half-typed name that
// momentarily equals another project's can't merge the two. Keys are turned
// back into English names only when saving.

let draft    = null;   // { projects:[{k,id,en,zh}], paths:[{code,en,zh,legacy,isNew,required:{lvl:[k]}}], electives:{lvl:[k]} }
let baseline = '';     // JSON of the draft as last loaded/saved
let tab      = 'paths';
let selected = null;   // the path open in the editor (a draft object — a new path has no code yet)
let search   = '';
let nextKey  = 1;
let toastTimer = null;

let setSaveDisabled = null;   // React bridges (see the note in app/roles/page.js)
let setSaveLabel    = null;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'toast visible' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3600);
}

// ---------------------------------------------------------------- draft
function toDraft(cat) {
  const keyOf = new Map();
  const projects = cat.projects.map((p) => {
    const k = `p${nextKey++}`;
    keyOf.set(p.en, k);
    return { k, id: p.id, en: p.en, zh: p.zh };
  });
  const keys = (names) => (names || []).map((n) => keyOf.get(n)).filter(Boolean);
  const levels = (obj) => Object.fromEntries(LEVELS.map((l) => [l, keys(obj?.[String(l)])]));
  return {
    projects,
    paths: cat.paths.map((p) => ({ code: p.code, en: p.en, zh: p.zh, legacy: !!p.legacy, required: levels(p.required) })),
    electives: levels(cat.electives),
  };
}

function toPayload() {
  const nameOf = new Map(draft.projects.map((p) => [p.k, p.en.trim()]));
  const levels = (obj) => Object.fromEntries(
    LEVELS.map((l) => [String(l), (obj[l] || []).map((k) => nameOf.get(k))]).filter(([, v]) => v.length));
  return {
    projects: draft.projects.map((p) => ({ id: p.id ?? null, en: p.en.trim(), zh: p.zh.trim() })),
    paths: draft.paths.map((p) => ({ code: p.code.trim().toUpperCase(), en: p.en.trim(), zh: p.zh.trim(), legacy: p.legacy, required: levels(p.required) })),
    electives: levels(draft.electives),
  };
}

function resetDraft() {
  const code = selected?.code;
  draft = toDraft(getPathwayCatalog());
  baseline = JSON.stringify(draft);
  selected = draft.paths.find((p) => p.code === code) || draft.paths[0] || null;
}

const isDirty = () => !!draft && JSON.stringify(draft) !== baseline;

function changed() {
  const n = isDirty();
  setSaveDisabled?.(!n);
  const label = document.getElementById('saveState');
  if (label) {
    label.textContent = n ? '有未儲存的變更' : '已同步';
    label.className = 'save-state' + (n ? ' unsaved' : '');
  }
}

const project = (k) => draft.projects.find((p) => p.k === k);
const projectText = (k) => {
  const p = project(k);
  return p ? `${p.en || '（未命名）'}${p.zh ? `｜${p.zh}` : ''}` : '';
};
const currentPath = () => (draft.paths.includes(selected) ? selected : null);

/** How many lists use a project — shown on the 專案 tab, and asked about before deleting. */
function usage(k) {
  let n = 0;
  draft.paths.forEach((p) => LEVELS.forEach((l) => { if (p.required[l].includes(k)) n++; }));
  LEVELS.forEach((l) => { if (draft.electives[l].includes(k)) n++; });
  return n;
}

// ---------------------------------------------------------------- render
function render() {
  document.querySelectorAll('.pw-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const body = document.getElementById('pwBody');
  if (!draft) return;
  if (tab === 'paths') body.innerHTML = renderPathsTab();
  else if (tab === 'projects') body.innerHTML = renderProjectsTab();
  else body.innerHTML = renderElectivesTab();
  changed();
}

/**
 * One ordered project list (a path's level, or an elective pool) with
 * reorder / remove buttons and an "add" select of the projects not in it.
 */
function renderList(scope, level, keys, note = '') {
  const items = keys.map((k, i) => `
    <li class="pw-item">
      <span class="pw-item-name">${esc(projectText(k))}</span>
      <span class="pw-item-actions">
        <button class="pw-icon" title="上移" ${i === 0 ? 'disabled' : ''} onclick="window.__pwMove('${scope}',${level},${i},-1)">↑</button>
        <button class="pw-icon" title="下移" ${i === keys.length - 1 ? 'disabled' : ''} onclick="window.__pwMove('${scope}',${level},${i},1)">↓</button>
        <button class="pw-icon danger" title="移除" onclick="window.__pwRemove('${scope}',${level},${i})">✕</button>
      </span>
    </li>`).join('');
  const options = draft.projects
    .filter((p) => !keys.includes(p.k))
    .map((p) => `<option value="${p.k}">${esc(projectText(p.k))}</option>`).join('');
  return `
    <div class="pw-level">
      <div class="pw-level-head">第 ${level} 級 Level ${level}${note ? `<span class="pw-level-note">${note}</span>` : ''}</div>
      ${keys.length ? `<ol class="pw-list">${items}</ol>` : '<div class="pw-empty">（尚無專案）</div>'}
      <select class="pw-add" onchange="window.__pwAdd('${scope}',${level},this.value)">
        <option value="">＋ 加入專案…</option>${options}
      </select>
    </div>`;
}

function renderPathsTab() {
  const list = draft.paths.map((p, i) => `
    <li class="pw-path${p === selected ? ' active' : ''}" onclick="window.__pwSelect(${i})">
      <span class="pw-path-code">${esc(p.code || '新')}</span>
      <span class="pw-path-name">${esc(p.zh || p.en || '（未命名）')}</span>
      ${p.legacy ? '<span class="pw-badge">已停用</span>' : ''}
    </li>`).join('');

  const p = currentPath();
  const idx = draft.paths.indexOf(p);
  const editor = !p ? '<div class="pw-empty-big">請從左側選擇路徑，或新增一條路徑。</div>' : `
    <div class="pw-editor-head">
      <div class="pw-fields">
        <label>代碼 Code
          <input type="text" maxlength="4" value="${esc(p.code)}" ${p.isNew ? '' : 'disabled title="既有議程以代碼記錄路徑，建立後不可修改"'}
                 placeholder="例：PM" oninput="window.__pwPathField('code',this.value)">
        </label>
        <label class="grow">英文名稱 English
          <input type="text" value="${esc(p.en)}" oninput="window.__pwPathField('en',this.value)">
        </label>
        <label class="grow">中文名稱
          <input type="text" value="${esc(p.zh)}" oninput="window.__pwPathField('zh',this.value)">
        </label>
      </div>
      <div class="pw-editor-actions">
        <label class="pw-check"><input type="checkbox" ${p.legacy ? 'checked' : ''} onchange="window.__pwPathField('legacy',this.checked)"> 已停用（Legacy）</label>
        <button class="pw-icon" title="在清單中上移" ${idx === 0 ? 'disabled' : ''} onclick="window.__pwMovePath(-1)">↑</button>
        <button class="pw-icon" title="在清單中下移" ${idx === draft.paths.length - 1 ? 'disabled' : ''} onclick="window.__pwMovePath(1)">↓</button>
        <button class="btn-danger" onclick="window.__pwDeletePath()">刪除路徑</button>
      </div>
    </div>
    <p class="pw-hint">各級必修專案（含第 1 級、指導計畫、回顧路徑）。選修由「選修清單」共用，本路徑的必修不會重複出現在選修中。</p>
    <div class="pw-levels">${LEVELS.map((l) => renderList('req', l, p.required[l])).join('')}</div>`;

  return `
    <div class="pw-split">
      <div class="pw-side">
        <ul class="pw-paths">${list}</ul>
        <button class="btn-ghost pw-side-add" onclick="window.__pwAddPath()">＋ 新增路徑</button>
      </div>
      <div class="pw-editor">${editor}</div>
    </div>`;
}

function renderProjectsTab() {
  const q = search.trim().toLowerCase();
  const rows = draft.projects
    .filter((p) => !q || p.en.toLowerCase().includes(q) || p.zh.toLowerCase().includes(q))
    .map((p) => {
      const n = usage(p.k);
      return `<tr>
        <td><input type="text" value="${esc(p.en)}" placeholder="English name" oninput="window.__pwProjectField('${p.k}','en',this.value)"></td>
        <td><input type="text" value="${esc(p.zh)}" placeholder="中文名稱" oninput="window.__pwProjectField('${p.k}','zh',this.value)"></td>
        <td class="pw-num">${n ? `${n} 處` : '<span class="pw-muted">未使用</span>'}</td>
        <td class="pw-num"><button class="pw-icon danger" title="刪除專案" onclick="window.__pwDeleteProject('${p.k}')">✕</button></td>
      </tr>`;
    }).join('');
  return `
    <div class="pw-toolbar">
      <input type="text" class="pw-search" placeholder="搜尋專案（中英文皆可）…" value="${esc(search)}" oninput="window.__pwSearch(this.value)">
      <span class="pw-muted">共 ${draft.projects.length} 個專案</span>
      <div class="toolbar-spacer"></div>
      <button class="btn-ghost" onclick="window.__pwAddProject()">＋ 新增專案</button>
    </div>
    <p class="pw-hint">議程以<strong>英文名稱</strong>記錄專案，並依議程語言顯示中文或英文。修改既有專案的名稱後儲存，已存的議程會一併改成新名稱。</p>
    <table class="pw-table">
      <thead><tr><th>英文名稱 English</th><th>中文名稱</th><th class="pw-num">使用於</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="pw-empty">沒有符合的專案</td></tr>'}</tbody>
    </table>`;
}

function renderElectivesTab() {
  return `
    <p class="pw-hint">選修清單由所有路徑共用。某專案若是該路徑的必修，就不會出現在該路徑的選修選單中。</p>
    <div class="pw-levels">${LEVELS.map((l) => renderList('elec', l, draft.electives[l], l < 3 ? '目前 Pathways 第 1、2 級沒有選修' : '')).join('')}</div>`;
}

// ---------------------------------------------------------------- edits
function listFor(scope, level) {
  return scope === 'req' ? currentPath().required[level] : draft.electives[level];
}

// Typing must not re-render (that would drop focus): apply the edit, patch
// whatever small label mirrors it, and refresh only the save state.
function focusKeep(fn) {
  fn();
  changed();
}

const handlers = {
  setTab(t) { tab = t; render(); },
  select(i) { selected = draft.paths[i]; render(); },
  render() { render(); },
  move(scope, level, i, d) {
    const list = listFor(scope, level);
    [list[i], list[i + d]] = [list[i + d], list[i]];
    render();
  },
  remove(scope, level, i) { listFor(scope, level).splice(i, 1); render(); },
  add(scope, level, k) { if (k) { listFor(scope, level).push(k); render(); } },
  pathField(field, value) {
    const p = currentPath();
    if (field === 'code') {
      p.code = value.trim().toUpperCase();
      return focusKeep(() => {
        const label = document.querySelector('.pw-path.active .pw-path-code');
        if (label) label.textContent = p.code || '新';
      });
    }
    p[field] = value;
    if (field === 'legacy') return render();
    focusKeep(() => {
      const label = document.querySelector('.pw-path.active .pw-path-name');
      if (label) label.textContent = p.zh || p.en || '（未命名）';
    });
  },
  movePath(d) {
    const i = draft.paths.indexOf(currentPath());
    [draft.paths[i], draft.paths[i + d]] = [draft.paths[i + d], draft.paths[i]];
    render();
  },
  addPath() {
    const path = { code: '', en: '', zh: '', legacy: false, isNew: true,
                   required: Object.fromEntries(LEVELS.map((l) => [l, []])) };
    // Pre-fill Level 1 from an existing current path — it's the same on every path.
    const model = draft.paths.find((p) => !p.legacy);
    if (model) path.required[1] = [...model.required[1]];
    draft.paths.push(path);
    selected = path;
    render();
    document.querySelector('.pw-fields input')?.focus();
  },
  deletePath() {
    const p = currentPath();
    if (!confirm(`確定刪除路徑「${p.code} ${p.zh || p.en}」？\n既有議程上已選的代碼會保留，改以「其他／自訂」文字顯示。`)) return;
    draft.paths.splice(draft.paths.indexOf(p), 1);
    selected = draft.paths[0] || null;
    render();
  },
  projectField(k, field, value) { focusKeep(() => { project(k)[field] = value; }); },
  addProject() {
    const k = `p${nextKey++}`;
    draft.projects.unshift({ k, id: null, en: '', zh: '' });
    search = '';
    render();
    document.querySelector('.pw-table tbody input')?.focus();
  },
  deleteProject(k) {
    const n = usage(k);
    const name = projectText(k) || '這個專案';
    if (!confirm(n ? `「${name}」目前用在 ${n} 個清單中，刪除後會一併移除。確定？` : `確定刪除「${name}」？`)) return;
    draft.projects = draft.projects.filter((p) => p.k !== k);
    draft.paths.forEach((p) => LEVELS.forEach((l) => { p.required[l] = p.required[l].filter((x) => x !== k); }));
    LEVELS.forEach((l) => { draft.electives[l] = draft.electives[l].filter((x) => x !== k); });
    render();
  },
  search(v) {
    search = v;
    const pos = document.activeElement?.selectionStart;
    render();
    const el = document.querySelector('.pw-search');
    el?.focus();
    el?.setSelectionRange(pos, pos);
  },
};

// ---------------------------------------------------------------- save
function validate(payload) {
  const seen = new Set();
  for (const p of payload.projects) {
    if (!p.en) return '有專案的英文名稱是空白的';
    if (seen.has(p.en.toLowerCase())) return `專案名稱重複：${p.en}`;
    seen.add(p.en.toLowerCase());
  }
  const codes = new Set();
  for (const p of payload.paths) {
    if (!p.code) return `新路徑「${p.zh || p.en || '未命名'}」還沒填代碼`;
    if (!/^[A-Z]{2,4}$/.test(p.code)) return `路徑代碼「${p.code}」須為 2～4 個英文字母`;
    if (codes.has(p.code)) return `路徑代碼重複：${p.code}`;
    codes.add(p.code);
    if (!p.en) return `${p.code} 的英文名稱不可空白`;
  }
  return '';
}

async function save() {
  if (!isDirty()) return;
  const payload = toPayload();
  const problem = validate(payload);
  if (problem) { toast(problem, true); return; }
  setSaveDisabled?.(true);
  setSaveLabel?.('儲存中…');
  try {
    const res = await apiJson('/pathways', { method: 'PUT', body: payload });
    setPathwayCatalog(res);
    resetDraft();
    render();
    toast(res.renamedAgendas
      ? `已儲存，並更新了 ${res.renamedAgendas} 份議程中改名的專案`
      : '已儲存 Pathways 目錄');
  } catch (e) {
    toast(e.message || '儲存失敗', true);
    changed();
  } finally {
    setSaveLabel?.('儲存變更');
  }
}

function discard() {
  if (!isDirty() || !confirm('確定要捨棄所有未儲存的變更嗎？')) return;
  resetDraft();
  render();
}

// ---------------------------------------------------------------- init
async function checkPathwaysAuth() {
  try {
    const data = await apiJson('/auth/verify');
    setAuth(data.username, data.role, data.club_id, data.must_change_pw, data.memberships);
    if (data.must_change_pw) { location.href = withBase('/change-password'); return false; }
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

export default function PathwaysPage() {
  const [saveDisabled, setSaveDisabledState] = useState(true);
  const [saveLabel, setSaveLabelState] = useState('儲存變更');

  useEffect(() => {
    // Bridge for onclick="..." strings inside the innerHTML renders.
    window.__pwSelect        = handlers.select;
    window.__pwRender        = handlers.render;
    window.__pwMove          = handlers.move;
    window.__pwRemove        = handlers.remove;
    window.__pwAdd           = handlers.add;
    window.__pwPathField     = handlers.pathField;
    window.__pwMovePath      = handlers.movePath;
    window.__pwAddPath       = handlers.addPath;
    window.__pwDeletePath    = handlers.deletePath;
    window.__pwProjectField  = handlers.projectField;
    window.__pwAddProject    = handlers.addProject;
    window.__pwDeleteProject = handlers.deleteProject;
    window.__pwSearch        = handlers.search;
    setSaveDisabled = setSaveDisabledState;
    setSaveLabel = setSaveLabelState;

    const onKeydown = (e) => {          // Ctrl/Cmd+S saves
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    };
    const onBeforeUnload = (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('beforeunload', onBeforeUnload);

    (async function init() {
      applyRoleUI();
      if (!(await checkPathwaysAuth())) return;
      const body = document.getElementById('pwBody');
      if (!isSystemAdmin()) {
        body.innerHTML = '<div class="pw-empty-big">Pathways 目錄為全站共用，只有系統管理員可以編輯。</div>';
        return;
      }
      if (!(await loadPathways({ force: true }))) {
        body.innerHTML = '<div class="pw-empty-big">載入 Pathways 目錄失敗，請重新整理再試。</div>';
        return;
      }
      resetDraft();
      render();
    })();

    return () => {
      ['Select', 'Render', 'Move', 'Remove', 'Add', 'PathField', 'MovePath', 'AddPath', 'DeletePath',
       'ProjectField', 'AddProject', 'DeleteProject', 'Search'].forEach((n) => { delete window[`__pw${n}`]; });
      setSaveDisabled = null;
      setSaveLabel = null;
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  return (
    <>
      <Sidebar active="pathways" />

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">Pathways 路徑管理</div>
          <div className="topbar-actions system-admin-only" style={{ display: 'none' }}>
            <span className="save-state" id="saveState">已同步</span>
            <button className="btn-ghost" onClick={discard}>捨棄變更</button>
            <button className="btn-add" onClick={save} disabled={saveDisabled}>{saveLabel}</button>
          </div>
        </header>

        <div className="content">
          <div className="pw-tabs system-admin-only" style={{ display: 'none' }}>
            <button className="pw-tab active" data-tab="paths" onClick={() => handlers.setTab('paths')}>路徑與必修</button>
            <button className="pw-tab" data-tab="projects" onClick={() => handlers.setTab('projects')}>專案</button>
            <button className="pw-tab" data-tab="electives" onClick={() => handlers.setTab('electives')}>選修清單</button>
          </div>
          <div className="pw-card" id="pwBody">
            <div className="loading-spinner"><div className="spinner"></div></div>
          </div>
        </div>
      </div>

      <div id="toast" className="toast"></div>
    </>
  );
}
