'use client';

// ================================================================
// GOOGLE SHEET → ROLE MATRIX MAPPER  (Chill Hi High「例會角色」表)
// ================================================================
// The season-planning sheet is a *transpose* of the /roles matrix: one row per
// role (label in column A), one column per meeting. That makes the mapping a
// pure table lookup — this module owns it, and knows nothing about the DOM,
// the network, or React, so the same code serves the backend fetch today and a
// paste-in importer later.
//
// Everything it emits is keyed by the very same role ids /roles already uses
// (`role.key` in app/roles/page.js), which are in turn `agendas.data` fields —
// so an imported value travels the normal draft → dirty → saveAll path and
// lands on the agenda exactly as if someone had typed it into a cell.
//
// Empty sheet cells are *omitted*, never emitted as ''. The sheet is only
// partially filled (most of the season is still blank), and the roles it has no
// row for at all — 報到接待 / 會長致歡迎詞 / 贈感謝狀 / 會後分享 — must
// survive an import untouched.

import { pathwayCodes } from './pathways';

// ---------------------------------------------------------------- CSV
/** Minimal RFC-4180 reader — Google's CSV export quotes any field with , " or \n. */
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (s[i + 1] === '"') { field += '"'; i++; }   // escaped quote
      else quoted = false;
      continue;
    }
    if (c === '"')       quoted = true;
    else if (c === ',')  { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else                 field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------- row map
/** Sheet row label → role id. These rows hold member names. */
const PERSON_ROWS = {
  '總主持人':        'tme',
  '計時員':          'timer',
  '計時員幫手':      'timerAssistant',
  '贅字/笑聲記錄員': 'ahCounter',
  '白板記錄員':      'boardWriter',
  '攝影師':          'photographer',
  '暖場活動主持人':  'varietyHost',
  '即席問答主持人':  'tableTopicsMaster',
  '總講評員':        'generalEvaluator',
  '語言/幽默講評員': 'langEvaluator',
  // 講評員講評 is an array in `agendas.data` (up to MAX_EVAL_EVALUATORS); the
  // sheet has a single unnumbered row, so it lands in the first slot.
  '講評員講評':      'evalEvaluator1',
};

/** Sheet row label → per-meeting text field (edited in the matrix column header). */
const META_ROWS = {
  '會議編號': 'meetingNo',
  '會議主題': 'meetingTheme',
  '主題題目': 'themeQuestion',
};

/** The ids META_ROWS produces — column-header fields rather than matrix rows. */
export const META_IDS = new Set(Object.values(META_ROWS));

/** Rows deliberately left out, with the reason surfaced in the import preview. */
const IGNORED_ROWS = {
  '特別單元':       '不是角色欄位（單元名稱）',
  '無法參加的成員': '不是角色欄位（請假名單）',
};

const DATE_ROW = '會議時間';

/** `演講者3` / `標題3` / `單元號3` / `單元3` / `個別講評員3` → indexed keys. */
const INDEXED_ROWS = [
  [/^演講者\s*(\d+)$/,     (n) => `speech${n}`,         true ],
  [/^個別講評員\s*(\d+)$/, (n) => `evaluator${n}`,      true ],
  [/^講評員講評\s*(\d+)$/, (n) => `evalEvaluator${n}`,  true ],
  [/^標題\s*(\d+)$/,       (n) => `speech${n}_title`,   false],
  [/^單元號\s*(\d+)$/,     (n) => `speech${n}_pathway`, false],
  [/^單元\s*(\d+)$/,       (n) => `speech${n}_project`, false],
];


/** Placeholders the sheet uses for "nobody / not decided" — imported as absent. */
const PERSON_BLANKS = new Set(['na', 'n/a', '-', '—', '–', 'tbd', '待定', '未定', '?', '？']);

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** True for ids holding a member name — the ones worth matching against the roster. */
export function isPersonField(id) {
  if (META_IDS.has(id)) return false;
  return !/_(title|pwcode|pwlevel|project)$/.test(id);
}

/** `2026/07/03`, `2026-7-3`, `2026.07.03` → `2026-07-03`; anything else → ''. */
export function toIsoDate(raw) {
  const m = clean(raw).match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

/**
 * `PM 4-1` → { code:'PM', level:'4-1' }; a bare level keeps `code` empty.
 * Codes are checked against the loaded Pathways catalog (lib/pathways.js).
 */
export function splitPathway(raw) {
  const v = clean(raw);
  if (!v) return { code: '', level: '' };
  const m = v.match(/^([A-Za-z]{2,4})\b[\s-]*(.*)$/);
  if (m && pathwayCodes().includes(m[1].toUpperCase())) {
    return { code: m[1].toUpperCase(), level: clean(m[2]) };
  }
  return { code: '', level: v };
}

// ---------------------------------------------------------------- parse
/**
 * CSV text → one entry per meeting column.
 *
 * @returns {{
 *   columns: {date:string, rawDate:string, values:Object<string,string>, count:number}[],
 *   ignored: {label:string, reason:string}[],
 *   unknown: string[],
 *   badDates: string[],
 * }}
 */
export function parseRolesSheet(csvText) {
  const grid = parseCsv(csvText);
  const dateRow = grid.find((r) => clean(r[0]) === DATE_ROW);
  if (!dateRow) throw new Error(`找不到「${DATE_ROW}」這一列，請確認分頁與欄位格式`);

  // Column index → meeting. Column 0 is the row-label column.
  const cols = [];
  const badDates = [];
  for (let c = 1; c < dateRow.length; c++) {
    const rawDate = clean(dateRow[c]);
    if (!rawDate) continue;
    const date = toIsoDate(rawDate);
    if (!date) { badDates.push(rawDate); continue; }
    cols.push({ c, date, rawDate, values: {}, count: 0, roleCount: 0 });
  }

  const ignored = [];
  const unknown = [];
  // `roleCount` excludes the meta rows, which the sheet fills in for the whole
  // season up front — a column carrying nothing but 會議編號 is an empty slot,
  // not a planned meeting, and the importer offers to skip those.
  const put = (col, id, value) => {
    if (!value) return;
    col.values[id] = value;
    col.count++;
    if (!META_IDS.has(id)) col.roleCount++;
  };

  for (const row of grid) {
    const label = clean(row[0]);
    if (!label || label === DATE_ROW) continue;
    const hasData = row.slice(1).some((v) => clean(v));

    if (label in IGNORED_ROWS) {
      if (hasData) ignored.push({ label, reason: IGNORED_ROWS[label] });
      continue;
    }

    const flat = PERSON_ROWS[label] || META_ROWS[label] || null;
    const idx  = flat ? null : INDEXED_ROWS
      .map(([re, key, person]) => { const m = label.match(re); return m ? { id: key(m[1]), person } : null; })
      .find(Boolean);

    if (!flat && !idx) {
      if (hasData) unknown.push(label);
      continue;
    }

    const id     = flat || idx.id;
    const person = flat ? isPersonField(flat) : idx.person;

    for (const col of cols) {
      const raw = clean(row[col.c]);
      if (!raw) continue;
      if (person && PERSON_BLANKS.has(raw.toLowerCase())) continue;

      if (id.endsWith('_pathway')) {
        // One sheet cell (`PM 4-1`) feeds two agenda fields.
        const { code, level } = splitPathway(raw);
        put(col, id.replace(/_pathway$/, '_pwcode'), code);
        put(col, id.replace(/_pathway$/, '_pwlevel'), level);
      } else {
        put(col, id, raw);
      }
    }
  }

  return { columns: cols, ignored, unknown, badDates };
}

// ---------------------------------------------------------------- names
/**
 * Sheet names read `English 中文` (e.g. `Leah Kao 高莉雅`), while a cell filled
 * from the dropdown holds MemberAC's canonical `Name, LEVEL`. Resolve to that
 * canonical form when the person is on the roster, so an imported cell is
 * indistinguishable from a hand-picked one (and `displayMember` can render it
 * bilingually); otherwise keep the sheet text verbatim — guests and visiting
 * members are legitimately not on the roster.
 *
 * @param format  MemberAC.formatMember
 * @returns {{value:string, matched:boolean}}
 */
export function resolveMemberName(raw, roster, lang, format) {
  const v = clean(raw);
  if (!v) return { value: '', matched: false };
  const key = v.toLowerCase();
  const eq  = (s) => clean(s).toLowerCase() === key;

  const hit = (roster || []).find((m) =>
    eq(m.nameEn) || eq(m.nameZh) ||
    eq(`${m.nameEn} ${m.nameZh}`) || eq(`${m.nameZh} ${m.nameEn}`) ||
    (m.level && (eq(`${m.nameEn}, ${m.level}`) || eq(`${m.nameZh}, ${m.level}`)))
  );
  if (!hit) return { value: v, matched: false };
  return { value: format ? format(hit, lang) : v, matched: true };
}
