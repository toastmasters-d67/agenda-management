'use client';

import { useEffect } from 'react';
import Script from 'next/script';
import { apiJson, apiFetch } from '@/lib/api';
import { setAuth, clearAuth, applyRoleUI, isSystemAdmin, getUsername, getClubId, logout } from '@/lib/auth';
import {
  AGENDA_TEMPLATES,
  MAX_EVAL_EVALUATORS,
  templateAssetDefaults,
  templateFieldDefaults,
  templatePlaceholders,
  applyTmplVisibility,
} from '@/lib/agendaTemplates';
import {
  loadPathways,
  pathwayPairs,
  pathwayList,
  CUSTOM_VALUE,
  levelValue,
  levelNumber,
  requiredLevelOf,
  projectName,
  pathwaySelect,
  levelSelect,
  projectSelect,
} from '@/lib/pathways';
import './agenda.css';

// ================================================================
// This page is a deliberate lift-and-shift port of the legacy
// index.html + app.js agenda generator (imperative DOM ops kept
// nearly verbatim rather than rewritten as React state) — see the
// migration plan for rationale. Module-level `let`/`const` mirror
// the original inline <script> globals.
//
// Member autocomplete is kept as its own inline implementation here
// (acActiveInput/acRender/acFilteredItems/initAutocomplete) rather than
// switching to lib/memberAutocomplete.js — ground-truth inspection of
// index.html showed this page never loaded member-ac.js; its autocomplete
// reads the page-global `lang` toggle directly, not a per-input
// data-ac-lang attribute, so the two implementations aren't drop-in
// compatible. lib/memberAutocomplete.js is used by the /roles page only.
// ================================================================

// ================================================================
// STATE
// ================================================================
let speeches = [
  { title: 'TBD', speaker: '', duration: "5'-7'", speechLang: 'en', pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
  { title: '', speaker: '', duration: "5'-7'", speechLang: 'en', pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
  { title: '', speaker: '', duration: "5'-7'", speechLang: 'en', pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
];

let evaluators = ['', '', ''];

// 講評員講評 — people who evaluate the individual evaluators. Printed right
// after 總講評, still inside the evaluation block. Optional: a meeting normally
// has none, and never more than MAX_EVAL_EVALUATORS (see lib/agendaTemplates.js).
let evalEvaluators = [];

// CHINA template only — page-2 reference content (previous-meeting recap /
// per-project purpose notes / next-meeting speaker preview). Role assignment
// itself now goes through the same fixed fields every template uses.
const CHINA_PROJECT_COUNT = 3;

// CHINA template only — the next chronological meeting's role fields, looked
// up live (see ensureNextMeetingRoles) so the printed "Next Meeting" column
// is always accurate without a manually-typed/duplicated field. Keyed by
// `${clubId}|${meetingDate}` so a lookup is only re-issued when either changes.
let nextRolesCacheKey = null;
let nextRolesCache = {};

let lang = 'en';
// When true (bilingual templates), member names render as "English 中文".
let bilingualNames = false;

const TRANSLATIONS = {
  en: {
    reception: 'Reception & Social Gathering',
    callingOrder: "1' Calling Meeting to Order",
    welcomeGuests: "2' Welcome Guests & TME",
    tmeIntro: "3' Toastmaster of The Evening",
    timerExplain: "2' Timer｜Meeting Rules Explanation",
    ahExplain: "2' Ah-counter｜Meeting Rules Explanation",
    preparedSpeech: 'Prepared Speech',
    groupPhoto: 'Group Photo',
    allParticipants: 'All Participants',
    intermission: (n) => `— Intermission & Social Time (${n} min) —`,
    tableTopics: 'Table Topics Session',
    evaluation: 'Evaluation Session',
    evaluatorFor: (n) => `Individual Evaluator for Speaker #${n}`,
    evalEvaluatorFor: (n) => `Evaluator's Evaluator #${n}`,
    timerReport: 'Timer Report',
    ahReport: 'Ah-counter Report',
    langEval: 'Language Evaluation',
    generalEval: 'General Evaluation',
    tmeClosing: 'Toastmaster of the Evening',
    awards: 'Awards Presentation',
    sharing: 'Sharing & Feedback',
    meetingEnd: 'Meeting Ends',
    adjournment: '— Meeting Adjournment —',
    thTime: 'Time',
    thAgenda: 'Agenda (Program)',
    thTaker: 'Assignment Taker',
    thPathways: '⏱ Pathways',
    themeLabel: 'Meeting  Theme:',
    meetingNoLabel: (n) => `Meeting No.${n}`,
    missionTitle: '— Mission of Toastmasters Club —',
    missionText: '"We provide a supportive and positive learning experience in which members are empowered to develop communication and leadership skills, resulting in greater self-confidence and personal growth."',
    timeRules: 'Time Rules',
    trPrepared: 'Prepared Speech',
    trTopic: 'Table Topic',
    trEval: 'Evaluator',
    trLEGE: 'LE&GE',
    fbLabel: 'Follow us on FB!',
    lineLabel: 'Connect us with LINE@',
    foundedSince: 'Founded Since',
    fee: 'Fee',
    varietySession: 'Variety Session',
    meetingSchedule: 'Meeting on every 1st (中文) and 3rd (English) Tuesday evening',
  },
  zh: {
    reception: '報到 & 交誼',
    callingOrder: "1' 宣布例會開始－領導宣讀宣言",
    welcomeGuests: "2' 會長致歡迎詞",
    tmeIntro: "3' 總主持人",
    timerExplain: "2' 計時員",
    ahExplain: "2' 贅語記錄員",
    preparedSpeech: '指定演講',
    groupPhoto: '大合照',
    allParticipants: '所有與會者',
    intermission: (n) => ` ——— 休息 & 交誼時間（${n} 分鐘）——— `,
    tableTopics: '即席問答',
    evaluation: '講評時間',
    evaluatorFor: (n) => `個別講評員 #${n}`,
    evalEvaluatorFor: (n) => `講評員講評 #${n}`,
    timerReport: '計時員報告',
    ahReport: '贅語記錄員報告',
    langEval: '語言講評',
    generalEval: '總講評',
    tmeClosing: '總主持人',
    awards: '贈感謝狀',
    sharing: '會後分享 & 來賓回饋',
    meetingEnd: '會議結束',
    adjournment: '——— 會議圓滿 ———',
    thTime: '時間',
    thAgenda: '議程表',
    thTaker: '角色擔任',
    thPathways: '⏱ 學習路徑',
    themeLabel: '會議主題：',
    meetingNoLabel: (n) => `第 ${n} 次例會`,
    missionTitle: '——— 演講會宗旨 ———',
    missionText: '訓練溝通及領導能力，強調終身學習。參加國際演講協會是增進溝通技巧的最佳方法，除了大幅增加公開演講的自信外，在這裡所學到的領導技巧，更是您邁向成功之路的必備基石。',
    timeRules: '時間規則',
    trPrepared: '指定演講',
    trTopic: '即席問答',
    trEval: '個別講評',
    trLEGE: '語言&總講評',
    fbLabel: '追蹤我們的 FB！',
    lineLabel: '加入企業家 LINE 群組！',
    foundedSince: '成立日期',
    fee: '入場費',
    varietySession: '多元單元',
    meetingSchedule: '會議日期為每月第 1 個星期二 (中文) / 第 3 個星期二 (English)',
  },
};

function t(key, ...args) {
  const v = TRANSLATIONS[lang][key];
  return typeof v === 'function' ? v(...args) : v;
}

function toggleLang() {
  lang = lang === 'en' ? 'zh' : 'en';
  const btn = document.getElementById('langToggle');
  if (btn) btn.textContent = lang === 'en' ? '切換中文' : 'Switch to EN';
  refreshInputsForLang();
  updatePreview();
}

function refreshInputsForLang() {
  const staticFields = [
    'receptionHost', 'callingToOrder', 'welcomeTME', 'tme', 'timer', 'ahCounter',
    'tableTopicsMaster', 'generalEvaluator', 'langEvaluator', 'awardsPresenter', 'sharingFeedback',
  ];
  staticFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.value) el.value = displayMember(el.value);
  });

  speeches.forEach((sp) => {
    if (sp.speaker) sp.speaker = displayMember(sp.speaker);
  });
  evaluators = evaluators.map((ev) => (ev ? displayMember(ev) : ev));
  evalEvaluators = evalEvaluators.map((ev) => (ev ? displayMember(ev) : ev));

  if (varietySession.host) {
    varietySession.host = displayMember(varietySession.host);
    const el = document.getElementById('varietyHost');
    if (el) el.value = varietySession.host;
  }

  renderSpeechForms();
  renderEvaluatorForms();
  renderEvalEvaluatorForms();
}

// Every clock time shown in the agenda's time column can be pinned by hand.
// Blank = derive it from the previous block, as before. A pinned time also
// becomes the anchor for everything after it, so pinning one row shifts the
// rest of the evening instead of silently disagreeing with it.
const timeOverrides = {
  endTime: '',
  receptionStart: '',
  openingStart: '',
  speechStart: '',
  preparedSpeechStart: '',
  photoStart: '',
  topicsStart: '',
  evalStart: '',
  closingStart: '',
  sharingStart: '',
};

// Every block duration can likewise be pinned. Blank = auto:
//   speechMins → Σ speech durations + 4' transition + TME hosting
//   evalMins   → 3' per evaluator (incl. 講評員講評) + 12' fixed reports + GE hosting
//   topicsMins / intermissionMins → absorb the slack up to the target end time
const durationOverrides = {
  receptionMins: '',
  openingMins: '',
  speechMins: '',
  photoMins: '',
  intermissionMins: '',
  topicsMins: '',
  evalMins: '',
  closingMins: '',
  sharingMins: '',
};

// Fixed-duration rows inside the evaluation block. These are *ranges* ("2'~3'"),
// not numbers that feed the arithmetic, so they are kept as display strings and
// edited directly — same pattern as `signals`.
function defaultDurationLabels() {
  return {
    evaluator: "2'~3'",
    timerReport: "1'",
    ahReport: "1'",
    langEval: "3'~5'",
    generalEval: "3'~5'",
    evalEvaluator: "2'~3'",
  };
}
let durationLabels = defaultDurationLabels();

function updateDurationLabel(key, value) {
  durationLabels[key] = value;
  updatePreview();
}

const durationSettings = {
  tmeMins: 4,
  geMins: 4,
};

function updateDuration(key, value) {
  const n = parseInt(value, 10);
  durationSettings[key] = isNaN(n) || n < 0 ? 0 : n;
  updatePreview();
}

const varietySession = {
  enabled: false,
  duration: 15,
  host: '',
};

function toggleVariety(checked) {
  varietySession.enabled = checked;
  const fields = document.getElementById('varietyFields');
  if (fields) fields.style.display = checked ? '' : 'none';
  updatePreview();
}

function updateVariety(key, value) {
  if (key === 'duration') {
    const n = parseInt(value, 10);
    varietySession[key] = isNaN(n) || n < 1 ? 1 : n;
  } else {
    varietySession[key] = value;
  }
  updatePreview();
}

// Per-meeting time-signal cards (green / yellow / red), editable per category.
// Used by templates that render inline time-management columns (e.g. chillhihigh).
// Defaults mirror standard Toastmasters timing; stored as strings to allow 2'30".
function defaultSignals() {
  return {
    variety: { g: '10', y: `12'30"`, r: '15' },
    preparedSpeech: { g: '5', y: '6', r: '7' },
    tableTopics: { g: '10', y: `12'30"`, r: '15' },
    ttSpeakerSpec: `1'/1'30"/2'`,
    evaluation: { g: '2', y: `2'30"`, r: '3' },
    langEval: { g: '3', y: '4', r: '5' },
    generalEval: { g: '3', y: '4', r: '5' },
  };
}
let signals = defaultSignals();

// oninput handler: cat='variety'|'preparedSpeech'|… , key='g'|'y'|'r'
function updateSignal(cat, key, value) {
  if (key === null) { signals[cat] = value; } // scalar (ttSpeakerSpec)
  else { signals[cat] = { ...signals[cat], [key]: value }; }
  updatePreview();
}

// Bundled fallbacks used when a club has no custom logo/QR uploaded. Sourced
// from the standard template's assetDefaults (lib/agendaTemplates.js) so the
// default image paths live in one place.
const _stdAssets = templateAssetDefaults('standard');
const DEFAULT_IMAGES = {
  logo: _stdAssets.logo_url,
  fbQr: _stdAssets.fb_qr_url,
  lineQr: _stdAssets.line_qr_url,
};

const images = {
  logo: DEFAULT_IMAGES.logo,
  themeImg: null,
  themeImgBase64: null, // local base64, avoids CORS when rendering to canvas
  fbQr: DEFAULT_IMAGES.fbQr,
  lineQr: DEFAULT_IMAGES.lineQr,
};

// ================================================================
// IMAGE HANDLING
// ================================================================
async function uploadThemeImage(input) {
  const file = input.files[0];
  if (!file) return;

  const statusEl = document.getElementById('themeImgStatus');
  if (statusEl) statusEl.textContent = '上傳中...';

  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const presign = await apiJson('/upload/presign', {
      method: 'POST',
      body: {
        filename: file.name,
        content_type: file.type,
        meeting_date: val('meetingDate') || null,
        meeting_no: val('meetingNo') || null,
        // file theme images under the agenda's club folder
        club_id: (isSystemAdmin() ? selectedClubId : getClubId()) || null,
      },
    });
    const { uploadUrl, publicUrl } = presign;

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!uploadRes.ok) throw new Error('上傳至 R2 失敗');

    images.themeImg = publicUrl;
    images.themeImgBase64 = base64;
    if (statusEl) statusEl.textContent = '✓ 上傳成功';
    updatePreview();
    setSaveStatus('unsaved');
  } catch (e) {
    if (statusEl) statusEl.textContent = `✕ ${e.message}`;
    input.value = '';
  }
}

function clearThemeImage() {
  images.themeImg = null;
  images.themeImgBase64 = null;
  const el = document.getElementById('img_themeImg');
  if (el) el.value = '';
  const statusEl = document.getElementById('themeImgStatus');
  if (statusEl) statusEl.textContent = '';
  updatePreview();
  setSaveStatus('unsaved');
}

// ================================================================
// SPEECH FORM
// ================================================================
function renderSpeechForms() {
  const container = document.getElementById('speechesList');
  if (!container) return;
  container.innerHTML = speeches.map((sp, i) => `
    <div class="speech-entry" id="speech-${i}">
      <div class="speech-entry-header">
        <span>演講 #${i + 1}</span>
        <button class="btn-remove" onclick="window.__idxRemoveSpeech(${i})">✕ 移除</button>
      </div>
      <div class="form-row">
        <label>演講標題 Title</label>
        <textarea rows="2" oninput="window.__idxUpdateSpeech(${i},'title',this.value)">${sp.title}</textarea>
      </div>
      <div class="form-row">
        <label>講者 Speaker (姓名 + 頭銜)</label>
        <input type="text" class="member-ac" value="${sp.speaker}" oninput="window.__idxUpdateSpeech(${i},'speaker',this.value)" placeholder="e.g. John Smith, TM">
      </div>
      <div class="form-row">
        <label>時長 Duration</label>
        <input type="text" value="${sp.duration}" oninput="window.__idxUpdateSpeech(${i},'duration',this.value)" placeholder="5'-7'">
      </div>
      <div class="form-row">
        <label>演講語言 Language（Chill Hi High 用於個別講評員標示）</label>
        <select class="sp-lang" oninput="window.__idxUpdateSpeech(${i},'speechLang',this.value)">
          <option value="en">英語 English</option>
          <option value="zh">國語 Mandarin</option>
        </select>
      </div>
      ${Object.entries(PW_FIELDS).map(([field, f]) => `
      <div class="form-row">
        <label>${f.label}</label>
        <select class="${f.cls}" oninput="window.__idxSpeechPwSelect(${i},'${field}',this.value)"></select>
        <input type="text" class="${f.cls}-custom" style="display:none;margin-top:4px"
               oninput="window.__idxSpeechPwCustom(${i},'${field}',this.value)" placeholder="${f.placeholder}">
      </div>`).join('')}
    </div>
  `).join('');

  speeches.forEach((sp, i) => {
    Object.keys(PW_FIELDS).forEach((field) => fillPwField(i, field));
    const lg = document.querySelector(`#speech-${i} .sp-lang`);
    if (lg) lg.value = sp.speechLang || 'en';
  });

  renderEvaluatorForms();

  updatePreview();
}

// The three Pathways fields: each a catalog <select> plus a text box for
// anything else ("其他／自訂"). A stored value the catalog doesn't know — typed
// by hand, `4-1` from the roles sheet — opens straight into the text box, so
// it stays editable and is never rewritten by just opening the agenda.
// Projects are stored by English name and printed in the agenda's language.
const PW_FIELDS = {
  pathwayCode: {
    label: '學習路徑 Pathway', cls: 'sp-pathway', placeholder: '自訂路徑代碼或名稱',
    build: (sp) => pathwaySelect(sp.pathwayCode),
  },
  pathwayLevel: {
    label: '等級 Level', cls: 'sp-level', placeholder: '自訂等級，例如 L3P2',
    build: (sp) => levelSelect(sp.pathwayLevel),
  },
  pathwayProject: {
    label: '專案名稱 / 備註 Project', cls: 'sp-project', placeholder: '自訂專案名稱或備註',
    build: (sp) => projectSelect(sp.pathwayCode, sp.pathwayLevel, sp.pathwayProject),
  },
};

function fillPwField(i, field) {
  const { cls, build } = PW_FIELDS[field];
  const sel = document.querySelector(`#speech-${i} .${cls}`);
  const box = document.querySelector(`#speech-${i} .${cls}-custom`);
  if (!sel || !box) return;
  const { html, value, custom } = build(speeches[i]);
  sel.innerHTML = html;
  sel.value = value;
  box.style.display = custom ? '' : 'none';
  if (document.activeElement !== box) box.value = custom ? speeches[i][field] : '';
}

// Path and level filter the project list, so a change to either refills it.
function afterPwChange(i, field) {
  if (field !== 'pathwayProject') fillPwField(i, 'pathwayProject');
  updatePreview();
}

function setSpeechPwSelect(i, field, value) {
  const sp = speeches[i];
  const box = document.querySelector(`#speech-${i} .${PW_FIELDS[field].cls}-custom`);
  if (value === CUSTOM_VALUE) {
    sp[field] = '';
    if (box) { box.value = ''; box.style.display = ''; box.focus(); }
    afterPwChange(i, field);
    return;
  }
  if (box) box.style.display = 'none';
  sp[field] = value;
  // Picking a required project with no level yet fills the level in for you.
  if (field === 'pathwayProject' && value && !levelNumber(sp.pathwayLevel)) {
    const l = requiredLevelOf(sp.pathwayCode, value);
    if (l) {
      sp.pathwayLevel = levelValue(l);
      fillPwField(i, 'pathwayLevel');
      fillPwField(i, 'pathwayProject');
    }
  }
  afterPwChange(i, field);
}

function setSpeechPwCustom(i, field, value) {
  speeches[i][field] = value;
  afterPwChange(i, field);
}

function renderEvaluatorForms() {
  const container = document.getElementById('evaluatorsList');
  if (!container) return;
  container.innerHTML = evaluators.map((ev, i) => `
    <div class="speech-entry" style="padding:8px 10px">
      <div class="speech-entry-header">
        <span>講評 #${i + 1} <span class="time-hint">2'~3'</span></span>
        <button class="btn-remove" onclick="window.__idxRemoveEvaluator(${i})">✕ 移除</button>
      </div>
      <div class="form-row" style="margin-bottom:0">
        <input type="text" value="${esc(ev)}"
               oninput="window.__idxEvalInput(${i}, this.value)"
               placeholder="Name, Title" class="member-ac">
      </div>
    </div>
  `).join('') + `<button class="btn-add" onclick="window.__idxAddEvaluator()">+ 新增講評</button>`;
}

function addEvaluator() {
  evaluators.push('');
  renderEvaluatorForms();
  updatePreview();
}

function removeEvaluator(i) {
  evaluators.splice(i, 1);
  renderEvaluatorForms();
  updatePreview();
}

// 講評員講評 — same list UI as the individual evaluators, but capped at
// MAX_EVAL_EVALUATORS and empty by default (most meetings have none), so the
// "+ 新增" button disappears once the cap is reached rather than silently
// accepting a row no template would print.
function renderEvalEvaluatorForms() {
  const container = document.getElementById('evalEvaluatorsList');
  if (!container) return;
  const atMax = evalEvaluators.length >= MAX_EVAL_EVALUATORS;
  container.innerHTML = evalEvaluators.map((ev, i) => `
    <div class="speech-entry" style="padding:8px 10px">
      <div class="speech-entry-header">
        <span>講評員講評 #${i + 1} <span class="time-hint">2'~3'</span></span>
        <button class="btn-remove" onclick="window.__idxRemoveEvalEvaluator(${i})">✕ 移除</button>
      </div>
      <div class="form-row" style="margin-bottom:0">
        <input type="text" value="${esc(ev)}"
               oninput="window.__idxEvalEvalInput(${i}, this.value)"
               placeholder="Name, Title" class="member-ac">
      </div>
    </div>
  `).join('') + (atMax
    ? `<p class="time-override-hint" style="margin:6px 0 0">已達上限 ${MAX_EVAL_EVALUATORS} 位。</p>`
    : `<button class="btn-add" onclick="window.__idxAddEvalEvaluator()">+ 新增講評員講評</button>`);
}

function addEvalEvaluator() {
  if (evalEvaluators.length >= MAX_EVAL_EVALUATORS) return;
  evalEvaluators.push('');
  renderEvalEvaluatorForms();
  updatePreview();
}

function removeEvalEvaluator(i) {
  evalEvaluators.splice(i, 1);
  renderEvalEvaluatorForms();
  updatePreview();
}

function addSpeech() {
  speeches.push({ title: '', speaker: '', duration: "5'-7'", speechLang: 'en', pathwayCode: '', pathwayLevel: '', pathwayProject: '' });
  renderSpeechForms();
  updatePreview();
}

function removeSpeech(i) {
  speeches.splice(i, 1);
  renderSpeechForms();
  updatePreview();
}


// Push a loaded/reset CHINA payload into its (non-repeating) page-2 plain
// form fields. `d` is `{}` when resetting to blank defaults. Role fields
// (including the 4 CHINA-only ones) ride the same generic `fields` list
// applyAgendaData() already handles for every template — nothing CHINA-
// specific needed there.
function applyChinaFields(d) {
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };

  const pm = d.prevMeeting || {};
  ['date', 'attendMembers', 'attendGuests', 'bestSpeaker', 'bestEvaluator', 'bestTopicsSpeaker', 'bestSessionMaster']
    .forEach((k) => setVal(`pm_${k}`, pm[k]));

  const projects = d.speechProjects || [];
  for (let i = 0; i < CHINA_PROJECT_COUNT; i++) {
    const p = projects[i] || {};
    setVal(`proj_${i}_speaker`, p.speaker);
    setVal(`proj_${i}_code`, p.projectCode);
    setVal(`proj_${i}_purpose`, p.purpose);
    setVal(`proj_${i}_eval`, p.evaluatorNote);
    const spEl = document.getElementById(`proj_${i}_spotlight`);
    if (spEl) spEl.checked = !!p.spotlight;
  }

  const nexts = d.nextSpeakers || [];
  for (let i = 0; i < CHINA_PROJECT_COUNT; i++) setVal(`nextSpeaker_${i}`, nexts[i]);
}

function updateSpeech(i, key, value) {
  speeches[i][key] = value;
  updatePreview();
}

// ================================================================
// TIME HELPERS
// ================================================================
function parseDurationMax(str) {
  const nums = (str || '').match(/\d+/g);
  if (!nums || !nums.length) return 7;
  return Math.max(...nums.map(Number));
}

function timeToMins(str) {
  const parts = (str || '0:0').split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

function minsToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addMins(timeStr, delta) {
  return minsToTime(timeToMins(timeStr) + delta);
}

function calcTimes(spList) {
  const validTime = (s) => /^\d{1,2}:\d{2}$/.test((s || '').trim());
  const getTime = (key, auto) => (validTime(timeOverrides[key]) ? timeOverrides[key].trim() : auto);
  const validDur = (s) => { const n = parseInt(s, 10); return !isNaN(n) && n >= 0; };
  const getDur = (key, auto) => (validDur(durationOverrides[key]) ? parseInt(durationOverrides[key], 10) : auto);

  const receptionStart = getTime('receptionStart', '18:50');
  const endTime = getTime('endTime', '21:00');

  const receptionMins = getDur('receptionMins', 20);
  const openingStart = getTime('openingStart', addMins(receptionStart, receptionMins));
  const openingMins = getDur('openingMins', 10);
  const varietyMins = varietySession.enabled ? varietySession.duration : 0;
  // speech block: sum of max durations + 4 min transition + TME hosting
  const speechMins = getDur('speechMins',
    spList.reduce((s, sp) => s + parseDurationMax(sp.duration), 0) + 4 + durationSettings.tmeMins);
  const photoMins = getDur('photoMins', 5);
  // eval: 3' per evaluator (individual + 講評員講評) + timer(1) + ah(1)
  //       + LE(5) + GE(5) + GE hosting
  const evalMins = getDur('evalMins',
    (evaluators.length + evalEvaluators.length) * 3 + 12 + durationSettings.geMins);
  const closingMins = getDur('closingMins', 6);
  const sharingMins = getDur('sharingMins', 5);

  const ovIM = parseInt(durationOverrides.intermissionMins, 10);
  const hasManualIM = !isNaN(ovIM) && String(durationOverrides.intermissionMins).trim() !== '';
  const ovTM = parseInt(durationOverrides.topicsMins, 10);
  const hasManualTM = !isNaN(ovTM) && String(durationOverrides.topicsMins).trim() !== '';

  const baseIM = hasManualIM ? ovIM : 5;
  const baseTM = hasManualTM ? ovTM : 10;

  const fixedMins = openingMins + varietyMins + speechMins + photoMins + baseIM + baseTM + evalMins + closingMins + sharingMins;
  let slack = timeToMins(endTime) - timeToMins(openingStart) - fixedMins;

  let topicsMins, intermissionMins;
  if (hasManualIM && hasManualTM) {
    topicsMins = ovTM;
    intermissionMins = ovIM;
  } else if (hasManualIM) {
    intermissionMins = ovIM;
    topicsMins = baseTM + Math.min(10, Math.max(0, slack));
  } else if (hasManualTM) {
    topicsMins = ovTM;
    intermissionMins = baseIM + Math.min(10, Math.max(0, slack));
  } else {
    const topicsExtra = Math.min(10, Math.max(0, slack));
    slack -= topicsExtra;
    const intermissionExtra = Math.min(10, Math.max(0, slack));
    topicsMins = 10 + topicsExtra;
    intermissionMins = 5 + intermissionExtra;
  }

  // Start times run sequentially, each one either pinned by hand or derived from
  // the block before it — so a pinned time carries the rest of the chain with it.
  const speechStart = getTime('speechStart', addMins(openingStart, openingMins));
  const preparedSpeechStart = getTime('preparedSpeechStart', addMins(speechStart, varietyMins));
  const photoStart = getTime('photoStart', addMins(preparedSpeechStart, speechMins));
  const topicsStart = getTime('topicsStart', addMins(photoStart, photoMins + intermissionMins));
  const evalStart = getTime('evalStart', addMins(topicsStart, topicsMins));
  const closingStart = getTime('closingStart', addMins(evalStart, evalMins));
  const sharingStart = getTime('sharingStart', addMins(closingStart, closingMins));
  // When the last block actually ends — printed as the agenda's final row.
  const meetingEnd = addMins(sharingStart, sharingMins);

  return {
    receptionStart, receptionMins, openingStart, endTime,
    openingMins, speechStart, varietyMins, preparedSpeechStart, speechMins,
    photoStart, photoMins, topicsStart, topicsMins,
    evalStart, evalMins, closingStart, closingMins, sharingStart, sharingMins,
    intermissionMins, meetingEnd,
  };
}

function updateTimeOverride(key, value) {
  timeOverrides[key] = value;
  updatePreview();
}

function resetTimeOverride(key) {
  timeOverrides[key] = '';
  const el = document.getElementById(`to_${key}`);
  if (el) el.value = '';
  updatePreview();
}

function updateDurationOverride(key, value) {
  durationOverrides[key] = value;
  updatePreview();
}

function resetDurationOverride(key) {
  durationOverrides[key] = '';
  const el = document.getElementById(`to_${key}`);
  if (el) el.value = '';
  updatePreview();
}

/**
 * What one field would show if it alone were un-pinned — exactly the value its
 * ⟳ button restores. Pins further up the chain still count, so the hint never
 * contradicts what you'd actually get. Computed by clearing that single
 * override for the duration of one (pure, synchronous) calcTimes call.
 */
function autoValueFor(key) {
  const store = key in timeOverrides ? timeOverrides : durationOverrides;
  const saved = store[key];
  store[key] = '';
  try {
    return calcTimes(speeches)[key];
  } finally {
    store[key] = saved;
  }
}

function refreshAutoHints() {
  Object.keys(timeOverrides).forEach((key) => {
    const el = document.getElementById(`auto_${key}`);
    if (el) el.textContent = `自動: ${autoValueFor(key)}`;
    const input = document.getElementById(`to_${key}`);
    if (input) input.classList.toggle('is-overridden', !!timeOverrides[key].trim());
  });

  Object.keys(durationOverrides).forEach((key) => {
    const el = document.getElementById(`auto_${key}`);
    if (el) el.textContent = `自動: ${autoValueFor(key)} 分鐘`;
    const input = document.getElementById(`to_${key}`);
    if (input) input.classList.toggle('is-overridden', String(durationOverrides[key]).trim() !== '');
  });
}

// Push the current `durationLabels` into their inputs (durlbl_<key>).
function syncDurationLabelInputs() {
  Object.entries(durationLabels).forEach(([key, v]) => {
    const el = document.getElementById(`durlbl_${key}`);
    if (el) el.value = v || '';
  });
}

// Push the current `signals` values into the signal-grid inputs (sig_<cat>_<key>).
function syncSignalInputs() {
  Object.entries(signals).forEach(([cat, v]) => {
    if (typeof v === 'string') {
      const el = document.getElementById(`sig_${cat}`);
      if (el) el.value = v;
    } else {
      ['g', 'y', 'r'].forEach((k) => {
        const el = document.getElementById(`sig_${cat}_${k}`);
        if (el) el.value = v[k] || '';
      });
    }
  });
}

// ================================================================
// HELPERS
// ================================================================
function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${y}.${m}.${d}`;
}

function esc(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildSpeechAgendaLine(sp) {
  let line = esc(sp.title) || 'TBD';
  const parts = [];
  if (sp.pathwayCode) parts.push(sp.pathwayCode);
  if (sp.pathwayLevel) parts.push(sp.pathwayLevel);
  if (sp.pathwayProject) parts.push(projectName(sp.pathwayProject, lang));
  if (parts.length) line += `\n [${parts.join(' - ')}]`;
  return line;
}

// ================================================================
// PREVIEW
// ================================================================
function collectData() {
  return {
    meetingDate: val('meetingDate'),
    meetingNo: val('meetingNo'),
    meetingTheme: val('meetingTheme'),
    timeRange: val('timeRange'),
    venueInfo: val('venueInfo'),
    receptionHost: val('receptionHost'),
    callingToOrder: val('callingToOrder'),
    welcomeTME: val('welcomeTME'),
    tme: val('tme'),
    timer: val('timer'),
    ahCounter: val('ahCounter'),
    speeches,
    evaluators: evaluators.slice(),
    evalEvaluators: evalEvaluators.slice(),
    tableTopicsMaster: val('tableTopicsMaster'),
    generalEvaluator: val('generalEvaluator'),
    langEvaluator: val('langEvaluator'),
    awardsPresenter: val('awardsPresenter'),
    sharingFeedback: val('sharingFeedback'),
    // template-specific extra roles / fields (optional, cross-template safe)
    boardWriter: val('boardWriter'),
    photographer: val('photographer'),
    voteCounter: val('voteCounter'),
    wordOfTheDay: val('wordOfTheDay'),
    quizHost: val('quizHost'),
    tableTopicsQuestion: val('tableTopicsQuestion'),
    signals,
    // CHINA template only — page-2 reference content (ignored by other
    // templates' render()s). `nextMeetingDate`/`assigneeNext` are gone: the
    // "Next Meeting" column is now resolved live (ensureNextMeetingRoles).
    prevMeeting: {
      label: 'The Fresh Start Before',
      date: val('pm_date'),
      attendMembers: val('pm_attendMembers'),
      attendGuests: val('pm_attendGuests'),
      bestSpeaker: val('pm_bestSpeaker'),
      bestEvaluator: val('pm_bestEvaluator'),
      bestTopicsSpeaker: val('pm_bestTopicsSpeaker'),
      bestSessionMaster: val('pm_bestSessionMaster'),
    },
    speechProjects: Array.from({ length: CHINA_PROJECT_COUNT }, (_, i) => ({
      speaker: val(`proj_${i}_speaker`),
      projectCode: val(`proj_${i}_code`),
      purpose: val(`proj_${i}_purpose`),
      evaluatorNote: val(`proj_${i}_eval`),
      spotlight: !!document.getElementById(`proj_${i}_spotlight`)?.checked,
    })),
    nextSpeakers: Array.from({ length: CHINA_PROJECT_COUNT }, (_, i) => val(`nextSpeaker_${i}`)),
  };
}

function equalizeRowHeights() {
  const table = document.querySelector('#agendaPreview .agenda-table, #agendaPreview .ch-table');
  if (!table) return;
  const rows = [...table.querySelectorAll('tbody tr')];
  if (!rows.length) return;

  // Fill only the body area: total table height minus the header, which does
  // not stretch. (Including the header here over-grows rows and overflows A4.)
  const headH = table.tHead ? table.tHead.offsetHeight : 0;
  const bodyH = rows.reduce((sum, tr) => sum + tr.offsetHeight, 0);
  const extra = table.offsetHeight - headH - bodyH;
  if (extra <= 0) return;

  const addPerRow = extra / rows.length;
  rows.forEach((tr) => { tr.style.height = (tr.offsetHeight + addPerRow) + 'px'; });
}

const MM_TO_PX = 96 / 25.4;
const PAGE_W_PX = 194 * MM_TO_PX;
const PAGE_H_PX = 277 * MM_TO_PX;

function applyPreviewScale() {
  const scroll = document.querySelector('.preview-scroll');
  const pages = document.getElementById('agendaPages');
  if (!scroll || !pages) return;
  const scale = Math.min(1, (scroll.clientWidth - 20) / PAGE_W_PX);
  pages.style.transformOrigin = 'top center';
  pages.style.transform = scale < 1 ? `scale(${scale})` : '';
  // compensate the visual gap a sub-1 scale leaves below the (possibly multi-page) block
  const h = pages.offsetHeight;
  pages.style.marginBottom = scale < 1 ? `${h * (scale - 1)}px` : '';
}

function updatePreview() {
  const data = collectData();
  const preview = document.getElementById('agendaPreview');
  const pagesWrap = document.getElementById('agendaPages');
  if (!preview || !pagesWrap) return;
  const club = getActiveClub();
  applyClubImages(club);
  const tmpl = AGENDA_TEMPLATES[club && club.template_key] || AGENDA_TEMPLATES.compact;
  applyTemplateFields(tmpl.key);
  ensureNextMeetingRoles(tmpl.key === 'china' ? club : null, data.meetingDate);

  // Language capability is declared per template (lib/agendaTemplates.js). A
  // template that is inherently bilingual (langToggle:false, e.g. Chill Hi
  // High) hides the 語言 toggle and pins the render language; bilingualNames
  // shows En + 中 names.
  const supportsLangToggle = tmpl.langToggle !== false;
  const langItem = document.getElementById('langMenuItem');
  if (langItem) langItem.style.display = supportsLangToggle ? '' : 'none';
  if (!supportsLangToggle) {
    lang = tmpl.fixedLang || 'zh';
    const lt = document.getElementById('langToggle');
    if (lt) lt.textContent = lang === 'en' ? '切換中文' : 'Switch to EN';
  }
  bilingualNames = !!tmpl.bilingualNames;

  const out = tmpl.render(data, club, buildRenderCtx());
  const pages = Array.isArray(out) ? out : [out];
  const langCls = lang === 'zh' ? 'lang-zh' : 'lang-en';

  // Page 1 stays in #agendaPreview; reset class each render so nothing stacks.
  preview.innerHTML = pages[0];
  preview.className = `agenda-page tmpl-${tmpl.key} ${langCls}`;

  // Rebuild any extra pages as siblings inside #agendaPages.
  pagesWrap.querySelectorAll('.extra-page').forEach((el) => el.remove());
  pages.slice(1).forEach((html) => {
    const div = document.createElement('div');
    div.className = `agenda-page extra-page tmpl-${tmpl.key} ${langCls}`;
    div.innerHTML = html;
    pagesWrap.appendChild(div);
  });

  requestAnimationFrame(() => { equalizeRowHeights(); applyPreviewScale(); });
  refreshAutoHints();
  setSaveStatus('unsaved');
}

// Resolve the active club (branding + template) for rendering.
//  - system_admin: the club chosen in the agenda picker (selectedClubId)
//  - everyone else: their own club from auth
// Returns null when none resolved → templates fall back to built-in defaults.
function getActiveClub() {
  const cid = isSystemAdmin() ? selectedClubId : getClubId();
  if (cid == null) return null;
  return (allClubs || []).find((c) => c.id === cid) || null;
}

// Point the shared `images` logo/QR slots at the active club's R2 assets,
// falling back to the bundled defaults when a club hasn't uploaded its own.
function applyClubImages(club) {
  images.logo = (club && club.logo_url) || DEFAULT_IMAGES.logo;
  images.fbQr = (club && club.fb_qr_url) || DEFAULT_IMAGES.fbQr;
  images.lineQr = (club && club.line_qr_url) || DEFAULT_IMAGES.lineQr;
}

function isoDatePlusOne(iso) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * CHINA only — keeps `nextRolesCache` pointed at the role fields of the next
 * chronological meeting for the same club, so the printed "Next Meeting"
 * column is always live instead of a manually-typed/duplicated field. Only
 * re-fetches when the club+date actually changes (updatePreview() runs on
 * every keystroke, so this must not fire on every one of them); the current,
 * possibly-stale cache is used synchronously and a fresh render is triggered
 * once the fetch resolves.
 */
function ensureNextMeetingRoles(club, meetingDate) {
  if (!club || !meetingDate) {
    nextRolesCacheKey = null;
    nextRolesCache = {};
    return;
  }
  const key = `${club.id}|${meetingDate}`;
  if (key === nextRolesCacheKey) return;
  nextRolesCacheKey = key;

  const params = new URLSearchParams({
    date_from: isoDatePlusOne(meetingDate), order: 'date_asc', limit: '1', full: '1',
  });
  if (isSystemAdmin() && selectedClubId != null) params.set('club_id', selectedClubId);

  apiJson(`/agendas?${params}`)
    .then((json) => {
      const item = (json.items || [])[0];
      nextRolesCache = item ? { ...item.data, meetingDate: item.meetingDate } : {};
    })
    .catch(() => { nextRolesCache = {}; })
    .finally(() => {
      if (nextRolesCacheKey === key) updatePreview(); // still the relevant lookup → re-render with it
    });
}

// Bundle the helpers/globals templates need, so lib/agendaTemplates.js stays decoupled.
function buildRenderCtx() {
  return {
    t, esc, calcTimes, displayMember, buildSpeechAgendaLine,
    formatDate, varietySession, signals, durationLabels,
    PATHWAYS: pathwayPairs('en'), PATHWAYS_ZH: pathwayPairs('zh'), pathwayList: pathwayList(), images, lang, nextMeetingRoles: nextRolesCache,
  };
}

// Show/hide template-specific form blocks (marked data-tmpl="<key>") so each
// club only sees the inputs its active template uses.
// Shared inputs whose grayed-out example text should match the active
// template's own wording/schedule, not whichever club's fixture ships first.
function applyTemplatePlaceholders(templateKey) {
  const ph = templatePlaceholders(templateKey);
  ['meetingTheme', 'timeRange', 'tableTopicsQuestion'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && ph[id]) el.placeholder = ph[id];
  });
}

function applyTemplateFields(templateKey) {
  applyTmplVisibility(document, templateKey);
  applyTemplatePlaceholders(templateKey);
}

// ================================================================
// SAVE / LOAD
// ================================================================
let currentAgendaId = null;
let selectedClubId = null; // system_admin: which club this agenda belongs to
let allClubs = [];
let pendingClubSwitch = null; // { newClubId } awaiting confirmation in clubTemplateSwitchModal

function collectSaveData() {
  return {
    ...collectData(),
    timeOverrides: { ...timeOverrides },
    durationOverrides: { ...durationOverrides },
    durationSettings: { ...durationSettings },
    durationLabels: { ...durationLabels },
    lang,
    themeImgUrl: images.themeImg || null,
    varietySession: { ...varietySession },
  };
}

function applyAgendaData(d) {
  const fields = [
    'meetingDate', 'meetingNo', 'meetingTheme',
    'timeRange', 'venueInfo',
    'receptionHost', 'callingToOrder', 'welcomeTME', 'tme', 'timer', 'ahCounter',
    'tableTopicsMaster', 'generalEvaluator', 'langEvaluator',
    'awardsPresenter', 'sharingFeedback',
    'boardWriter', 'photographer', 'tableTopicsQuestion',
    'voteCounter', 'wordOfTheDay', 'quizHost',
  ];
  fields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = d[id] || '';
  });

  speeches = d.speeches || [];
  evaluators = d.evaluators || [];
  // Absent on every agenda saved before this field existed → none, not "keep
  // the previous agenda's". Capped defensively, same as the templates do.
  evalEvaluators = (d.evalEvaluators || []).slice(0, MAX_EVAL_EVALUATORS);

  // Clear first — this state outlives a single load, so keys the saved agenda
  // omits must fall back to auto rather than keep the previous agenda's value.
  Object.keys(timeOverrides).forEach((k) => { timeOverrides[k] = ''; });
  Object.keys(durationOverrides).forEach((k) => { durationOverrides[k] = ''; });

  if (d.timeOverrides) {
    const src = d.timeOverrides;
    // Legacy shape: `openingStart` once meant what is now `receptionStart`, and
    // `intermissionMins` used to live in here. Detect it by a missing
    // `receptionStart` — every save since that rename includes the key. Without
    // this check the old value would be misread as the new openingStart pin.
    if (src.receptionStart === undefined) {
      timeOverrides.receptionStart = src.openingStart || '';
    } else {
      Object.keys(timeOverrides).forEach((k) => { timeOverrides[k] = src[k] || ''; });
    }
    timeOverrides.endTime = src.endTime || '';
    if (src.intermissionMins !== undefined && String(src.intermissionMins).trim() !== '') {
      durationOverrides.intermissionMins = String(src.intermissionMins);
    }
  }

  if (d.durationOverrides) {
    Object.keys(durationOverrides).forEach((k) => {
      if (d.durationOverrides[k] !== undefined) durationOverrides[k] = d.durationOverrides[k];
    });
  }

  [timeOverrides, durationOverrides].forEach((store) => {
    Object.entries(store).forEach(([key, v]) => {
      const el = document.getElementById(`to_${key}`);
      if (el) el.value = v || '';
    });
  });

  if (d.durationSettings) {
    durationSettings.tmeMins = d.durationSettings.tmeMins ?? 4;
    durationSettings.geMins = d.durationSettings.geMins ?? 4;
    const tmeEl = document.getElementById('dur_tmeMins');
    if (tmeEl) tmeEl.value = durationSettings.tmeMins;
    const geEl = document.getElementById('dur_geMins');
    if (geEl) geEl.value = durationSettings.geMins;
  }

  if (d.lang === 'zh' || d.lang === 'en') {
    lang = d.lang;
    const btn = document.getElementById('langToggle');
    if (btn) btn.textContent = lang === 'en' ? '切換中文' : 'Switch to EN';
  }

  if (d.varietySession) {
    varietySession.enabled = !!d.varietySession.enabled;
    varietySession.duration = d.varietySession.duration || 15;
    varietySession.host = d.varietySession.host || '';
    const cb = document.getElementById('varietyEnabled');
    if (cb) cb.checked = varietySession.enabled;
    toggleVariety(varietySession.enabled);
    const hostEl = document.getElementById('varietyHost');
    if (hostEl) hostEl.value = varietySession.host;
    const durEl = document.getElementById('varietyDuration');
    if (durEl) durEl.value = varietySession.duration;
  }

  // Restore time-signal cards (merge over defaults so older agendas stay valid),
  // then push values into the signal-grid inputs.
  signals = { ...defaultSignals(), ...(d.signals || {}) };
  syncSignalInputs();

  // Same for the fixed evaluation-row duration labels.
  durationLabels = { ...defaultDurationLabels(), ...(d.durationLabels || {}) };
  syncDurationLabelInputs();

  images.themeImg = d.themeImgUrl || null;
  const statusEl = document.getElementById('themeImgStatus');
  if (statusEl) {
    if (images.themeImg) {
      const filename = images.themeImg.split('/').pop();
      statusEl.textContent = `✓ 雲端圖片：${filename}`;
    } else {
      statusEl.textContent = '';
    }
  }
  const fileInput = document.getElementById('img_themeImg');
  if (fileInput) fileInput.value = '';

  applyChinaFields(d);
  renderSpeechForms();
  renderEvaluatorForms();
  renderEvalEvaluatorForms();
  updatePreview();
}

async function saveAgenda() {
  // system_admin must pick a club before saving
  if (isSystemAdmin() && !selectedClubId) {
    alert('請先在上方選擇此議程所屬的分會，再儲存。');
    return;
  }
  const btn = document.getElementById('btnSave');
  btn.disabled = true;
  btn.textContent = '儲存中...';
  try {
    const payload = { data: collectSaveData(), club_id: selectedClubId };
    if (currentAgendaId) {
      await apiJson(`/agendas/${currentAgendaId}`, { method: 'PUT', body: payload });
    } else {
      const json = await apiJson('/agendas', { method: 'POST', body: payload });
      currentAgendaId = json.id;
    }
    setSaveStatus('saved');
    btn.textContent = '✓ 已儲存';
    setTimeout(() => { btn.textContent = '儲存'; }, 2000);
  } catch (e) {
    alert(e.message);
    btn.textContent = '儲存';
  } finally {
    btn.disabled = false;
  }
}

// ================================================================
// LOAD MODAL CALENDAR
// ================================================================
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let calSelected = '';
let calDates = new Set();

async function fetchCalDates() {
  try {
    const { items } = await apiJson('/agendas?limit=500');
    calDates = new Set(items.map((i) => i.meetingDate).filter((d) => d && d.includes('-')));
    renderCalendar();
  } catch { /* ignore */ }
}

function renderCalendar() {
  const label = document.getElementById('calMonthLabel');
  const grid = document.getElementById('calendarGrid');
  if (!label || !grid) return;

  label.textContent = `${calYear} 年 ${calMonth + 1} 月`;

  const today = new Date().toISOString().slice(0, 10);
  const firstDow = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  let html = '';
  for (let i = 0; i < firstDow; i++) html += '<div class="cal-day cal-empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dot = calDates.has(ds) ? '<span class="cal-dot"></span>' : '';
    let cls = 'cal-day';
    if (ds === calSelected) cls += ' cal-sel';
    else if (ds === today) cls += ' cal-today';
    html += `<div class="${cls}" onclick="window.__idxCalSelectDate('${ds}')"><span>${d}</span>${dot}</div>`;
  }
  grid.innerHTML = html;
}

function calPrevMonth() {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  calSelected = '';
  renderCalendar();
  fetchAgendaListByMonth(calYear, calMonth);
}

function calNextMonth() {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  calSelected = '';
  renderCalendar();
  fetchAgendaListByMonth(calYear, calMonth);
}

function calSelectDate(dateStr) {
  calSelected = dateStr;
  renderCalendar();
  fetchAgendaList(dateStr);
}

function calClearFilter() {
  calSelected = '';
  renderCalendar();
  fetchAgendaListByMonth(calYear, calMonth);
}

function renderAgendaListItems(items) {
  return items.map((item) => {
    const label = [
      item.meetingDate || '—',
      item.meetingNo ? `No.${item.meetingNo}` : '',
      item.meetingTheme || '',
    ].filter(Boolean).join('  ·  ');
    const ts = item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-TW') : '';
    return `
      <div class="agenda-list-item" onclick="window.__idxLoadAgenda(${item.id})">
        <div class="ali-main">${label}</div>
        <div class="ali-meta">${ts}</div>
        <button class="ali-del" onclick="event.stopPropagation(); window.__idxDeleteAgenda(${item.id}, this)" title="刪除"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
      </div>`;
  }).join('');
}

async function fetchAgendaListByMonth(year, month) {
  const list = document.getElementById('agendaListBody');
  list.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  try {
    const { items } = await apiJson('/agendas?limit=500');
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    const filtered = items.filter((i) => (i.meetingDate || '').startsWith(prefix));
    if (!filtered.length) {
      list.innerHTML = '<p class="agenda-list-empty">本月尚無議程</p>';
      return;
    }
    list.innerHTML = renderAgendaListItems(filtered);
  } catch (e) {
    list.innerHTML = `<p class="agenda-list-empty">${e.message}</p>`;
  }
}

async function openLoadModal() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  calSelected = '';
  document.getElementById('loadModal').style.display = 'flex';
  renderCalendar();
  fetchCalDates();
  await fetchAgendaListByMonth(calYear, calMonth);
}

async function fetchAgendaList(date) {
  const list = document.getElementById('agendaListBody');
  list.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  try {
    const path = date ? `/agendas?date=${date}&limit=100` : '/agendas?limit=100';
    const { items } = await apiJson(path);
    if (!items.length) {
      list.innerHTML = '<p class="agenda-list-empty">找不到符合的議程</p>';
      return;
    }
    list.innerHTML = renderAgendaListItems(items);
  } catch (e) {
    list.innerHTML = `<p class="agenda-list-empty">${e.message}</p>`;
  }
}

function closeLoadModal() {
  document.getElementById('loadModal').style.display = 'none';
}

function showLoading() {
  const el = document.getElementById('loadingOverlay');
  if (el) el.classList.remove('hidden');
}

function hideLoading() {
  const el = document.getElementById('loadingOverlay');
  if (el) el.classList.add('hidden');
}

async function loadAgenda(id, { ownLoading = true } = {}) {
  if (ownLoading) showLoading();
  try {
    const data = await apiJson(`/agendas/${id}`);

    if (isSystemAdmin()) {
      const clubId = data._clubId ?? null;
      const clubChanged = clubId !== selectedClubId;
      selectedClubId = clubId;
      const sel = document.getElementById('agendaClubSelect');
      if (sel) sel.value = clubId ?? '';
      _updateClubPickerHint();
      if (clubChanged) {
        memberRoster = [];
        fetchMemberDatalist();
      }
    }

    applyAgendaData(data);
    currentAgendaId = id;
    setSaveStatus('saved');
    closeLoadModal();
  } catch (e) {
    alert(e.message);
  } finally {
    if (ownLoading) hideLoading();
  }
}

async function deleteAgenda(id, btn) {
  if (!confirm('確定要刪除這份議程嗎？')) return;
  try {
    await apiJson(`/agendas/${id}`, { method: 'DELETE' });
    if (currentAgendaId === id) { currentAgendaId = null; setSaveStatus('unsaved'); }
    btn.closest('.agenda-list-item').remove();
  } catch (e) {
    alert(e.message || '刪除失敗');
  }
}

function setSaveStatus(state) {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  if (state === 'saved') {
    el.textContent = '● 已儲存';
    el.className = 'save-status saved';
  } else {
    el.textContent = '○ 未儲存';
    el.className = 'save-status unsaved';
  }
}

// ================================================================
// PDF / JPG DOWNLOAD
// ================================================================
async function getThemeImgBase64() {
  if (images.themeImgBase64) return images.themeImgBase64;
  if (!images.themeImg) return null;
  const res = await apiFetch(`/image-proxy?url=${encodeURIComponent(images.themeImg)}`);
  if (!res.ok) return null;
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function getThemeImgCovered(containerEl) {
  const b64 = await getThemeImgBase64();
  if (!b64) return null;

  const img = new Image();
  await new Promise((r) => { img.onload = r; img.src = b64; });

  const w = containerEl.offsetWidth;
  const h = containerEl.offsetHeight;
  if (!w || !h) return b64;

  const canvas = document.createElement('canvas');
  canvas.width = w * 2;
  canvas.height = h * 2;
  const ctx = canvas.getContext('2d');

  const imgRatio = img.naturalWidth / img.naturalHeight;
  const boxRatio = w / h;
  let sx, sy, sw, sh;
  if (imgRatio > boxRatio) {
    sh = img.naturalHeight;
    sw = sh * boxRatio;
    sx = (img.naturalWidth - sw) / 2;
    sy = 0;
  } else {
    sw = img.naturalWidth;
    sh = sw / boxRatio;
    sx = 0;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.95);
}

async function swapThemeImgForCapture(element) {
  const themeImgEl = element.querySelector('.hg-theme-img');
  const hgImgEl = element.querySelector('.hg-img');
  if (!themeImgEl || !hgImgEl) return () => {};

  try {
    const covered = await getThemeImgCovered(hgImgEl);
    if (!covered) return () => {};
    const savedSrc = themeImgEl.src;
    const savedObjectFit = themeImgEl.style.objectFit;
    themeImgEl.src = covered;
    themeImgEl.style.objectFit = 'fill';
    await new Promise((r) => { themeImgEl.onload = r; themeImgEl.onerror = r; });
    return () => {
      themeImgEl.src = savedSrc;
      themeImgEl.style.objectFit = savedObjectFit;
    };
  } catch (e) {
    console.warn('主題圖片處理失敗，略過:', e);
    return () => {};
  }
}

// Fetch any URL through the backend R2 proxy and return a base64 data URL.
async function fetchProxiedBase64(url) {
  const res = await apiFetch(`/image-proxy?url=${encodeURIComponent(url)}`);
  if (!res.ok) return null;
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Swap cross-origin imgs (e.g. club logo / QR on R2) to base64 so html2canvas
// doesn't taint the canvas. Theme image is handled separately (cover-crop).
// Returns a restore function.
async function swapCrossOriginImagesForCapture(element) {
  const imgs = [...element.querySelectorAll('img')].filter((img) => {
    if (img.src.startsWith('data:') || img.classList.contains('hg-theme-img')) return false;
    try { return new URL(img.src, location.href).origin !== location.origin; }
    catch { return false; }
  });
  const restores = [];
  for (const img of imgs) {
    try {
      const b64 = await fetchProxiedBase64(img.src);
      if (!b64) continue;
      const savedSrc = img.src;
      img.src = b64;
      await new Promise((r) => { img.onload = r; img.onerror = r; });
      restores.push(() => { img.src = savedSrc; });
    } catch { /* leave as-is */ }
  }
  return () => restores.forEach((fn) => fn());
}

async function downloadPDF() {
  const data = collectData();
  const dateStr = formatDate(data.meetingDate) || 'agenda';
  const element = document.getElementById('agendaPages');

  const savedTransform = element.style.transform;
  const savedMarginBottom = element.style.marginBottom;
  const savedTransformOrigin = element.style.transformOrigin;
  const savedGap = element.style.gap;
  element.style.transform = '';
  element.style.marginBottom = '';
  element.style.transformOrigin = '';
  // The live preview's inter-page gap (for on-screen page separation) has no
  // print equivalent — left in place, it pushes each page's captured height
  // past jsPDF's per-page budget and 'legacy' auto-slicing then inserts a
  // spurious near-blank page for the overflow. Zero it and rely solely on the
  // explicit `.extra-page` break for one clean page per `.agenda-page`.
  element.style.gap = '0px';

  const restoreTheme = await swapThemeImgForCapture(element);
  const restoreImgs = await swapCrossOriginImagesForCapture(element);

  const opt = {
    margin: [8, 8, 8, 8],
    filename: `Agenda_${dateStr}_No${data.meetingNo || ''}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, logging: false, scrollX: 0, scrollY: 0 },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    pagebreak: { mode: ['css'], before: '.extra-page' },
  };

  window.html2pdf().set(opt).from(element).save().then(() => {
    element.style.transform = savedTransform;
    element.style.marginBottom = savedMarginBottom;
    element.style.transformOrigin = savedTransformOrigin;
    element.style.gap = savedGap;
    restoreTheme();
    restoreImgs();
  });
}

async function downloadJPG() {
  const data = collectData();
  const dateStr = formatDate(data.meetingDate) || 'agenda';
  const element = document.getElementById('agendaPages');
  // One image per physical page (agendaPreview + any .extra-page siblings) —
  // a multi-page template like chillhihigh/china should download as separate
  // page-1/page-2 JPGs, not one tall image spanning both.
  const pageEls = [...element.querySelectorAll('.agenda-page')];

  const savedTransform = element.style.transform;
  const savedMarginBottom = element.style.marginBottom;
  const savedTransformOrigin = element.style.transformOrigin;
  element.style.transform = '';
  element.style.marginBottom = '';
  element.style.transformOrigin = '';

  const restoreTheme = await swapThemeImgForCapture(element);
  const restoreImgs = await swapCrossOriginImagesForCapture(element);

  for (let i = 0; i < pageEls.length; i++) {
    const canvas = await window.html2canvas(pageEls[i], {
      scale: 2,
      useCORS: true,
      logging: false,
      scrollX: 0,
      scrollY: 0,
    });
    const suffix = pageEls.length > 1 ? `_p${i + 1}` : '';
    const link = document.createElement('a');
    link.download = `Agenda_${dateStr}_No${data.meetingNo || ''}${suffix}.jpg`;
    link.href = canvas.toDataURL('image/jpeg', 0.95);
    link.click();
  }

  element.style.transform = savedTransform;
  element.style.marginBottom = savedMarginBottom;
  element.style.transformOrigin = savedTransformOrigin;
  restoreTheme();
  restoreImgs();
}

// ================================================================
// RESET & INIT
// ================================================================
function applyDefaultState() {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fields = [
    'meetingNo', 'meetingTheme',
    'receptionHost', 'callingToOrder', 'welcomeTME', 'tme', 'timer', 'ahCounter',
    'tableTopicsMaster', 'generalEvaluator', 'langEvaluator',
    'awardsPresenter', 'sharingFeedback',
    'boardWriter', 'photographer', 'tableTopicsQuestion',
    'voteCounter', 'wordOfTheDay', 'quizHost',
  ];
  fields.forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  signals = defaultSignals();
  syncSignalInputs();
  durationLabels = defaultDurationLabels();
  syncDurationLabelInputs();
  document.getElementById('meetingDate').value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  // Time/venue defaults: club's own setting → its template's fieldDefaults →
  // the compact template's fieldDefaults (last-resort, neutral — never another
  // club's real info). All defaults live in lib/agendaTemplates.js, so nothing
  // is hard-coded here.
  const _club = getActiveClub();
  const _set = (_club && _club.settings) || {};
  const _fd = templateFieldDefaults(_club ? _club.template_key : 'compact');
  const _std = templateFieldDefaults('compact');
  document.getElementById('timeRange').value = _set.timeRange || _fd.timeRange || _std.timeRange || '';
  document.getElementById('venueInfo').value = _set.venue || _fd.venue || _std.venue || '';
  speeches = [
    { title: 'TBD', speaker: '', duration: "5'-7'", speechLang: 'en', pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
    { title: '', speaker: '', duration: "5'-7'", speechLang: 'en', pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
    { title: '', speaker: '', duration: "5'-7'", speechLang: 'en', pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
  ];
  evaluators = ['', '', ''];
  evalEvaluators = [];
  Object.keys(timeOverrides).forEach((k) => {
    timeOverrides[k] = '';
    const el = document.getElementById(`to_${k}`);
    if (el) el.value = '';
  });
  Object.keys(durationOverrides).forEach((k) => {
    durationOverrides[k] = '';
    const el = document.getElementById(`to_${k}`);
    if (el) el.value = '';
  });
  Object.keys(images).forEach((k) => { if (k !== 'logo' && k !== 'fbQr' && k !== 'lineQr') images[k] = null; });
  const themeStatusEl = document.getElementById('themeImgStatus');
  if (themeStatusEl) themeStatusEl.textContent = '';
  const themeFileInput = document.getElementById('img_themeImg');
  if (themeFileInput) themeFileInput.value = '';
  applyChinaFields({});
  renderSpeechForms();
  renderEvaluatorForms();
  renderEvalEvaluatorForms();
  updatePreview();
}

async function resetForm() {
  if (currentAgendaId) {
    if (!confirm('確定要還原成上次儲存的狀態嗎？')) return;
    await loadAgenda(currentAgendaId);
  } else {
    if (!confirm('確定要還原成新建議程的預設狀態嗎？')) return;
    applyDefaultState();
  }
}

let memberRoster = [];

async function fetchMemberDatalist() {
  try {
    const params = new URLSearchParams();
    if (isSystemAdmin()) {
      if (!selectedClubId) return;
      params.set('club_id', selectedClubId);
    }
    const qs = params.toString();
    memberRoster = await apiJson(`/users${qs ? '?' + qs : ''}`);
  } catch { /* silently ignore */ }
}

function displayMember(v) {
  if (!v) return v;
  const m = memberRoster.find((m) =>
    `${m.nameZh} ${m.nameEn}` === v ||
    (m.level ? `${m.nameZh}, ${m.level}` : m.nameZh) === v ||
    (m.level ? `${m.nameEn}, ${m.level}` : m.nameEn) === v
  );
  if (!m) return v;
  const name = bilingualNames
    ? [m.nameEn, m.nameZh].filter(Boolean).join(' ') // "English 中文"
    : (lang === 'zh' ? m.nameZh : m.nameEn);
  return m.level ? `${name}, ${m.level}` : name;
}

// ================================================================
// MEMBER AUTOCOMPLETE
// ================================================================
let acActiveInput = null;
let acHighlight = -1;

function acFilteredItems() {
  const q = (acActiveInput?.value || '').trim().toLowerCase();
  if (!q) return memberRoster;
  return memberRoster.filter((m) => {
    const displayZh = m.level ? `${m.nameZh}, ${m.level}` : m.nameZh;
    const displayEn = m.level ? `${m.nameEn}, ${m.level}` : m.nameEn;
    return m.nameZh.toLowerCase().includes(q) ||
           m.nameEn.toLowerCase().includes(q) ||
           (m.level || '').toLowerCase().includes(q) ||
           displayZh.toLowerCase().includes(q) ||
           displayEn.toLowerCase().includes(q);
  });
}

function acRender() {
  const dd = document.getElementById('memberDropdown');
  if (!dd || !acActiveInput) return;
  const items = acFilteredItems();
  if (!items.length) { dd.style.display = 'none'; return; }

  dd.innerHTML = items.map((m, i) => {
    const name = lang === 'zh' ? m.nameZh : m.nameEn;
    const active = i === acHighlight ? ' ac-active' : '';
    return `<div class="member-dd-item${active}" data-idx="${i}">
      <span class="mdi-name">${esc(name)}</span>
      ${m.level ? `<span class="mdi-level">${esc(m.level)}</span>` : ''}
    </div>`;
  }).join('');

  const rect = acActiveInput.getBoundingClientRect();
  dd.style.display = 'block';
  dd.style.left = rect.left + 'px';
  dd.style.minWidth = rect.width + 'px';

  const ddHeight = Math.min(dd.scrollHeight, 220);
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  if (spaceBelow >= ddHeight || spaceBelow >= spaceAbove) {
    dd.style.top = (rect.bottom + 4) + 'px';
    dd.style.bottom = 'auto';
  } else {
    dd.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    dd.style.top = 'auto';
  }

  if (acHighlight >= 0) {
    const el = dd.querySelectorAll('.member-dd-item')[acHighlight];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}

function acHide() {
  const dd = document.getElementById('memberDropdown');
  if (dd) dd.style.display = 'none';
  acActiveInput = null;
  acHighlight = -1;
}

function acSelectItem(m) {
  if (!acActiveInput) return;
  const display = lang === 'zh'
    ? (m.level ? `${m.nameZh}, ${m.level}` : m.nameZh)
    : (m.level ? `${m.nameEn}, ${m.level}` : m.nameEn);
  acActiveInput.value = display;
  acActiveInput.dispatchEvent(new Event('input', { bubbles: true }));
  acHide();
}

function initAutocomplete() {
  const onFocusIn = (e) => {
    if (!e.target.classList.contains('member-ac')) { acHide(); return; }
    e.target.setAttribute('autocomplete', 'off');
    acActiveInput = e.target;
    acHighlight = -1;
    acRender();
  };
  const onInput = (e) => {
    if (!e.target.classList.contains('member-ac')) return;
    acActiveInput = e.target;
    acHighlight = -1;
    acRender();
  };
  const onKeydown = (e) => {
    const dd = document.getElementById('memberDropdown');
    if (!dd || dd.style.display === 'none') return;
    const items = acFilteredItems();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acHighlight = Math.min(acHighlight + 1, items.length - 1);
      acRender();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      acHighlight = Math.max(acHighlight - 1, -1);
      acRender();
    } else if (e.key === 'Enter' && acHighlight >= 0) {
      e.preventDefault();
      acSelectItem(items[acHighlight]);
    } else if (e.key === 'Escape') {
      acHide();
    }
  };
  const onDropdownMousedown = (e) => {
    e.preventDefault();
    const item = e.target.closest('.member-dd-item');
    if (!item) return;
    const items = acFilteredItems();
    const m = items[parseInt(item.dataset.idx, 10)];
    if (m) acSelectItem(m);
  };
  const onFocusOut = (e) => {
    if (!e.target.classList.contains('member-ac')) return;
    setTimeout(() => {
      const dd = document.getElementById('memberDropdown');
      if (dd && !dd.contains(document.activeElement)) acHide();
    }, 100);
  };
  const onFormScroll = () => {
    if (!acActiveInput) return;
    const rect = acActiveInput.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      acHide();
    } else {
      acRender();
    }
  };

  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);
  document.getElementById('memberDropdown').addEventListener('mousedown', onDropdownMousedown);
  document.addEventListener('focusout', onFocusOut);

  document.querySelectorAll('.member-ac').forEach((el) => {
    el.setAttribute('autocomplete', 'off');
  });

  const formScrollBody = document.querySelector('.form-scroll-body');
  if (formScrollBody) formScrollBody.addEventListener('scroll', onFormScroll);

  return () => {
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('input', onInput);
    document.removeEventListener('keydown', onKeydown);
    document.getElementById('memberDropdown')?.removeEventListener('mousedown', onDropdownMousedown);
    document.removeEventListener('focusout', onFocusOut);
    if (formScrollBody) formScrollBody.removeEventListener('scroll', onFormScroll);
  };
}

// Load all clubs (branding + template) for every role — needed so the agenda
// renderer can resolve the active club. Only system_admin sees the picker UI.
async function loadAgendaClubs() {
  try {
    allClubs = await apiJson('/clubs');
    if (!isSystemAdmin()) return; // members/club_admins: data only, no picker
    const sel = document.getElementById('agendaClubSelect');
    if (!sel) return;
    allClubs.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    });
    document.getElementById('agendaClubPickerRow').style.display = '';
  } catch { /* ignore */ }
}

// Switching the club (system_admin only) switches which template the agenda
// renders with too — each club has its own template_key. Since templates can
// still have some non-overlapping fields (e.g. china's prevMeeting/speech
// project reference cards on page 2, which nothing else uses), warn via
// clubTemplateSwitchModal before swapping so already-typed template-specific
// content doesn't silently vanish from view.
function onAgendaClubChange(v) {
  const newClubId = v ? parseInt(v) : null;
  const oldClub = getActiveClub();
  const newClub = newClubId ? (allClubs || []).find((c) => c.id === newClubId) : null;
  const oldKey = oldClub ? (oldClub.template_key || 'compact') : null;
  const newKey = newClub ? (newClub.template_key || 'compact') : null;

  if (oldKey && newKey && oldKey !== newKey) {
    pendingClubSwitch = { newClubId };
    const oldLabel = (AGENDA_TEMPLATES[oldKey] || AGENDA_TEMPLATES.compact).label;
    const newLabel = (AGENDA_TEMPLATES[newKey] || AGENDA_TEMPLATES.compact).label;
    const body = document.getElementById('clubTemplateSwitchBody');
    if (body) {
      body.innerHTML = `
        <p>「${esc(newClub.name)}」使用不同的議程版型：</p>
        <p class="tmpl-switch-diff"><strong>${esc(oldLabel)}</strong> → <strong>${esc(newLabel)}</strong></p>
        <p>切換分會會一併切換議程版型，目前已填寫、僅原版型專屬的欄位內容可能會被隱藏或不適用。</p>
      `;
    }
    const modal = document.getElementById('clubTemplateSwitchModal');
    if (modal) modal.style.display = 'flex';
    return;
  }

  commitClubSwitch(newClubId);
}

function cancelClubTemplateSwitch() {
  pendingClubSwitch = null;
  const sel = document.getElementById('agendaClubSelect');
  if (sel) sel.value = selectedClubId ?? '';
  const modal = document.getElementById('clubTemplateSwitchModal');
  if (modal) modal.style.display = 'none';
}

function confirmClubTemplateSwitch() {
  const modal = document.getElementById('clubTemplateSwitchModal');
  if (modal) modal.style.display = 'none';
  if (!pendingClubSwitch) return;
  const { newClubId } = pendingClubSwitch;
  pendingClubSwitch = null;
  commitClubSwitch(newClubId);
}

function commitClubSwitch(newClubId) {
  selectedClubId = newClubId;
  _updateClubPickerHint();
  setSaveStatus('unsaved');
  memberRoster = [];
  fetchMemberDatalist();
  updatePreview();
}

function _updateClubPickerHint() {
  const hint = document.getElementById('agendaClubHint');
  if (!hint) return;
  if (!selectedClubId) {
    hint.textContent = '⚠ 請選擇分會，否則無法儲存';
    hint.style.color = '#b45309';
  } else {
    const club = allClubs.find((c) => c.id === selectedClubId);
    hint.textContent = club ? `此議程將歸屬於「${club.name}」` : '';
    hint.style.color = '#64748b';
  }
}

async function checkAuth() {
  try {
    const data = await apiJson('/auth/verify');
    setAuth(data.username, data.role, data.club_id, data.must_change_pw);
    if (data.must_change_pw) {
      window.location.href = '/change-password';
      return false;
    }
    document.querySelector('.app-layout').style.display = 'flex';
    const btn = document.getElementById('logoutBtn');
    if (btn) btn.textContent = `登出（${getUsername()}）`;
    return true;
  } catch {
    clearAuth();
    window.location.href = '/login';
    return false;
  }
}

function toggleActionsMenu() {
  document.querySelector('.form-actions').classList.toggle('actions-open');
}

function toggleSettingsMenu() {
  const dd = document.getElementById('settingsDropdown');
  const btn = dd.querySelector('.btn-settings');
  const panel = dd.querySelector('.settings-menu-panel');
  const isOpen = dd.classList.toggle('open');
  if (isOpen) {
    const rect = btn.getBoundingClientRect();
    const panelW = 160;
    const left = Math.max(8, rect.right - panelW);
    panel.style.top = (rect.bottom + 6) + 'px';
    panel.style.left = left + 'px';
    panel.style.right = '';
  }
}

function toggleFormPanel() {
  const panel = document.querySelector('.form-panel');
  const backdrop = document.getElementById('panelBackdrop');
  const isOpen = panel.classList.toggle('panel-open');
  if (backdrop) backdrop.classList.toggle('open', isOpen);
  setTimeout(applyPreviewScale, 380);
}

export default function AgendaIndexPage() {
  useEffect(() => {
    // Bridge functions referenced by onclick="..." strings inside
    // innerHTML-generated markup (speech/evaluator rows, calendar days,
    // agenda list items) — see renderSpeechForms/renderEvaluatorForms/
    // renderCalendar/renderAgendaListItems above.
    window.__idxRemoveSpeech = removeSpeech;
    window.__idxUpdateSpeech = updateSpeech;
    window.__idxSpeechPwSelect = setSpeechPwSelect;
    window.__idxSpeechPwCustom = setSpeechPwCustom;
    window.__idxRemoveEvaluator = removeEvaluator;
    window.__idxAddEvaluator = addEvaluator;
    window.__idxEvalInput = (i, value) => { evaluators[i] = value; updatePreview(); };
    window.__idxRemoveEvalEvaluator = removeEvalEvaluator;
    window.__idxAddEvalEvaluator = addEvalEvaluator;
    window.__idxEvalEvalInput = (i, value) => { evalEvaluators[i] = value; updatePreview(); };
    window.__idxCalSelectDate = calSelectDate;
    window.__idxLoadAgenda = loadAgenda;
    window.__idxDeleteAgenda = deleteAgenda;

    const settingsOutsideClick = (e) => {
      const dd = document.getElementById('settingsDropdown');
      if (dd && !dd.contains(e.target)) dd.classList.remove('open');
    };
    document.addEventListener('click', settingsOutsideClick);

    const cleanupAutocomplete = initAutocomplete();

    const formPanel = document.querySelector('.form-panel');
    formPanel?.addEventListener('input', updatePreview);
    formPanel?.addEventListener('change', updatePreview);

    (async function initPage() {
      showLoading();
      try {
        const ok = await checkAuth();
        if (!ok) return;
        applyRoleUI();
        // Clubs: needed by all roles to resolve club branding/template.
        // Pathways: the speech dropdowns' catalog — must be in before the
        // agenda below renders its speech forms.
        const [, pathwaysOk] = await Promise.all([loadAgendaClubs(), loadPathways()]);
        if (!pathwaysOk) alert('Pathways 目錄載入失敗，學習路徑選單暫時只能保留原值。');
        if (isSystemAdmin()) _updateClubPickerHint();
        fetchMemberDatalist();

        const params = new URLSearchParams(window.location.search);
        const urlId = params.get('id');
        if (urlId) {
          await loadAgenda(parseInt(urlId), { ownLoading: false });
        } else {
          // New agenda: if a club was chosen on /home (?club_id=…), preselect it
          // so getActiveClub() resolves that club's template/branding from the start.
          const urlClubId = params.get('club_id');
          if (isSystemAdmin() && urlClubId) {
            selectedClubId = parseInt(urlClubId);
            const sel = document.getElementById('agendaClubSelect');
            if (sel) sel.value = selectedClubId;
            _updateClubPickerHint();
            memberRoster = [];
            fetchMemberDatalist();
          }
          applyDefaultState();
        }

        updatePreview();
        window.addEventListener('resize', applyPreviewScale);
      } finally {
        hideLoading();
      }
    })();

    return () => {
      document.removeEventListener('click', settingsOutsideClick);
      cleanupAutocomplete();
      formPanel?.removeEventListener('input', updatePreview);
      formPanel?.removeEventListener('change', updatePreview);
      window.removeEventListener('resize', applyPreviewScale);
      delete window.__idxRemoveSpeech;
      delete window.__idxUpdateSpeech;
      delete window.__idxSpeechPwSelect;
      delete window.__idxSpeechPwCustom;
      delete window.__idxRemoveEvaluator;
      delete window.__idxAddEvaluator;
      delete window.__idxEvalInput;
      delete window.__idxRemoveEvalEvaluator;
      delete window.__idxAddEvalEvaluator;
      delete window.__idxEvalEvalInput;
      delete window.__idxCalSelectDate;
      delete window.__idxLoadAgenda;
      delete window.__idxDeleteAgenda;
    };
  }, []);

  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href="https://fonts.googleapis.com/css2?family=PT+Sans:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet" />
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js" strategy="afterInteractive" />
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js" strategy="afterInteractive" />

      <div className="app-layout" style={{ display: 'none' }}>
        <div id="panelBackdrop" className="panel-backdrop" onClick={toggleFormPanel}></div>

        <div className="form-panel">
          <div className="form-toggle-bar" onClick={toggleFormPanel}>
            <span>議程表單</span>
            <svg className="toggle-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div className="form-scroll-body">

            <div id="agendaClubPickerRow" style={{ display: 'none' }}>
              <div className="agenda-club-picker-label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                所屬分會 Club
              </div>
              <select id="agendaClubSelect" className="agenda-club-select" onChange={(e) => onAgendaClubChange(e.target.value)}>
                <option value="">— 請選擇分會 —</option>
              </select>
              <div id="agendaClubHint" className="agenda-club-hint"></div>
            </div>

            <div className="form-header">
              <h1>議程表產生器</h1>
            </div>

            <details open data-tmpl="standard entrepreneur" style={{ display: 'none' }}>
              <summary>主題圖片 Theme Image</summary>
              <div className="form-section">
                <div className="img-upload-row">
                  <label>主題圖片 (右上)</label>
                  <input type="file" id="img_themeImg" accept="image/*" onChange={(e) => uploadThemeImage(e.target)} />
                  <button className="img-clear-btn" onClick={clearThemeImage}>✕</button>
                </div>
                <p id="themeImgStatus" className="img-hint"></p>
              </div>
            </details>

            <details open>
              <summary>會議資訊</summary>
              <div className="form-section">
                <div className="form-row">
                  <label>會議日期</label>
                  <input type="date" id="meetingDate" />
                </div>
                <div className="form-row" data-tmpl="standard compact entrepreneur china" style={{ display: 'none' }}>
                  <label>會議編號 Meeting No.</label>
                  <input type="number" id="meetingNo" defaultValue={258} />
                </div>
                <div className="form-row">
                  <label>會議主題 Meeting Theme</label>
                  <input type="text" id="meetingTheme" placeholder="-Urban Legend-" />
                </div>
                <div className="form-row" data-tmpl="standard compact entrepreneur chillhihigh" style={{ display: 'none' }}>
                  <label>時間段 Time Range</label>
                  <input type="text" id="timeRange" placeholder="19:10 ~ 21:00" />
                </div>
                <div className="form-row">
                  <label>場地 Venue</label>
                  <textarea rows={3} id="venueInfo"></textarea>
                </div>
              </div>
            </details>

            <details data-tmpl="standard compact entrepreneur chillhihigh" style={{ display: 'none' }}>
              <summary>⏱ 時間設定 Time Settings</summary>
              <div className="form-section">
                <div className="time-override-row">
                  <div className="time-override-label">總主持人串場 TME hosting</div>
                  <input type="number" id="dur_tmeMins" min="0" max="30" defaultValue={4} style={{ width: 60 }}
                    onInput={(e) => updateDuration('tmeMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">總講評串場 GE hosting</div>
                  <input type="number" id="dur_geMins" min="0" max="30" defaultValue={4} style={{ width: 60 }}
                    onInput={(e) => updateDuration('geMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                </div>
                <hr style={{ margin: '6px 0', borderColor: '#ddd' }} />
                <p className="time-override-hint">空白 = 自動計算｜填入即覆蓋該欄</p>
                <div className="time-override-row">
                  <div className="time-override-label">
                    目標結束 End Time
                    <span id="auto_endTime" className="time-auto"></span>
                  </div>
                  <input type="text" id="to_endTime" maxLength={5} placeholder="21:00"
                    onInput={(e) => updateTimeOverride('endTime', e.target.value)} />
                  <button className="btn-time-reset" onClick={() => resetTimeOverride('endTime')} title="還原自動">⟳</button>
                </div>

                <hr style={{ margin: '6px 0', borderColor: '#ddd' }} />
                <p className="time-override-hint">
                  <strong>各段開始時刻</strong>（議程表時間欄）<br />
                  指定某段時刻後，後面各段會從該時刻往下推算。
                </p>
                <div className="time-override-row">
                  <div className="time-override-label">
                    報到 Reception
                    <span id="auto_receptionStart" className="time-auto"></span>
                  </div>
                  <input type="text" id="to_receptionStart" maxLength={5} placeholder="自動"
                    onInput={(e) => updateTimeOverride('receptionStart', e.target.value)} />
                  <button className="btn-time-reset" onClick={() => resetTimeOverride('receptionStart')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    開幕 Opening
                    <span id="auto_openingStart" className="time-auto"></span>
                  </div>
                  <input type="text" id="to_openingStart" maxLength={5} placeholder="自動"
                    onInput={(e) => updateTimeOverride('openingStart', e.target.value)} />
                  <button className="btn-time-reset" onClick={() => resetTimeOverride('openingStart')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    多元單元 Variety
                    <span id="auto_speechStart" className="time-auto"></span>
                  </div>
                  <input type="text" id="to_speechStart" maxLength={5} placeholder="自動"
                    onInput={(e) => updateTimeOverride('speechStart', e.target.value)} />
                  <button className="btn-time-reset" onClick={() => resetTimeOverride('speechStart')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    指定演講 Prepared Speech
                    <span id="auto_preparedSpeechStart" className="time-auto"></span>
                  </div>
                  <input type="text" id="to_preparedSpeechStart" maxLength={5} placeholder="自動"
                    onInput={(e) => updateTimeOverride('preparedSpeechStart', e.target.value)} />
                  <button className="btn-time-reset" onClick={() => resetTimeOverride('preparedSpeechStart')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    拍照 Group Photo
                    <span id="auto_photoStart" className="time-auto"></span>
                  </div>
                  <input type="text" id="to_photoStart" maxLength={5} placeholder="自動"
                    onInput={(e) => updateTimeOverride('photoStart', e.target.value)} />
                  <button className="btn-time-reset" onClick={() => resetTimeOverride('photoStart')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    即席問答 Table Topics
                    <span id="auto_topicsStart" className="time-auto"></span>
                  </div>
                  <input type="text" id="to_topicsStart" maxLength={5} placeholder="自動"
                    onInput={(e) => updateTimeOverride('topicsStart', e.target.value)} />
                  <button className="btn-time-reset" onClick={() => resetTimeOverride('topicsStart')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    講評 Evaluation
                    <span id="auto_evalStart" className="time-auto"></span>
                  </div>
                  <input type="text" id="to_evalStart" maxLength={5} placeholder="自動"
                    onInput={(e) => updateTimeOverride('evalStart', e.target.value)} />
                  <button className="btn-time-reset" onClick={() => resetTimeOverride('evalStart')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    結尾 Closing
                    <span id="auto_closingStart" className="time-auto"></span>
                  </div>
                  <input type="text" id="to_closingStart" maxLength={5} placeholder="自動"
                    onInput={(e) => updateTimeOverride('closingStart', e.target.value)} />
                  <button className="btn-time-reset" onClick={() => resetTimeOverride('closingStart')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    會後分享 Sharing
                    <span id="auto_sharingStart" className="time-auto"></span>
                  </div>
                  <input type="text" id="to_sharingStart" maxLength={5} placeholder="自動"
                    onInput={(e) => updateTimeOverride('sharingStart', e.target.value)} />
                  <button className="btn-time-reset" onClick={() => resetTimeOverride('sharingStart')} title="還原自動">⟳</button>
                </div>

                <hr style={{ margin: '6px 0', borderColor: '#ddd' }} />
                <p className="time-override-hint"><strong>各段時長</strong>（議程表時長欄）</p>
                <div className="time-override-row">
                  <div className="time-override-label">
                    報到 Reception
                    <span id="auto_receptionMins" className="time-auto"></span>
                  </div>
                  <input type="number" id="to_receptionMins" min="0" max="60" style={{ width: 60 }}
                    placeholder="自動" onInput={(e) => updateDurationOverride('receptionMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                  <button className="btn-time-reset" onClick={() => resetDurationOverride('receptionMins')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    開幕 Opening
                    <span id="auto_openingMins" className="time-auto"></span>
                  </div>
                  <input type="number" id="to_openingMins" min="0" max="60" style={{ width: 60 }}
                    placeholder="自動" onInput={(e) => updateDurationOverride('openingMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                  <button className="btn-time-reset" onClick={() => resetDurationOverride('openingMins')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    演講 Speeches
                    <span id="auto_speechMins" className="time-auto"></span>
                  </div>
                  <input type="number" id="to_speechMins" min="0" style={{ width: 60 }}
                    placeholder="自動" onInput={(e) => updateDurationOverride('speechMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                  <button className="btn-time-reset" onClick={() => resetDurationOverride('speechMins')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    拍照 Group Photo
                    <span id="auto_photoMins" className="time-auto"></span>
                  </div>
                  <input type="number" id="to_photoMins" min="0" max="30" style={{ width: 60 }}
                    placeholder="自動" onInput={(e) => updateDurationOverride('photoMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                  <button className="btn-time-reset" onClick={() => resetDurationOverride('photoMins')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    中場休息 Intermission
                    <span id="auto_intermissionMins" className="time-auto"></span>
                  </div>
                  <input type="number" id="to_intermissionMins" min="0" style={{ width: 60 }}
                    placeholder="自動" onInput={(e) => updateDurationOverride('intermissionMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                  <button className="btn-time-reset" onClick={() => resetDurationOverride('intermissionMins')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    即席演講 Table Topics
                    <span id="auto_topicsMins" className="time-auto"></span>
                  </div>
                  <input type="number" id="to_topicsMins" min="0" style={{ width: 60 }}
                    placeholder="自動" onInput={(e) => updateDurationOverride('topicsMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                  <button className="btn-time-reset" onClick={() => resetDurationOverride('topicsMins')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    講評 Evaluation
                    <span id="auto_evalMins" className="time-auto"></span>
                  </div>
                  <input type="number" id="to_evalMins" min="0" style={{ width: 60 }}
                    placeholder="自動" onInput={(e) => updateDurationOverride('evalMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                  <button className="btn-time-reset" onClick={() => resetDurationOverride('evalMins')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    結束 Closing
                    <span id="auto_closingMins" className="time-auto"></span>
                  </div>
                  <input type="number" id="to_closingMins" min="0" max="30" style={{ width: 60 }}
                    placeholder="自動" onInput={(e) => updateDurationOverride('closingMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                  <button className="btn-time-reset" onClick={() => resetDurationOverride('closingMins')} title="還原自動">⟳</button>
                </div>
                <div className="time-override-row">
                  <div className="time-override-label">
                    分享 Sharing
                    <span id="auto_sharingMins" className="time-auto"></span>
                  </div>
                  <input type="number" id="to_sharingMins" min="0" max="30" style={{ width: 60 }}
                    placeholder="自動" onInput={(e) => updateDurationOverride('sharingMins', e.target.value)} /> <span className="time-unit">分鐘</span>
                  <button className="btn-time-reset" onClick={() => resetDurationOverride('sharingMins')} title="還原自動">⟳</button>
                </div>

                <div data-tmpl="standard compact entrepreneur" style={{ display: 'none' }}>
                  <hr style={{ margin: '6px 0', borderColor: '#ddd' }} />
                  <p className="time-override-hint">
                    <strong>講評區各列時長</strong>（議程表上直接顯示的字樣，可填區間）
                  </p>
                  <div className="time-override-row">
                    <div className="time-override-label">個別講評 Evaluator</div>
                    <input type="text" id="durlbl_evaluator" style={{ width: 74 }} placeholder="2'~3'"
                      onInput={(e) => updateDurationLabel('evaluator', e.target.value)} />
                  </div>
                  <div className="time-override-row">
                    <div className="time-override-label">計時員報告 Timer Report</div>
                    <input type="text" id="durlbl_timerReport" style={{ width: 74 }} placeholder="1'"
                      onInput={(e) => updateDurationLabel('timerReport', e.target.value)} />
                  </div>
                  <div className="time-override-row">
                    <div className="time-override-label">贅語報告 Ah Report</div>
                    <input type="text" id="durlbl_ahReport" style={{ width: 74 }} placeholder="1'"
                      onInput={(e) => updateDurationLabel('ahReport', e.target.value)} />
                  </div>
                  <div className="time-override-row">
                    <div className="time-override-label">語言講評 Language Eval</div>
                    <input type="text" id="durlbl_langEval" style={{ width: 74 }} placeholder="3'~5'"
                      onInput={(e) => updateDurationLabel('langEval', e.target.value)} />
                  </div>
                  <div className="time-override-row">
                    <div className="time-override-label">總講評 General Eval</div>
                    <input type="text" id="durlbl_generalEval" style={{ width: 74 }} placeholder="3'~5'"
                      onInput={(e) => updateDurationLabel('generalEval', e.target.value)} />
                  </div>
                  <div className="time-override-row">
                    <div className="time-override-label">講評員講評 Eval&apos;s Eval</div>
                    <input type="text" id="durlbl_evalEvaluator" style={{ width: 74 }} placeholder="2'~3'"
                      onInput={(e) => updateDurationLabel('evalEvaluator', e.target.value)} />
                  </div>
                </div>
              </div>
            </details>

            <details open data-tmpl="standard compact entrepreneur chillhihigh china" style={{ display: 'none' }}>
              <summary>角色分配</summary>
              <div className="form-section">
                <div className="form-row">
                  <label>Reception Host <span className="time-hint">18:50</span></label>
                  <input type="text" id="receptionHost" placeholder="Name, Title" className="member-ac" />
                </div>
                <div className="form-row" data-tmpl="standard compact entrepreneur china" style={{ display: 'none' }}>
                  <label>Calling Meeting to Order <span className="time-hint">1'</span></label>
                  <input type="text" id="callingToOrder" placeholder="Name, Title" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>Welcome Guests &amp; TME 介紹者 <span className="time-hint">2'</span></label>
                  <input type="text" id="welcomeTME" placeholder="Name, Title" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>Toastmaster of the Evening (TME) <span className="time-hint">3'</span></label>
                  <input type="text" id="tme" placeholder="Name, Title" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>Timer 計時員 <span className="time-hint">2'</span></label>
                  <input type="text" id="timer" placeholder="Name, Title" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>Ah-counter 贅語統計員 <span className="time-hint">2'</span></label>
                  <input type="text" id="ahCounter" placeholder="Name, Title" className="member-ac" />
                </div>
              </div>
            </details>

            <details data-tmpl="standard compact entrepreneur chillhihigh" style={{ display: 'none' }}>
              <summary>多元單元 Variety Session</summary>
              <div className="form-section">
                <div className="form-row toggle-row">
                  <label className="toggle-label" htmlFor="varietyEnabled">啟用 Enable</label>
                  <label className="toggle-switch">
                    <input type="checkbox" id="varietyEnabled" onChange={(e) => toggleVariety(e.target.checked)} />
                    <span className="toggle-track"><span className="toggle-thumb"></span></span>
                  </label>
                </div>
                <div id="varietyFields" style={{ display: 'none' }}>
                  <div className="form-row">
                    <label>主持人 Host</label>
                    <input type="text" id="varietyHost" className="member-ac" placeholder="Name, Title"
                      onInput={(e) => updateVariety('host', e.target.value)} />
                  </div>
                  <div className="form-row">
                    <label>時長 Duration</label>
                    <input type="number" id="varietyDuration" min="1" max="60" defaultValue={15} style={{ width: 60 }}
                      onInput={(e) => updateVariety('duration', e.target.value)} /> 分鐘
                  </div>
                </div>
              </div>
            </details>

            <details open data-tmpl="standard compact entrepreneur chillhihigh china" style={{ display: 'none' }}>
              <summary>指定演講 Prepared Speeches</summary>
              <div className="form-section">
                <div id="speechesList"></div>
                <button className="btn-add" onClick={addSpeech}>+ 新增演講</button>
              </div>
            </details>

            <details open data-tmpl="standard compact entrepreneur chillhihigh china" style={{ display: 'none' }}>
              <summary>即席問答 Table Topics</summary>
              <div className="form-section">
                <div className="form-row">
                  <label>Table Topics Master <span className="time-hint">20'</span></label>
                  <input type="text" id="tableTopicsMaster" placeholder="Name, Title" className="member-ac" />
                </div>
              </div>
            </details>

            <details open data-tmpl="standard compact entrepreneur chillhihigh china" style={{ display: 'none' }}>
              <summary>講評環節 Evaluation</summary>
              <div className="form-section">
                <div className="form-row">
                  <label>General Evaluator 總評 <span className="time-hint">3'~5'</span></label>
                  <input type="text" id="generalEvaluator" placeholder="Name, Title" className="member-ac" />
                </div>
                <div id="evaluatorsList"></div>
                <div className="form-row" style={{ marginTop: 10 }}>
                  <label>Language Evaluator 語言講評 <span className="time-hint">3'~5'</span></label>
                  <input type="text" id="langEvaluator" placeholder="Name, Title" className="member-ac" />
                </div>
                <hr style={{ margin: '12px 0 8px', borderColor: '#ddd' }} />
                <p className="time-override-hint" style={{ marginTop: 0 }}>
                  <strong>講評員講評 Evaluator&apos;s Evaluator</strong>（排在總講評之後，可不設，最多 {MAX_EVAL_EVALUATORS} 位）
                </p>
                <div id="evalEvaluatorsList"></div>
              </div>
            </details>

            <details open data-tmpl="standard compact entrepreneur chillhihigh china" style={{ display: 'none' }}>
              <summary>結束環節 Closing</summary>
              <div className="form-section">
                <div className="form-row">
                  <label>Awards Presentation 頒獎 <span className="time-hint">3'</span></label>
                  <input type="text" id="awardsPresenter" placeholder="Name, Title" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>Sharing &amp; Feedback 分享 <span className="time-hint">5'</span></label>
                  <input type="text" id="sharingFeedback" placeholder="Name, Title" className="member-ac" />
                </div>
              </div>
            </details>

            {/* Template-specific fields: shown only when the active club uses this template */}
            <details open data-tmpl="chillhihigh china" style={{ display: 'none' }}>
              <summary>主題題目 Table Topics Question</summary>
              <div className="form-section">
                <div className="form-row">
                  <label>主題題目 Table Topics Question</label>
                  <textarea rows={3} id="tableTopicsQuestion" placeholder="你覺得「最不適合開玩笑」的議題是什麼？…"></textarea>
                </div>
              </div>
            </details>

            <details open data-tmpl="chillhihigh" style={{ display: 'none' }}>
              <summary>Chill Hi High 專屬欄位</summary>
              <div className="form-section">
                <div className="form-row">
                  <label>白板記錄員 Board Writer</label>
                  <input type="text" id="boardWriter" placeholder="Name, Title" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>攝影師 Photographer</label>
                  <input type="text" id="photographer" placeholder="Name, Title" className="member-ac" />
                </div>

                <div className="signal-grid-title">時間管理 Time Signals（綠 / 黃 / 紅）</div>
                <div className="signal-grid">
                  <div className="signal-grid-head"><span></span><span className="sg-g">綠</span><span className="sg-y">黃</span><span className="sg-r">紅</span></div>
                  <div className="signal-row">
                    <label>暖場 Variety</label>
                    <input id="sig_variety_g" defaultValue="10" onInput={(e) => updateSignal('variety', 'g', e.target.value)} />
                    <input id="sig_variety_y" defaultValue={`12'30"`} onInput={(e) => updateSignal('variety', 'y', e.target.value)} />
                    <input id="sig_variety_r" defaultValue="15" onInput={(e) => updateSignal('variety', 'r', e.target.value)} />
                  </div>
                  <div className="signal-row">
                    <label>指定演講 Speech</label>
                    <input id="sig_preparedSpeech_g" defaultValue="5" onInput={(e) => updateSignal('preparedSpeech', 'g', e.target.value)} />
                    <input id="sig_preparedSpeech_y" defaultValue="6" onInput={(e) => updateSignal('preparedSpeech', 'y', e.target.value)} />
                    <input id="sig_preparedSpeech_r" defaultValue="7" onInput={(e) => updateSignal('preparedSpeech', 'r', e.target.value)} />
                  </div>
                  <div className="signal-row">
                    <label>即席問答 Topics</label>
                    <input id="sig_tableTopics_g" defaultValue="10" onInput={(e) => updateSignal('tableTopics', 'g', e.target.value)} />
                    <input id="sig_tableTopics_y" defaultValue={`12'30"`} onInput={(e) => updateSignal('tableTopics', 'y', e.target.value)} />
                    <input id="sig_tableTopics_r" defaultValue="15" onInput={(e) => updateSignal('tableTopics', 'r', e.target.value)} />
                  </div>
                  <div className="signal-row">
                    <label>個別講評 Eval</label>
                    <input id="sig_evaluation_g" defaultValue="2" onInput={(e) => updateSignal('evaluation', 'g', e.target.value)} />
                    <input id="sig_evaluation_y" defaultValue={`2'30"`} onInput={(e) => updateSignal('evaluation', 'y', e.target.value)} />
                    <input id="sig_evaluation_r" defaultValue="3" onInput={(e) => updateSignal('evaluation', 'r', e.target.value)} />
                  </div>
                  <div className="signal-row">
                    <label>語言/幽默講評</label>
                    <input id="sig_langEval_g" defaultValue="3" onInput={(e) => updateSignal('langEval', 'g', e.target.value)} />
                    <input id="sig_langEval_y" defaultValue="4" onInput={(e) => updateSignal('langEval', 'y', e.target.value)} />
                    <input id="sig_langEval_r" defaultValue="5" onInput={(e) => updateSignal('langEval', 'r', e.target.value)} />
                  </div>
                  <div className="signal-row">
                    <label>總講評 General</label>
                    <input id="sig_generalEval_g" defaultValue="3" onInput={(e) => updateSignal('generalEval', 'g', e.target.value)} />
                    <input id="sig_generalEval_y" defaultValue="4" onInput={(e) => updateSignal('generalEval', 'y', e.target.value)} />
                    <input id="sig_generalEval_r" defaultValue="5" onInput={(e) => updateSignal('generalEval', 'r', e.target.value)} />
                  </div>
                </div>
                <div className="form-row">
                  <label>即席問答 每位講者時間標示 Speaker Spec</label>
                  <input type="text" id="sig_ttSpeakerSpec" defaultValue={`1'/1'30"/2'`} onInput={(e) => updateSignal('ttSpeakerSpec', null, e.target.value)} />
                </div>
              </div>
            </details>

            {/* Template-specific fields: shown only when the active club uses this template */}
            <details open data-tmpl="china" style={{ display: 'none' }}>
              <summary>CHINA 專屬角色</summary>
              <div className="form-section">
                <div className="form-row">
                  <label>Vote Counter 計票員</label>
                  <input type="text" id="voteCounter" placeholder="Name, Title" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>Word of the Day 每日一字</label>
                  <input type="text" id="wordOfTheDay" placeholder="Name, Title" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>Quiz Session 問答遊戲主持</label>
                  <input type="text" id="quizHost" placeholder="Name, Title" className="member-ac" />
                </div>
                <p className="img-hint">「Next Meeting」欄位（議程右側）會在列印/預覽時自動抓下一場例會的資料，這裡不用手動填。</p>
              </div>
            </details>

            <details open data-tmpl="china" style={{ display: 'none' }}>
              <summary>CHINA 專屬 — 上次會議回顧 Previous Meeting Recap</summary>
              <div className="form-section">
                <div className="form-row">
                  <label>上次會議日期 Date</label>
                  <input type="text" id="pm_date" placeholder="2026/7/09" />
                </div>
                <div className="form-row">
                  <label>出席會員 Attend Members</label>
                  <input type="text" id="pm_attendMembers" placeholder="15" />
                </div>
                <div className="form-row">
                  <label>出席來賓 Attend Guests</label>
                  <input type="text" id="pm_attendGuests" placeholder="15" />
                </div>
                <div className="form-row">
                  <label>Best Speaker</label>
                  <input type="text" id="pm_bestSpeaker" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>Best Evaluator</label>
                  <input type="text" id="pm_bestEvaluator" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>Best Topics Speaker</label>
                  <input type="text" id="pm_bestTopicsSpeaker" className="member-ac" />
                </div>
                <div className="form-row">
                  <label>Best Session Master</label>
                  <input type="text" id="pm_bestSessionMaster" className="member-ac" />
                </div>
              </div>
            </details>

            <details open data-tmpl="china" style={{ display: 'none' }}>
              <summary>CHINA 專屬 — The ENGAGING Present（本次演講專案）</summary>
              <div className="form-section">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="speech-entry">
                    <div className="speech-entry-header"><span>Speaker {i + 1}</span></div>
                    <div className="form-row">
                      <label>講者 Speaker</label>
                      <input type="text" id={`proj_${i}_speaker`} className="member-ac" />
                    </div>
                    <div className="form-row">
                      <label>專案代碼 Project (e.g. PM L2P1)</label>
                      <input type="text" id={`proj_${i}_code`} placeholder="PM L2P1" />
                    </div>
                    <div className="form-row">
                      <label>Purpose</label>
                      <textarea rows={2} id={`proj_${i}_purpose`}></textarea>
                    </div>
                    <div className="form-row">
                      <label>Evaluator</label>
                      <textarea rows={2} id={`proj_${i}_eval`}></textarea>
                    </div>
                    <div className="form-row" style={{ marginBottom: 0 }}>
                      <label><input type="checkbox" id={`proj_${i}_spotlight`} /> Spotlight</label>
                    </div>
                  </div>
                ))}
              </div>
            </details>

            <details open data-tmpl="china" style={{ display: 'none' }}>
              <summary>CHINA 專屬 — The PROMISING Future（下次講者預告）</summary>
              <div className="form-section">
                {[0, 1, 2].map((i) => (
                  <div className="form-row" key={i}>
                    <label>Speaker {i + 1}</label>
                    <input type="text" id={`nextSpeaker_${i}`} className="member-ac" />
                  </div>
                ))}
              </div>
            </details>

          </div>
          <div className="form-actions">
            <div className="form-actions-menu">
              <div className="form-actions-row">
                <button id="btnSave" className="btn-action btn-action-save write-action" onClick={saveAgenda}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                  儲存
                </button>
                <button className="btn-action btn-action-load" onClick={openLoadModal}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  載入
                </button>
              </div>
              <button className="btn-action-reset" onClick={resetForm}>↺ 重設表單</button>
            </div>
            <div className="form-actions-trigger" onClick={toggleActionsMenu}>
              <span>功能列表</span>
              <svg className="actions-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
            </div>
          </div>
        </div>

        <div className="preview-panel">
          <div className="preview-toolbar">
            <button className="btn-home-rwd" onClick={() => { location.href = '/home'; }}>← 首頁</button>
            <span className="toolbar-label">預覽（即時更新）</span>
            <div className="toolbar-right">
              <div className="settings-dropdown" id="settingsDropdown">
                <button className="btn-settings" onClick={toggleSettingsMenu}>
                  <svg className="btn-settings-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  <span className="btn-settings-label">設定 ▾</span>
                </button>
                <div className="settings-menu-panel">
                  <button className="settings-menu-item" id="langMenuItem" onClick={toggleLang}>
                    <span>語言</span><span id="langToggle">切換中文</span>
                  </button>
                  <button className="settings-menu-item" onClick={downloadPDF}>下載 PDF</button>
                  <button className="settings-menu-item" onClick={downloadJPG}>下載 JPG</button>
                </div>
              </div>
              <div className="toolbar-sep"></div>
              <button className="btn-toolbar-nav" onClick={() => { location.href = '/home'; }}>← 首頁</button>
              <span id="saveStatus" className="save-status unsaved">○ 未儲存</span>
              <button id="logoutBtn" className="btn-logout" onClick={logout}></button>
            </div>
          </div>
          <div className="preview-scroll">
            <div id="agendaPages">
              <div id="agendaPreview" className="agenda-page"></div>
            </div>
          </div>
        </div>

      </div>

      <div id="loadModal" className="modal-overlay" style={{ display: 'none' }} onClick={(e) => { if (e.target === e.currentTarget) closeLoadModal(); }}>
        <div className="modal-box">
          <div className="modal-header">
            <h3>載入議程</h3>
            <button className="modal-close" onClick={closeLoadModal}>✕</button>
          </div>
          <div className="modal-cal">
            <div className="cal-nav">
              <button className="cal-nav-btn" onClick={calPrevMonth}>&#8249;</button>
              <span id="calMonthLabel" className="cal-month-label"></span>
              <button className="cal-nav-btn" onClick={calNextMonth}>&#8250;</button>
              <button className="btn-cal-all" onClick={calClearFilter}>全部</button>
            </div>
            <div className="cal-weekdays">
              <div>日</div><div>一</div><div>二</div><div>三</div><div>四</div><div>五</div><div>六</div>
            </div>
            <div id="calendarGrid" className="cal-grid"></div>
          </div>
          <div id="agendaListBody" className="agenda-list-body"></div>
        </div>
      </div>

      <div id="clubTemplateSwitchModal" className="modal-overlay" style={{ display: 'none' }} onClick={(e) => { if (e.target === e.currentTarget) cancelClubTemplateSwitch(); }}>
        <div className="modal-box modal-box-confirm">
          <div className="modal-header">
            <h3>切換分會將同時切換議程版型</h3>
            <button className="modal-close" onClick={cancelClubTemplateSwitch}>✕</button>
          </div>
          <div id="clubTemplateSwitchBody" className="modal-body"></div>
          <div className="modal-actions">
            <button className="modal-btn modal-btn-cancel" onClick={cancelClubTemplateSwitch}>取消</button>
            <button className="modal-btn modal-btn-confirm" onClick={confirmClubTemplateSwitch}>確定切換</button>
          </div>
        </div>
      </div>

      <div id="memberDropdown" className="member-dropdown"></div>

      <div id="loadingOverlay" className="loading-overlay">
        <div className="page-loading-spinner"></div>
      </div>
    </>
  );
}
