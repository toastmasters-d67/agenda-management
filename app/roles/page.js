'use client';

import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api';
import { setAuth, clearAuth, applyRoleUI, isSystemAdmin, canWrite, getClubId } from '@/lib/auth';
import { MemberAC } from '@/lib/memberAutocomplete';
import { MAX_EVAL_EVALUATORS } from '@/lib/agendaTemplates';
import { parseRolesSheet, resolveMemberName, isPersonField, META_IDS } from '@/lib/rolesSheet';
import { loadPathways, CUSTOM_VALUE, pathwaySelect, levelSelect, projectSelect } from '@/lib/pathways';
import Sidebar from '@/components/Sidebar';
import './roles.css';
import { withBase } from '@/lib/basePath';

// ================================================================
// This page is a deliberate lift-and-shift port of the legacy
// roles.html + roles.js role matrix editor — imperative DOM ops kept
// nearly verbatim rather than rewritten as React state (same approach
// as /home, /club, /member, /agenda). Module-level `let`/`const` mirror
// the original inline <script> globals.
//
// There is no separate storage for role plans — the cells read and
// write the *same* fields of `agendas.data` that the agenda generator
// uses, so planning a role here immediately shows up on that meeting's
// agenda sheet, and vice versa. The role list below is therefore
// derived from the agenda fields in app/agenda/page.js.
//
// Because `PUT /svc/agendas/{id}` replaces `data` wholesale, saving is
// merge-based: re-read the agenda, overwrite only the role fields that
// were edited here, then write it back.
// ================================================================

// ================================================================
// ROLE DEFINITIONS  (mirrors the agenda fields in app/agenda/page.js)
// ================================================================
// Every club sees the same full role list — a role whose `templates` allow-list
// doesn't include the active club's template renders as a locked (disabled,
// greyed) row instead of being removed, per the site-wide rule that
// `agendas.data` is one shared schema across templates: a template that
// doesn't use a field just leaves it null/unrendered, and the matrix reflects
// that by locking rather than hiding. No `templates` key = every template uses it.
const ROLE_GROUPS = [
  {
    label: '會議主持',
    roles: [
      { key: 'receptionHost',  label: '報到接待',     en: 'Reception Host' },
      // Chill Hi High has no separate "calling to order" row — its opening
      // remarks row reads `welcomeTME` instead (see lib/agendaTemplates.js).
      { key: 'callingToOrder', label: '宣布例會開始', en: 'Calling to Order', templates: ['standard', 'compact', 'entrepreneur', 'china'] },
      { key: 'welcomeTME',     label: '會長致歡迎詞', en: 'Welcome Guests & TME' },
      { key: 'tme',            label: '總主持人',     en: 'Toastmaster of the Evening' },
    ],
  },
  {
    label: '計時 / 記錄',
    roles: [
      { key: 'timer',        label: '計時員',     en: 'Timer' },
      // Chill Hi High's planning sheet staffs a second timer; no other template
      // has the row, so it locks everywhere else (same rule as boardWriter).
      { key: 'timerAssistant', label: '計時員幫手', en: 'Assistant Timer', templates: ['chillhihigh'] },
      { key: 'ahCounter',    label: '贅語記錄員', en: 'Ah-Counter' },
      { key: 'boardWriter',  label: '板書',       en: 'Board Writer', templates: ['chillhihigh'] },
      { key: 'photographer', label: '攝影',       en: 'Photographer', templates: ['chillhihigh'] },
      { key: 'voteCounter',  label: '計票員',     en: 'Vote Counter', templates: ['china'] },
    ],
  },
  {
    label: '單元主持',
    roles: [
      { key: 'varietyHost',       label: '多元單元主持人', en: 'Variety Session Host', kind: 'variety', templates: ['standard', 'compact', 'entrepreneur', 'chillhihigh'] },
      { key: 'tableTopicsMaster', label: '即席問答主持人', en: 'Table Topics Master' },
      { key: 'wordOfTheDay',      label: '每日一字',       en: 'Word of the Day', templates: ['china'] },
      { key: 'quizHost',          label: '問答遊戲主持',   en: 'Quiz Session', templates: ['china'] },
    ],
  },
  { label: '指定演講', dynamic: 'speech' },
  {
    label: '講評',
    dynamic: 'evaluator',
    // Rendered after the per-speaker evaluator rows.
    tail: [
      { key: 'langEvaluator',    label: '語言講評', en: 'Language Evaluator' },
      { key: 'generalEvaluator', label: '總講評',   en: 'General Evaluator' },
    ],
    // …and these after `tail`, mirroring the agenda sheet, where 講評員講評
    // closes out the evaluation block after 總講評.
    tailDynamic: 'evalEvaluator',
  },
  {
    label: '結尾',
    roles: [
      { key: 'awardsPresenter', label: '贈感謝狀',            en: 'Awards Presenter' },
      { key: 'sharingFeedback', label: '會後分享 & 來賓回饋', en: 'Sharing & Feedback' },
    ],
  },
];

/**
 * Per-meeting fields edited in the column header instead of as a matrix row.
 * They ride the same draft / dirty / merge machinery as roles — a plain
 * `data[key]` write — but are deliberately kept out of the role rows so they
 * never count toward the assignment tally or duplicate detection. They are also
 * not member fields, so they get no autocomplete.
 */
const META_FIELDS = [
  { key: 'meetingNo',     label: '場次編號', placeholder: '場次編號' },
  { key: 'meetingTheme',  label: '例會主題', placeholder: '未設定主題' },
  { key: 'themeQuestion', label: '主題題目', placeholder: '主題題目', templates: ['chillhihigh'] },
];

/** Same shape app/agenda/page.js uses, so a row added here stays valid in the editor. */
function blankSpeech() {
  return {
    title: '', speaker: '', duration: "5'-7'", speechLang: 'en',
    pathwayCode: '', pathwayLevel: '', pathwayProject: '',
  };
}

function roleGet(data, role) {
  if (role.kind === 'speech')        return (data.speeches      || [])[role.idx]?.speaker || '';
  if (role.kind === 'speechField')   return (data.speeches      || [])[role.idx]?.[role.field] || '';
  if (role.kind === 'evaluator')     return (data.evaluators    || [])[role.idx] || '';
  if (role.kind === 'evalEvaluator') return (data.evalEvaluators || [])[role.idx] || '';
  if (role.kind === 'variety')       return data.varietySession?.host || '';
  return data[role.key] || '';
}

function roleSet(data, role, value) {
  if (role.kind === 'speech' || role.kind === 'speechField') {
    if (!Array.isArray(data.speeches)) data.speeches = [];
    while (data.speeches.length <= role.idx) data.speeches.push(blankSpeech());
    // `speechField` carries the speech's title / pathway: the Pathways fields
    // are dropdown sub-rows here, the title only arrives via the sheet import.
    data.speeches[role.idx][role.kind === 'speech' ? 'speaker' : role.field] = value;
  } else if (role.kind === 'evaluator') {
    if (!Array.isArray(data.evaluators)) data.evaluators = [];
    while (data.evaluators.length <= role.idx) data.evaluators.push('');
    data.evaluators[role.idx] = value;
  } else if (role.kind === 'evalEvaluator') {
    if (!Array.isArray(data.evalEvaluators)) data.evalEvaluators = [];
    while (data.evalEvaluators.length <= role.idx) data.evalEvaluators.push('');
    data.evalEvaluators[role.idx] = value;
  } else if (role.kind === 'variety') {
    // Naming a host is what marks the session as happening — a host planned
    // here while the session stayed switched off would simply never appear on
    // the agenda. One-way only: clearing the host does *not* switch the session
    // back off, that stays the agenda editor's call.
    if (!data.varietySession) data.varietySession = { enabled: false, duration: 15, host: '' };
    data.varietySession.host = value;
    if (value) data.varietySession.enabled = true;
  } else {
    data[role.key] = value;
  }
}

// ================================================================
// STATE
// ================================================================
let meetings       = [];     // [{ id, meetingDate, meetingNo, meetingTheme, clubId, data, draft, dirty:Set }]
let rows           = [];     // flattened matrix rows: {type:'group'|'role', ...}
let roleById       = {};     // roleId → role descriptor
let selectedClubId = null;
let dateFrom       = '';     // inclusive meeting_date bounds; '' = unbounded
let dateTo         = '';
let allClubs       = [];     // full /clubs list (id, name, template_key, …) — resolves the active template

/** The club whose roles are currently being planned (admin picks one; everyone else uses their own). */
function activeClubId() {
  return isSystemAdmin() ? selectedClubId : getClubId();
}

/** Drives which roles show up in the matrix — each template renders a different role set. */
function activeTemplateKey() {
  const club = allClubs.find((c) => c.id === activeClubId());
  return (club && club.template_key) || 'standard';
}

/** The active club, or null before one is picked. */
function activeClub() {
  return allClubs.find((c) => c.id === activeClubId()) || null;
}

/**
 * Header fields for the active template. Unlike role rows — which stay visible
 * but locked — a meta field the template does not use is dropped outright:
 * the column header has no room for a row of greyed-out placeholders.
 */
function activeMetaFields() {
  const tk = activeTemplateKey();
  return META_FIELDS.filter((f) => !f.templates || f.templates.includes(tk));
}

// Bridge to RolesPage's React state, same pattern as window.__rolesOnCellInput
// below. The save button's disabled state used to be toggled by mutating
// btn.disabled directly (like every other imperative DOM update in this
// file), but that left it permanently unclickable — React re-applies the
// JSX-declared `disabled` prop and wins the fight with the raw DOM mutation.
// Routing it through real state removes the fight entirely. The button's
// label rides the same state (rather than staying a raw textContent write)
// so that a setSaveDisabled-triggered re-render can't stomp it mid-save.
let setSaveDisabled = null;
let setSaveLabel    = null;

/** Safety net so an unbounded range cannot pull the whole history at once. */
const MAX_COLUMNS = 40;

const roleId = (role) => role.key;

// ---------------------------------------------------------------- date range
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function addMonths(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() < day) d.setDate(0);   // clamp e.g. 3/31 -1mo → 2/28
  return ymd(d);
}

/**
 * Default window: a couple of months back through the next quarter. Reaching
 * backwards matters — a club's newest agenda is often already in the past, and
 * an "upcoming only" default would open on an empty board.
 */
function defaultRange() {
  const today = ymd(new Date());
  return { from: addMonths(today, -2), to: addMonths(today, 3) };
}

const dirtyMeetings = () => meetings.filter((m) => m.dirty.size > 0);

const confirmDiscard = () =>
  !dirtyMeetings().length || confirm('有未儲存的變更，重新載入將會捨棄。要繼續嗎？');

function applyPreset(kind, arg) {
  if (!confirmDiscard()) return;
  const today = ymd(new Date());
  if (kind === 'around')        { const r = defaultRange(); dateFrom = r.from; dateTo = r.to; }
  else if (kind === 'upcoming') { dateFrom = today;                    dateTo = addMonths(today, 6); }
  else if (kind === 'year')     { const y = new Date().getFullYear();  dateFrom = `${y}-01-01`; dateTo = `${y}-12-31`; }
  else if (kind === 'all')      { dateFrom = ''; dateTo = ''; }
  else if (kind === 'shift') {
    // Shift the whole window; needs both bounds to be meaningful.
    if (!dateFrom || !dateTo) { const r = defaultRange(); dateFrom = r.from; dateTo = r.to; }
    dateFrom = addMonths(dateFrom, arg);
    dateTo   = addMonths(dateTo,   arg);
  }
  syncDateInputs();
  loadMeetings();
}

function syncDateInputs() {
  document.getElementById('dateFrom').value = dateFrom;
  document.getElementById('dateTo').value   = dateTo;
}

function onDateRangeChange() {
  const from = document.getElementById('dateFrom').value;
  const to   = document.getElementById('dateTo').value;
  if (from && to && from > to) {
    toast('開始日期不能晚於結束日期', true);
    syncDateInputs();     // revert to the last accepted range
    return;
  }
  if (!confirmDiscard()) { syncDateInputs(); return; }
  dateFrom = from;
  dateTo   = to;
  loadMeetings();
}

// ================================================================
// AUTH / LOAD
// ================================================================
async function checkRolesAuth() {
  try {
    const data = await apiJson('/auth/verify');
    setAuth(data.username, data.role, data.club_id, data.must_change_pw);
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

/**
 * Loads the full club list (id/name/template_key/…) into `allClubs` — needed by
 * every role (not just admins) so `activeTemplateKey()` can resolve the active
 * club's template. Admins additionally get the club-picker dropdown populated
 * from the same fetch, avoiding a second round-trip.
 */
async function loadClubsMeta() {
  try {
    allClubs = await apiJson('/clubs');
    if (isSystemAdmin()) {
      const sel = document.getElementById('clubPickerSelect');
      sel.innerHTML = '<option value="">— 請選擇分會 —</option>' +
        allClubs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      document.getElementById('clubPickerBar').style.display = '';
    }
  } catch {
    allClubs = [];
    if (isSystemAdmin()) toast('載入分會失敗', true);
  }
}

async function onClubChange() {
  if (dirtyMeetings().length && !confirm('有未儲存的變更，切換分會將會捨棄。要繼續嗎？')) {
    document.getElementById('clubPickerSelect').value = selectedClubId ?? '';
    return;
  }
  const v = document.getElementById('clubPickerSelect').value;
  selectedClubId = v ? parseInt(v, 10) : null;
  if (selectedClubId == null) { showPickClubHint(); return; }
  await Promise.all([loadRoster(), loadMeetings()]);
}

function showPickClubHint() {
  meetings = [];
  document.getElementById('matrixWrap').innerHTML =
    '<div class="matrix-empty">請先於上方選擇分會，以規劃該分會的例會角色</div>';
  updateSaveBar();
  document.getElementById('pagerLabel').textContent = '';
  document.getElementById('templateLabel').textContent = '';
  updateImportButton();
}

/** Roster that feeds the cell dropdowns. Guests can still be typed freely. */
async function loadRoster() {
  try {
    let path = '/users';
    if (isSystemAdmin() && selectedClubId != null) path += `?club_id=${selectedClubId}`;
    const users = await apiJson(path);
    MemberAC.setRoster(users.filter((u) => (u.status || 'active') === 'active'));
    document.getElementById('rosterCount').textContent = `${MemberAC.getRoster().length} 位會員可選`;
  } catch {
    toast('載入會員名單失敗，仍可手動輸入姓名', true);
  }
}

async function loadMeetings() {
  const wrap = document.getElementById('matrixWrap');
  wrap.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  cancelAddMeeting(); // in case a reload happens while the modal is open
  try {
    const params = new URLSearchParams({
      full: '1', order: 'date', limit: String(MAX_COLUMNS), page: '1',
    });
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo)   params.set('date_to',   dateTo);
    if (isSystemAdmin() && selectedClubId != null) params.set('club_id', selectedClubId);
    const json = await apiJson(`/agendas?${params}`);

    // API returns newest first; show them left→right chronologically.
    meetings = (json.items || [])
      .map((it) => ({ ...it, data: it.data || {}, draft: {}, dirty: new Set() }))
      .sort((a, b) => String(a.meetingDate).localeCompare(String(b.meetingDate)));

    buildRows();
    meetings.forEach(resetDraft);
    renderMatrix();
    updateRangeLabel(json.total || 0);
    updateTemplateLabel();
    return true;
  } catch {
    wrap.innerHTML = '<div class="matrix-empty">載入例會失敗</div>';
    document.getElementById('pagerLabel').textContent = '';
    // `meetings` deliberately keeps its previous contents so the page has
    // something to fall back on — which makes the outcome reportable rather
    // than silent: a caller that *diffs* against the list (the sheet importer)
    // must know it is looking at a stale one.
    return false;
  }
}

/** (Re)seed a meeting's editable draft from its saved agenda data. */
function resetDraft(m) {
  m.dirty.clear();
  rows.filter((r) => r.type === 'role')
      .forEach((r) => { m.draft[roleId(r.role)] = roleGet(m.data, r.role); });
  META_FIELDS.forEach((f) => { m.draft[f.key] = roleGet(m.data, f); });
}

function updateRangeLabel(total) {
  const label = document.getElementById('pagerLabel');
  if (!total) { label.textContent = '此範圍內沒有例會'; return; }
  label.textContent = total > meetings.length
    ? `顯示最近 ${meetings.length} 場（範圍內共 ${total} 場，請縮小日期範圍）`
    : `顯示 ${meetings.length} 場`;
}

const TEMPLATE_LABELS = { standard: '標準版', compact: '精簡版', entrepreneur: '企業家版', chillhihigh: 'Chill Hi High', china: 'CHINA' };

/** Display name for the active club's template — used in the toolbar label and locked-row tooltips. */
function activeTemplateLabel() {
  return TEMPLATE_LABELS[activeTemplateKey()] || activeTemplateKey();
}

/** Surfaces which template's role set is currently shown — the list differs per template. */
function updateTemplateLabel() {
  const label = document.getElementById('templateLabel');
  if (!label) return;
  const club = allClubs.find((c) => c.id === activeClubId());
  label.textContent = club ? `目前版型：${activeTemplateLabel()}` : '';
  updateImportButton();
}

// ================================================================
// MATRIX BUILD / RENDER
// ================================================================
function buildRows() {
  rows     = [];
  roleById = {};

  const tmplKey = activeTemplateKey();
  const locked = (role) => !!(role.templates && !role.templates.includes(tmplKey));

  const pushRole = (role) => {
    const withLock = { ...role, locked: locked(role) };
    roleById[roleId(withLock)] = withLock;
    rows.push({ type: 'role', role: withLock });
  };

  // Resolvable by the save path, but intentionally absent from `rows`.
  META_FIELDS.forEach((f) => { roleById[f.key] = f; });

  // Show as many speech / evaluator slots as the busiest loaded meeting needs.
  const maxSpeech = Math.max(3, ...meetings.map((m) => (m.data.speeches   || []).length));
  const maxEval   = Math.max(3, ...meetings.map((m) => (m.data.evaluators || []).length));
  // 講評員講評 is optional, so there is no floor of 3 here — instead show one
  // spare row past the busiest meeting (capped) so the next one can always be
  // added from this page without leaving 3 near-always-empty rows behind.
  const maxEvalEval = Math.min(
    MAX_EVAL_EVALUATORS,
    Math.max(0, ...meetings.map((m) => (m.data.evalEvaluators || []).length)) + 1,
  );

  ROLE_GROUPS.forEach((group) => {
    rows.push({ type: 'group', label: group.label });
    (group.roles || []).forEach(pushRole);

    if (group.dynamic === 'speech') {
      for (let i = 0; i < maxSpeech; i++) {
        pushRole({ key: `speech${i + 1}`, kind: 'speech', idx: i,
                   label: `指定演講者 #${i + 1}`, en: `Speaker #${i + 1}` });
        // The speech's Pathways fields, as dropdown sub-rows under the speaker.
        // Same ids the sheet importer writes (see importRole).
        ['pwcode', 'pwlevel', 'project'].forEach((sub) => {
          const spec = SPEECH_FIELDS[sub];
          pushRole({ key: `speech${i + 1}_${sub}`, kind: 'speechField', idx: i, field: spec.field,
                     sub, label: `#${i + 1} ${spec.label}`, en: spec.en });
        });
      }
    }
    if (group.dynamic === 'evaluator') {
      for (let i = 0; i < maxEval; i++) {
        pushRole({ key: `evaluator${i + 1}`, kind: 'evaluator', idx: i,
                   label: `個別講評員 #${i + 1}`, en: `Evaluator #${i + 1}` });
      }
    }
    (group.tail || []).forEach(pushRole);

    if (group.tailDynamic === 'evalEvaluator') {
      for (let i = 0; i < maxEvalEval; i++) {
        pushRole({ key: `evalEvaluator${i + 1}`, kind: 'evalEvaluator', idx: i,
                   label: `講評員講評 #${i + 1}`, en: `Evaluator's Evaluator #${i + 1}` });
      }
    }
  });
}

/**
 * '' when the role is a real slot on that meeting, otherwise why it is not —
 * the matrix shows more speech/evaluator rows than some meetings actually have,
 * and filling one of those *adds* a slot to that agenda when saved.
 */
function slotNote(m, role) {
  if (role.kind === 'variety' && !m.data.varietySession?.enabled) {
    // Saving a host switches the session on (roleSet), so the note only stands
    // while the cell is still empty.
    return m.draft[role.key] ? '' : '此場未啟用多元單元';
  }
  if (role.kind === 'speech' && role.idx >= (m.data.speeches || []).length) {
    return '此場原本沒有這個演講名額，填入並儲存後會為該議程新增一篇演講';
  }
  if (role.kind === 'evaluator' && role.idx >= (m.data.evaluators || []).length) {
    return '此場原本沒有這個講評名額，填入並儲存後會為該議程新增一位講評員';
  }
  if (role.kind === 'evalEvaluator' && role.idx >= (m.data.evalEvaluators || []).length) {
    return '此場原本沒有這個名額，填入並儲存後會在總講評之後新增一位講評員講評';
  }
  return '';
}

function fmtDate(iso) {
  if (!iso) return '未設定日期';
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d)) return iso;
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} (${wd})`;
}

function renderMatrix() {
  const wrap = document.getElementById('matrixWrap');
  const readOnly = !canWrite();
  const showAddCol = !readOnly; // read-only users can browse but not create meetings here

  if (!meetings.length) {
    wrap.innerHTML = showAddCol ? `
      <div class="matrix-empty">
        這個分會在目前範圍內還沒有議程。
        <button class="btn-add matrix-empty-add" onclick="window.__rolesStartAddMeeting()">＋ 新增例會</button>
      </div>`
      : '<div class="matrix-empty">這個分會在目前範圍內還沒有議程。</div>';
    updateSaveBar();
    return;
  }

  const head = meetings.map((m) => `
    <th class="rm-meeting" data-mid="${m.id}">
      ${showAddCol ? `<button class="rm-m-del" onclick="window.__rolesDeleteMeeting(${m.id})" title="刪除這場例會">✕</button>` : ''}
      <div class="rm-m-date">${esc(fmtDate(m.meetingDate))}<span class="rm-dot" id="dot_${m.id}"></span></div>
      ${activeMetaFields().map((f) => `
        <input type="text" class="rm-m-meta" id="cell_${m.id}_${f.key}"
               value="${esc(m.draft[f.key] ?? '')}" data-mid="${m.id}" data-rid="${f.key}"
               placeholder="${esc(f.placeholder)}" ${readOnly ? 'disabled' : ''}
               title="${esc(f.label)}（可編輯）" oninput="window.__rolesOnCellInput(this)">`).join('')}
      <div class="rm-m-foot">
        <span class="rm-m-fill" id="fill_${m.id}"></span>
        <a class="rm-m-link" href="${withBase('/index')}?id=${m.id}" title="開啟此場議程">議程 ↗</a>
      </div>
    </th>`).join('');

  // Trailing "+" column: opens the "新增例會" modal, which creates a new agenda
  // and splices it in as a fillable column — no separate "new agenda" page needed.
  const addColHead = !showAddCol ? '' : `
    <th class="rm-meeting rm-add-col">
      <button class="rm-add-btn" onclick="window.__rolesStartAddMeeting()" title="新增例會">＋</button>
    </th>`;
  const addColCell = !showAddCol ? '' : '<td class="rm-cell rm-add-col"></td>';

  const body = rows.map((r) => {
    if (r.type === 'group') {
      return `<tr class="rm-group-row">
        <th class="rm-role rm-group">${esc(r.label)}</th>
        <td class="rm-group-fill" colspan="${meetings.length + (showAddCol ? 1 : 0)}"></td>
      </tr>`;
    }
    const rid = roleId(r.role);

    if (r.role.locked) {
      const lockTitle = `${activeTemplateLabel()} 不使用這個角色`;
      const cells = meetings.map(() => `<td class="rm-cell rm-locked">
        <input type="text" class="rm-input" value="" disabled placeholder="—" title="${esc(lockTitle)}">
      </td>`).join('');
      return `<tr class="rm-locked-row">
        <th class="rm-role" title="${esc(lockTitle)}">
          <span class="rm-role-zh">${esc(r.role.label)}</span>
          <span class="rm-role-en">${esc(r.role.en || '')}</span>
        </th>${cells}${addColCell}
      </tr>`;
    }

    if (r.role.kind === 'speechField') {
      const cells = meetings.map((m) => `<td class="rm-cell">
        <select class="rm-input rm-select" id="cell_${m.id}_${rid}" data-mid="${m.id}" data-rid="${rid}"
                ${readOnly ? 'disabled' : ''} onchange="window.__rolesOnPathwayInput(this)"></select>
        <input type="text" class="rm-input rm-custom" id="custom_${m.id}_${rid}" data-mid="${m.id}" data-rid="${rid}"
               style="display:none" placeholder="自訂…" ${readOnly ? 'disabled' : ''}
               oninput="window.__rolesOnPathwayCustom(this)">
      </td>`).join('');
      return `<tr class="rm-sub-row">
        <th class="rm-role">
          <span class="rm-role-zh">${esc(r.role.label)}</span>
          <span class="rm-role-en">${esc(r.role.en || '')}</span>
        </th>${cells}${addColCell}
      </tr>`;
    }

    const cells = meetings.map((m) => {
      const v      = m.draft[rid] ?? '';
      const acLang = m.data.lang === 'zh' ? 'zh' : 'en';

      const note = slotNote(m, r.role);

      return `<td class="rm-cell${note ? ' rm-inactive' : ''}">
        <input type="text" class="member-ac rm-input" id="cell_${m.id}_${rid}"
               value="${esc(v)}" data-ac-lang="${acLang}" data-mid="${m.id}" data-rid="${rid}"
               placeholder="${note ? '＋' : '—'}" ${readOnly ? 'disabled' : ''}
               oninput="window.__rolesOnCellInput(this)">
      </td>`;
    }).join('');
    return `<tr>
      <th class="rm-role" title="${esc(r.role.en || '')}">
        <span class="rm-role-zh">${esc(r.role.label)}</span>
        <span class="rm-role-en">${esc(r.role.en || '')}</span>
      </th>${cells}${addColCell}
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <table class="role-matrix">
      <thead><tr><th class="rm-corner">角色 / 例會</th>${head}${addColHead}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;

  meetings.forEach((m) => rows.forEach((r) => {
    if (r.type === 'role' && r.role.kind === 'speechField' && !r.role.locked) fillPathwaySelect(m, r.role);
  }));
  refreshDecorations();
  updateSaveBar();
}

/**
 * One Pathways sub-row cell, from the same meeting's draft — the project list
 * follows whatever path/level that column currently shows. A value outside the
 * catalog (typed by hand, `4-1` from the sheet) selects 「其他／自訂」and sits
 * in the text box under the select, still editable.
 */
function fillPathwaySelect(m, role) {
  const rid = roleId(role);
  const el  = document.getElementById(`cell_${m.id}_${rid}`);
  const box = document.getElementById(`custom_${m.id}_${rid}`);
  if (!el || !box) return;
  const n = role.idx + 1;
  const raw = m.draft[rid] ?? '';
  const { html, value, custom } =
    role.sub === 'pwcode'  ? pathwaySelect(raw) :
    role.sub === 'pwlevel' ? levelSelect(raw) :
    projectSelect(m.draft[`speech${n}_pwcode`], m.draft[`speech${n}_pwlevel`], raw);
  el.innerHTML = html;
  el.value = value;
  el.title = el.selectedOptions[0]?.textContent || '';
  box.style.display = custom ? '' : 'none';
  if (document.activeElement !== box) box.value = custom ? raw : '';
}

// Changing the path or level re-filters that speech's project list.
function refilterProject(el) {
  const sf = el.dataset.rid.match(/^speech(\d+)_(pwcode|pwlevel)$/);
  const m = meetings.find((x) => String(x.id) === el.dataset.mid);
  if (sf && m) fillPathwaySelect(m, roleById[`speech${sf[1]}_project`]);
}

function onPathwayInput(el) {
  const box = document.getElementById(`custom_${el.dataset.mid}_${el.dataset.rid}`);
  if (el.value === CUSTOM_VALUE) {
    onCellInput(el, '');
    if (box) { box.value = ''; box.style.display = ''; box.focus(); }
  } else {
    if (box) box.style.display = 'none';
    onCellInput(el);
  }
  el.title = el.selectedOptions[0]?.textContent || '';
  refilterProject(el);
}

function onPathwayCustom(box) {
  onCellInput(box);
  refilterProject(box);
}

/** Called on every keystroke — must never rebuild the table (would drop focus). */
function onCellInput(el, value = el.value) {
  const m = meetings.find((x) => String(x.id) === el.dataset.mid);
  if (!m) return;
  const rid = el.dataset.rid;
  m.draft[rid] = value;
  if (value === (roleGet(m.data, roleById[rid]) || '')) m.dirty.delete(rid);
  else m.dirty.add(rid);
  refreshDecorations();
  updateSaveBar();
}

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Decorations only (no DOM rebuild): the unsaved highlight per cell, plus the
 * per-column dirty dot and assignment count.
 *
 * One person holding several roles in a meeting is deliberately *not* flagged —
 * it is normal practice, so highlighting it would only add noise.
 */
function refreshDecorations() {
  const roleRows = rows.filter((r) => r.type === 'role');

  meetings.forEach((m) => {
    // Slots this meeting does not have only count once someone is put in them.
    let filled = 0, slots = 0;
    roleRows.forEach((r) => {
      const rid = roleId(r.role);
      const el  = document.getElementById(`cell_${m.id}_${rid}`);
      if (!el) return;
      // Recomputed rather than replayed from render time: a note can change as
      // the cell is typed into (a variety host switches its session on).
      el.classList.toggle('rm-edited', m.dirty.has(rid));
      // Pathways sub-rows describe a speech, they aren't roles to assign.
      if (r.role.kind === 'speechField') return;
      const note = slotNote(m, r.role);
      if (norm(m.draft[rid])) filled++;
      if (norm(m.draft[rid]) || !note) slots++;
      el.title       = note;
      el.placeholder = note ? '＋' : '—';
      el.parentElement?.classList.toggle('rm-inactive', !!note);
    });

    // Header fields: edited highlight only — they take no part in the tally.
    META_FIELDS.forEach((f) => {
      const el = document.getElementById(`cell_${m.id}_${f.key}`);
      if (el) el.classList.toggle('rm-edited', m.dirty.has(f.key));
    });

    const dot = document.getElementById(`dot_${m.id}`);
    if (dot) dot.classList.toggle('visible', m.dirty.size > 0);

    const fill = document.getElementById(`fill_${m.id}`);
    if (fill) {
      fill.textContent = `${filled}/${slots}`;
      fill.title       = '已指派 / 總角色數';
    }
  });
}

// ================================================================
// SAVE
// ================================================================
function updateSaveBar() {
  const dirty = dirtyMeetings();
  const n     = dirty.reduce((s, m) => s + m.dirty.size, 0);
  const label = document.getElementById('saveState');
  setSaveDisabled?.(n === 0);
  if (label) {
    label.textContent = n === 0 ? '已同步' : `${n} 項未儲存（${dirty.length} 場）`;
    label.className   = 'save-state' + (n === 0 ? '' : ' unsaved');
  }
}

async function saveAll() {
  const dirty = dirtyMeetings();
  if (!dirty.length) return;
  setSaveDisabled?.(true);
  setSaveLabel?.('儲存中…');

  let ok = 0;
  const failed = [];
  for (const m of dirty) {
    try {
      // Re-read so a concurrent edit in the agenda editor is not overwritten:
      // only the fields touched here are replaced.
      const fresh = await apiJson(`/agendas/${m.id}`);
      delete fresh._clubId;              // editor-only hint, must not be persisted

      m.dirty.forEach((rid) => roleSet(fresh, roleById[rid], m.draft[rid]));

      await apiJson(`/agendas/${m.id}`, {
        method: 'PUT',
        body: { data: fresh, club_id: m.clubId },
      });

      m.data = fresh;
      // Keep the list-level mirrors in step with what the API would now return.
      m.meetingTheme = fresh.meetingTheme || '';
      m.meetingNo    = fresh.meetingNo    || '';
      m.dirty.clear();
      ok++;
    } catch {
      failed.push(fmtDate(m.meetingDate));
    }
  }

  setSaveLabel?.('儲存變更');
  refreshDecorations();
  updateSaveBar();
  if (failed.length) toast(`${ok} 場已儲存，${failed.length} 場失敗：${failed.join('、')}`, true);
  else toast(`已儲存 ${ok} 場例會的角色安排`);
}

function discardChanges() {
  if (!dirtyMeetings().length) return;
  if (!confirm('確定要捨棄所有未儲存的變更嗎？')) return;
  meetings.forEach(resetDraft);
  renderMatrix();
}

// ================================================================
// GOOGLE SHEET IMPORT
// ================================================================
// Pulls the club's season-planning sheet (the URL lives in the club's 版型
// settings and is fetched *server-side* — see GET /api/clubs/{id}/roles-sheet)
// and lands it in the matrix as ordinary unsaved edits. Nothing is written to
// an existing agenda here: the values go into `draft` + `dirty`, so the user
// reviews the yellow cells and presses 儲存變更 like any other change, and the
// merge-based saveAll() still protects fields the sheet has no column for.
//
// The one immediate write is creating agendas for meetings the sheet has and
// the database does not — a column has to exist before it can be filled.

/**
 * Speech sub-fields carried by the sheet. The Pathways ones are also matrix
 * sub-rows (see buildRows); the title has no row.
 */
const SPEECH_FIELDS = {
  title:   { field: 'title',          label: '演講題目' },
  pwcode:  { field: 'pathwayCode',    label: '學習路徑', en: 'Pathway' },
  pwlevel: { field: 'pathwayLevel',   label: '路徑等級', en: 'Level' },
  project: { field: 'pathwayProject', label: '專案名稱', en: 'Project' },
};

let importPlan = null;   // built by buildImportPlan(), consumed by applyImport()
let importing  = false;  // true while applyImport() is mid-flight

/**
 * Put a button into a spinning "busy" state and hand back its undo.
 *
 * Saves `innerHTML`, not `textContent` — the toolbar button holds an <svg>
 * icon, and a textContent round-trip drops the icon for good.
 */
function busyButton(btn, label) {
  if (!btn) return () => {};
  const html = btn.innerHTML;
  const was  = btn.disabled;
  btn.disabled  = true;
  btn.innerHTML = `<span class="spinner-sm"></span>${esc(label)}`;
  return () => { btn.innerHTML = html; btn.disabled = was; };
}

/** Replace the preview with a spinner; `sub` is a live line (e.g. "3 / 24"). */
function showImportProgress(title, sub = '') {
  const body = document.getElementById('importPreviewBody');
  if (!body) return;
  body.innerHTML = `<div class="imp-progress">
      <div class="spinner"></div>
      <div class="imp-progress-t">${esc(title)}</div>
      <div class="imp-progress-s" id="importProgressSub">${esc(sub)}</div>
    </div>`;
}

function setImportProgress(sub) {
  const el = document.getElementById('importProgressSub');
  if (el) el.textContent = sub;
}

function sheetUrl() {
  const club = activeClub();
  return (club && club.settings && club.settings.roles_sheet_url) || '';
}

/** The button only makes sense for a writer, on a club that has a sheet bound. */
function updateImportButton() {
  const btn = document.getElementById('btnImportSheet');
  if (btn) btn.style.display = (canWrite() && activeClubId() != null && sheetUrl()) ? '' : 'none';
}

/**
 * Resolve a sheet field id to something roleSet() understands.
 *
 * Ids the matrix has no row for — speech titles/pathways, and speech or
 * evaluator slots beyond the rows currently drawn — are registered as hidden
 * descriptors so the save path can still write them; the preview reports how
 * many there are rather than dropping them silently.
 * Returns null for a role the active template locks.
 */
function importRole(id) {
  const sf = id.match(/^speech(\d+)_(title|pwcode|pwlevel|project)$/);
  if (sf) {
    if (roleById[id]) return roleById[id];   // a Pathways sub-row on screen
    const spec = SPEECH_FIELDS[sf[2]];
    return (roleById[id] = {
      key: id, kind: 'speechField', idx: Number(sf[1]) - 1, field: spec.field,
      label: `#${sf[1]} ${spec.label}`, hidden: true,
    });
  }
  if (roleById[id]) return roleById[id].locked ? null : roleById[id];

  const slot = id.match(/^(evalEvaluator|speech|evaluator)(\d+)$/);
  if (slot) {
    const noun = { speech: '指定演講者', evaluator: '個別講評員', evalEvaluator: '講評員講評' }[slot[1]];
    return (roleById[id] = {
      key: id, kind: slot[1], idx: Number(slot[2]) - 1,
      label: `${noun} #${slot[2]}`, hidden: true,
    });
  }
  return null;
}

/**
 * Widen the date filter so every meeting the sheet mentions is on screen —
 * importing into columns the current range hides would look like a no-op.
 *
 * Returns false if the reload failed: the plan is a diff against `meetings`,
 * and diffing against a stale (still-narrow) list would read meetings that
 * simply were not loaded as meetings that do not exist — and create duplicate
 * agendas for them.
 */
async function ensureRangeCovers(dates) {
  const min = dates.reduce((a, b) => (a < b ? a : b));
  const max = dates.reduce((a, b) => (a > b ? a : b));
  const fromOk = !dateFrom || dateFrom <= min;
  const toOk   = !dateTo   || dateTo   >= max;
  if (fromOk && toOk) return true;
  if (!fromOk) dateFrom = min;
  if (!toOk)   dateTo   = max;
  syncDateInputs();
  return loadMeetings();
}

/** Diff the parsed sheet against what is on the board right now. */
function buildImportPlan(sheet) {
  const roster = MemberAC.getRoster();
  const byDate = new Map(meetings.map((m) => [String(m.meetingDate), m]));
  const unmatched = new Map();      // sheet name → how many cells used it
  const columns = [];
  const conflicts = [];             // cells whose current value is non-empty and different
  let skippedLocked = 0;

  sheet.columns.forEach((col) => {
    const m    = byDate.get(col.date);
    const lang = m && m.data.lang === 'zh' ? 'zh' : 'en';
    const changes = {};
    let same = 0, hidden = 0;

    Object.entries(col.values).forEach(([id, raw]) => {
      const role = importRole(id);
      if (!role) { skippedLocked++; return; }

      let value = raw;
      if (isPersonField(id)) {
        const hit = resolveMemberName(raw, roster, lang, MemberAC.formatMember);
        value = hit.value;
        if (!hit.matched) unmatched.set(raw, (unmatched.get(raw) || 0) + 1);
      }
      const before = m ? String(roleGet(m.data, role) || '') : '';
      // An existing meeting that already says the same thing is not a change.
      if (m && before === value) { same++; return; }
      changes[id] = value;
      if (role.hidden) hidden++;
      // Filling a blank and replacing a name are very different acts — the
      // second one silently undoes an edit made on this page, so it is listed
      // in full rather than folded into the "待填欄位" count.
      if (before) conflicts.push({ date: col.date, label: role.label || id, from: before, to: value });
    });

    columns.push({
      date: col.date, existing: m || null, roleCount: col.roleCount,
      changes, changeCount: Object.keys(changes).length, same, hidden,
    });
  });

  return {
    columns,
    unmatched: [...unmatched.entries()].map(([name, n]) => ({ name, n })),
    conflicts,
    ignored: sheet.ignored, unknown: sheet.unknown, badDates: sheet.badDates,
    skippedLocked,
  };
}

/** Columns that will actually be acted on, given the "create empty slots" toggle. */
function plannedColumns(plan) {
  const withEmpty = document.getElementById('importIncludeEmpty')?.checked;
  return plan.columns.filter((c) => c.existing || c.roleCount > 0 || withEmpty);
}

async function startSheetImport() {
  const cid = activeClubId();
  if (cid == null || !canWrite()) return;

  // Google's CSV export is a round-trip through the backend and routinely
  // takes a few seconds, so the button spins for the whole fetch.
  const restoreBtn = busyButton(document.getElementById('btnImportSheet'), '讀取試算表…');
  try {
    const { csv } = await apiJson(`/clubs/${cid}/roles-sheet`);
    const sheet = parseRolesSheet(csv);
    if (!sheet.columns.length) { toast('試算表裡找不到可辨識的例會日期', true); return; }

    // Asked only once the sheet is in hand: from here on the board really is
    // reloaded (widening the range) and re-seeded (applyImport), but a failed
    // fetch above discards nothing, and warning about it beforehand would have
    // been a false alarm.
    if (!confirmDiscard()) return;

    if (!await ensureRangeCovers(sheet.columns.map((c) => c.date))) {
      toast('重新載入例會失敗，已取消匯入以免建立重複的場次', true);
      return;
    }
    importPlan = buildImportPlan(sheet);
    const empty = document.getElementById('importIncludeEmpty');
    if (empty) empty.checked = false;      // opt-in again on every import
    document.getElementById('importPreviewModal').style.display = 'flex';
    renderImportPreview();
  } catch (e) {
    toast(e.message || '讀取 Google Sheet 失敗', true);
  } finally {
    restoreBtn();
  }
}

function cancelImport() {
  if (importing) return;   // mid-flight: closing would orphan the progress UI
  const modal = document.getElementById('importPreviewModal');
  if (modal) modal.style.display = 'none';
  importPlan = null;
}

function renderImportPreview() {
  const body = document.getElementById('importPreviewBody');
  if (!body || !importPlan) return;
  const plan  = importPlan;
  const cols  = plannedColumns(plan);
  const toAdd = cols.filter((c) => !c.existing);
  const toSet = cols.filter((c) => c.changeCount > 0);
  const cells = toSet.reduce((s, c) => s + c.changeCount, 0);
  const hidden = toSet.reduce((s, c) => s + c.hidden, 0);
  const same   = plan.columns.reduce((s, c) => s + c.same, 0);
  // Conflicts only exist against meetings already on the board, which always
  // survive the "create empty slots" filter — so the whole list is in play.
  const conf = plan.conflicts;

  const list = (items) => items.map((s) => `<li>${esc(s)}</li>`).join('');
  const block = (cls, title, inner) =>
    `<div class="imp-block ${cls}"><div class="imp-block-t">${title}</div>${inner}</div>`;

  let html = `
    <div class="imp-stats">
      <div class="imp-stat"><b>${toAdd.length}</b><span>新增例會</span></div>
      <div class="imp-stat"><b>${cells - conf.length}</b><span>填入空格</span></div>
      <div class="imp-stat${conf.length ? ' imp-stat-warn' : ''}"><b>${conf.length}</b><span>覆蓋既有</span></div>
      <div class="imp-stat"><b>${toSet.length}</b><span>異動場次</span></div>
      <div class="imp-stat imp-stat-muted"><b>${same}</b><span>已相同</span></div>
    </div>`;

  if (conf.length) {
    const CAP = 40;
    const rows = conf.slice(0, CAP).map((c) => `
      <li>
        <span class="imp-conf-m">${esc(fmtDate(c.date))}</span>
        <span class="imp-conf-r">${esc(c.label)}</span>
        <span class="imp-conf-a">${esc(c.from)}</span>
        <span class="imp-conf-x">→</span>
        <span class="imp-conf-b">${esc(c.to)}</span>
      </li>`).join('');
    html += block('imp-warn', `${conf.length} 格會覆蓋既有內容`,
      '<p>這些格子目前已經有人，且與試算表不同——多半是後來在這頁改過的。試算表的值會蓋過去。</p>' +
      `<ul class="imp-conf">${rows}</ul>` +
      (conf.length > CAP ? `<p>…另有 ${conf.length - CAP} 格未列出。</p>` : ''));
  }

  if (toAdd.length) {
    html += block('', `將新增 ${toAdd.length} 場例會`,
      `<div class="imp-dates">${toAdd.map((c) => esc(fmtDate(c.date))).join('、')}</div>`);
  }
  if (hidden) {
    html += block('', `另含 ${hidden} 個矩陣未顯示的欄位`,
      '<p>演講題目、學習路徑等資訊沒有對應的角色列，會一併寫入議程，儲存後可在議程頁看到。</p>');
  }
  if (plan.unmatched.length) {
    html += block('imp-warn', `${plan.unmatched.length} 個名字不在會員名冊中`,
      `<p>會照試算表原文填入（來賓、他會會員通常如此）。</p><ul>${
        list(plan.unmatched.map((u) => `${u.name}（${u.n} 格）`))}</ul>`);
  }
  const skipped = [
    ...plan.ignored.map((i) => `${i.label} — ${i.reason}`),
    ...plan.unknown.map((u) => `${u} — 系統沒有對應的角色`),
    ...(plan.skippedLocked ? [`${plan.skippedLocked} 格 — 目前版型不使用該角色`] : []),
    ...plan.badDates.map((d) => `${d} — 無法辨識的日期，整欄略過`),
  ];
  if (skipped.length) html += block('imp-warn', '未匯入的內容', `<ul>${list(skipped)}</ul>`);

  html += block('imp-note', '不會被覆蓋的資料',
    '<p>試算表的空白格一律略過，報到接待、會長致歡迎詞、贈感謝狀、會後分享等表上沒有的角色也不受影響。' +
    '匯入後只是把值放進矩陣（以黃底標示未儲存），確認無誤再按「儲存變更」才會寫入。</p>');

  body.innerHTML = html;

  const btn = document.getElementById('importConfirmBtn');
  if (btn) {
    const nothing = !toAdd.length && !cells;
    btn.disabled = nothing;
    btn.textContent = nothing ? '沒有需要匯入的內容' : `匯入 ${cells} 個欄位`;
  }
}

async function applyImport() {
  if (!importPlan) return;
  const plan = importPlan;
  const cols = plannedColumns(plan);
  const cid  = activeClubId();

  importing = true;
  const restoreBtn = busyButton(document.getElementById('importConfirmBtn'), '匯入中…');
  const cancelBtn  = document.getElementById('importCancelBtn');
  if (cancelBtn) cancelBtn.disabled = true;

  // 1. Create the meetings the sheet has and the database does not. One POST
  //    per meeting, so a full season is a couple of dozen round-trips — worth
  //    a counter rather than an indefinite spinner.
  const failed = [];
  const toCreate = cols.filter((c) => !c.existing);
  showImportProgress(
    toCreate.length ? '正在建立例會…' : '正在套用試算表內容…',
    toCreate.length ? `0 / ${toCreate.length}` : '',
  );

  let created = 0;
  for (const col of toCreate) {
    try {
      const json = await apiJson('/agendas', {
        method: 'POST',
        body: { data: { meetingDate: col.date }, club_id: isSystemAdmin() ? cid : null },
      });
      const m = {
        id: json.id, meetingDate: col.date, meetingNo: '', meetingTheme: '',
        clubId: cid, data: { meetingDate: col.date }, draft: {}, dirty: new Set(),
      };
      meetings.push(m);
      col.existing = m;
    } catch {
      failed.push(fmtDate(col.date));
    }
    setImportProgress(`${++created} / ${toCreate.length}`);
  }

  if (toCreate.length) showImportProgress('正在套用試算表內容…');

  // 2. Redraw the board around the new columns before touching any draft —
  //    buildRows() resets roleById, so importRole() has to run after it.
  meetings.sort((a, b) => String(a.meetingDate).localeCompare(String(b.meetingDate)));
  buildRows();
  meetings.forEach(resetDraft);

  // 3. Land the sheet values as ordinary unsaved edits.
  let applied = 0;
  cols.forEach((col) => {
    const m = col.existing;
    if (!m) return;
    Object.entries(col.changes).forEach(([id, value]) => {
      if (!importRole(id)) return;
      m.draft[id] = value;
      m.dirty.add(id);
      applied++;
    });
  });

  renderMatrix();
  restoreBtn();
  if (cancelBtn) cancelBtn.disabled = false;
  importing = false;
  cancelImport();

  if (failed.length) toast(`${failed.length} 場例會建立失敗：${failed.join('、')}`, true);
  else if (applied)  toast(`已載入 ${applied} 個欄位，請確認後按「儲存變更」`);
  else               toast('沒有需要匯入的內容');
}

// ================================================================
// ADD MEETING (the matrix's trailing "+" column opens this modal)
// ================================================================
function startAddMeeting() {
  if (activeClubId() == null) return; // shouldn't happen — the column only renders once a club is picked
  const dateEl = document.getElementById('newMeetingDate');
  if (dateEl) dateEl.value = '';
  const modal = document.getElementById('addMeetingModal');
  if (modal) modal.style.display = 'flex';
  dateEl?.focus();
}

function cancelAddMeeting() {
  const modal = document.getElementById('addMeetingModal');
  if (modal) modal.style.display = 'none';
}

/**
 * Creates a bare-minimum agenda (just `meetingDate`) via the same POST every
 * other "new agenda" flow uses (app/agenda/page.js), then splices it straight
 * into the in-memory `meetings` list so it shows up as a fillable column
 * immediately — regardless of whether its date falls inside the currently
 * selected date-range filter — rather than round-tripping through
 * loadMeetings() (which would silently hide it if the filter excludes it).
 */
async function confirmAddMeeting() {
  const dateEl = document.getElementById('newMeetingDate');
  const date = dateEl?.value;
  if (!date) { toast('請先選擇日期', true); return; }

  const cid = activeClubId();
  try {
    const json = await apiJson('/agendas', {
      method: 'POST',
      body: { data: { meetingDate: date }, club_id: isSystemAdmin() ? cid : null },
    });

    const m = {
      id: json.id, meetingDate: date, meetingNo: '', meetingTheme: '',
      clubId: cid, data: { meetingDate: date }, draft: {}, dirty: new Set(),
    };
    meetings.push(m);
    meetings.sort((a, b) => String(a.meetingDate).localeCompare(String(b.meetingDate)));

    cancelAddMeeting();
    buildRows();
    meetings.forEach(resetDraft);
    renderMatrix();
    toast('已新增例會，可直接在矩陣中安排角色');
  } catch {
    toast('新增例會失敗', true);
  }
}

async function deleteMeeting(id) {
  const m = meetings.find((x) => x.id === id);
  if (!m) return;
  const label = fmtDate(m.meetingDate);
  const warn = m.dirty.size > 0 ? '（此場有未儲存的變更也會一併消失）' : '';
  if (!confirm(`確定要刪除「${label}」這場例會嗎？此動作無法復原，議程內容跟角色安排都會一起刪除。${warn}`)) return;

  try {
    await apiJson(`/agendas/${id}`, { method: 'DELETE' });
    meetings = meetings.filter((x) => x.id !== id);
    buildRows();
    meetings.forEach(resetDraft);
    renderMatrix();
    updateRangeLabel(meetings.length);
    toast('已刪除該場例會');
  } catch {
    toast('刪除失敗', true);
  }
}

// ================================================================
// MISC
// ================================================================
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'toast visible' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

export default function RolesPage() {
  const [saveDisabled, setSaveDisabledState] = useState(true);
  const [saveLabel, setSaveLabelState] = useState('儲存變更');

  useEffect(() => {
    // Bridge for oninput="..."/onclick="..." strings inside renderMatrix()'s innerHTML.
    window.__rolesOnCellInput = onCellInput;
    window.__rolesOnPathwayInput = onPathwayInput;
    window.__rolesOnPathwayCustom = onPathwayCustom;
    window.__rolesStartAddMeeting = startAddMeeting;
    window.__rolesCancelAddMeeting = cancelAddMeeting;
    window.__rolesConfirmAddMeeting = confirmAddMeeting;
    window.__rolesDeleteMeeting = deleteMeeting;
    setSaveDisabled = setSaveDisabledState;
    setSaveLabel = setSaveLabelState;

    applyRoleUI();

    const onKeydown = (e) => {          // Ctrl/Cmd+S saves the board
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (canWrite()) saveAll();
      }
    };
    const onBeforeUnload = (e) => {
      if (dirtyMeetings().length) { e.preventDefault(); e.returnValue = ''; }
    };
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('beforeunload', onBeforeUnload);

    const cleanupAutocomplete = MemberAC.init();

    (async function init() {
      applyRoleUI();
      const ok = await checkRolesAuth();
      if (!ok) return;

      const r = defaultRange();
      dateFrom = r.from;
      dateTo   = r.to;
      syncDateInputs();

      // Needed by everyone, not just admins — activeTemplateKey() resolves the
      // active club's template from this list even for a single-club user.
      // The Pathways catalog feeds the speech sub-rows and the sheet import's
      // pathway-code check, so it has to be in before the matrix renders.
      const [, pathwaysOk] = await Promise.all([loadClubsMeta(), loadPathways()]);
      if (!pathwaysOk) toast('Pathways 目錄載入失敗，學習路徑欄位暫時只能保留原值', true);

      if (isSystemAdmin()) {
        if (selectedClubId == null) { showPickClubHint(); return; }
      }
      await Promise.all([loadRoster(), loadMeetings()]);
    })();

    return () => {
      delete window.__rolesOnCellInput;
      delete window.__rolesOnPathwayInput;
      delete window.__rolesOnPathwayCustom;
      delete window.__rolesStartAddMeeting;
      delete window.__rolesCancelAddMeeting;
      delete window.__rolesConfirmAddMeeting;
      delete window.__rolesDeleteMeeting;
      setSaveDisabled = null;
      setSaveLabel = null;
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('beforeunload', onBeforeUnload);
      cleanupAutocomplete?.();
    };
  }, []);

  return (
    <>
      <Sidebar active="roles" />

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">角色安排</div>
          <div className="topbar-actions">
            <span className="save-state" id="saveState">已同步</span>
            <button className="btn-ghost write-action" onClick={discardChanges}>捨棄變更</button>
            <button className="btn-add write-action" id="btnSaveAll" onClick={saveAll} disabled={saveDisabled}>{saveLabel}</button>
          </div>
        </header>

        <div className="content">

          {/* Toolbar */}
          <div className="picker-card">
            <div id="clubPickerBar" style={{ display: 'none' }}>
              <span className="picker-label">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                分會
                <select id="clubPickerSelect" className="picker-select" onChange={onClubChange} style={{ marginLeft: 6 }}>
                  <option value="">— 請選擇分會 —</option>
                </select>
              </span>
            </div>

            <span className="picker-label">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              例會日期
              <input type="date" id="dateFrom" className="picker-select picker-date" onChange={onDateRangeChange} style={{ marginLeft: 6 }} />
              <span className="date-sep">～</span>
              <input type="date" id="dateTo" className="picker-select picker-date" onChange={onDateRangeChange} />
            </span>

            <div className="range-presets">
              <button className="btn-pager" onClick={() => applyPreset('shift', -1)} title="範圍整段往前一個月">←</button>
              <button className="btn-pager" onClick={() => applyPreset('around')}>近期</button>
              <button className="btn-pager" onClick={() => applyPreset('upcoming')}>未來</button>
              <button className="btn-pager" onClick={() => applyPreset('year')}>今年</button>
              <button className="btn-pager" onClick={() => applyPreset('all')}>全部</button>
              <button className="btn-pager" onClick={() => applyPreset('shift', 1)} title="範圍整段往後一個月">→</button>
            </div>

            {/* Shown only for a writer on a club whose 版型設定 binds a sheet. */}
            <button className="btn-sheet" id="btnImportSheet" style={{ display: 'none' }}
                    onClick={startSheetImport} title="從分會設定的 Google Sheet 讀取角色安排">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
              從 Google Sheet 匯入
            </button>

            <div className="toolbar-spacer"></div>

            <span className="roster-count" id="rosterCount"></span>
            <span className="pager-label" id="templateLabel"></span>
            <span className="pager-label" id="pagerLabel"></span>
          </div>

          <div className="hint-bar">
            <span className="hint-chip">每格可從下拉選單挑選會員，也可直接輸入姓名（來賓、代理人等）。</span>
            <span className="hint-chip"><span className="hint-swatch edited"></span>未儲存</span>
          </div>

          {/* Role matrix */}
          <div className="matrix-card">
            <div className="matrix-wrap" id="matrixWrap">
              <div className="loading-spinner"><div className="spinner"></div></div>
            </div>
          </div>

        </div>
      </div>

      <div id="memberDropdown" className="member-dropdown"></div>
      <div id="toast" className="toast"></div>

      <div id="importPreviewModal" className="modal-overlay" style={{ display: 'none' }}
           onClick={(e) => { if (e.target === e.currentTarget) cancelImport(); }}>
        <div className="modal-box modal-box-import">
          <div className="modal-header">
            <h3>從 Google Sheet 匯入角色</h3>
            <button className="modal-close" onClick={cancelImport}>✕</button>
          </div>
          <div className="modal-body imp-body" id="importPreviewBody"></div>
          <div className="modal-actions imp-actions">
            <label className="imp-toggle">
              <input type="checkbox" id="importIncludeEmpty" onChange={renderImportPreview} />
              一併建立沒有角色資料的空場次
            </label>
            <div className="imp-actions-btns">
              <button className="modal-btn modal-btn-cancel" id="importCancelBtn" onClick={cancelImport}>取消</button>
              <button className="modal-btn modal-btn-confirm" id="importConfirmBtn" onClick={applyImport}>匯入</button>
            </div>
          </div>
        </div>
      </div>

      <div id="addMeetingModal" className="modal-overlay" style={{ display: 'none' }}
           onClick={(e) => { if (e.target === e.currentTarget) cancelAddMeeting(); }}>
        <div className="modal-box modal-box-confirm">
          <div className="modal-header">
            <h3>新增例會</h3>
            <button className="modal-close" onClick={cancelAddMeeting}>✕</button>
          </div>
          <div className="modal-body">
            <label className="modal-field-label" htmlFor="newMeetingDate">例會日期</label>
            <input type="date" id="newMeetingDate" className="modal-date-input"
                   onKeyDown={(e) => { if (e.key === 'Enter') confirmAddMeeting(); }} />
            <p className="modal-field-hint">建立後可以直接在矩陣的新欄位裡安排角色，其餘議程內容（場地、時間…）之後再到議程頁補齊即可。</p>
          </div>
          <div className="modal-actions">
            <button className="modal-btn modal-btn-cancel" onClick={cancelAddMeeting}>取消</button>
            <button className="modal-btn modal-btn-confirm" onClick={confirmAddMeeting}>新增</button>
          </div>
        </div>
      </div>
    </>
  );
}
