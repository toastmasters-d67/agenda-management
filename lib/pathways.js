'use client';

// Toastmasters Pathways catalog — paths, levels and projects, bilingual.
//
// The data lives in the database (migration 0013) and is edited on the
// 「Pathways 路徑管理」page (/pathways); nothing here is hard-coded. Pages that
// use it call `loadPathways()` once during init, then everything below reads
// the loaded copy synchronously — the agenda editor and the role matrix build
// their forms as HTML strings and can't await mid-render.
//
// A speech stores the project's English name in `pathwayProject`;
// `projectName()` localizes it at render time. Anything that isn't a known
// project (free-text notes, values imported from the roles sheet) is kept and
// printed verbatim.

import { apiJson } from './api';

export const LEVELS = [1, 2, 3, 4, 5];

let catalog = { projects: [], paths: [], electives: {} };
let zhByEn = new Map();      // English → 中文
let byKey = new Map();       // lower-cased en or zh → English
let pathByCode = new Map();  // code → path

/** Swap in a catalog as returned by GET /api/pathways. */
export function setPathwayCatalog(data) {
  catalog = {
    projects: data?.projects || [],
    paths: data?.paths || [],
    electives: data?.electives || {},
  };
  zhByEn = new Map(catalog.projects.map((p) => [p.en, p.zh]));
  byKey = new Map();
  catalog.projects.forEach((p) => {
    byKey.set(p.en.toLowerCase(), p.en);
    if (p.zh) byKey.set(p.zh.toLowerCase(), p.en);
  });
  pathByCode = new Map(catalog.paths.map((p) => [p.code, p]));
}

let loading = null;

/**
 * Fetch the catalog once per page load (repeat calls share the request).
 * Resolves to false on failure — the dropdowns then only offer "不指定" and
 * keep whatever the agenda already stores.
 */
export function loadPathways({ force = false } = {}) {
  if (!loading || force) {
    loading = apiJson('/pathways')
      .then((data) => { setPathwayCatalog(data); return true; })
      .catch(() => { loading = null; return false; });
  }
  return loading;
}

/** A deep copy of the loaded catalog, for the admin page to edit as a draft. */
export function getPathwayCatalog() {
  return JSON.parse(JSON.stringify(catalog));
}

/** `[[code, name], …]` in display order — the agenda templates' right panel. */
export function pathwayPairs(lang) {
  return catalog.paths.map((p) => [p.code, lang === 'zh' ? (p.zh || p.en) : p.en]);
}

/** `[{ code, en, zh, legacy }, …]` in display order. */
export function pathwayList() {
  return catalog.paths.map(({ code, en, zh, legacy }) => ({ code, en, zh, legacy }));
}

export function pathwayCodes() {
  return catalog.paths.map((p) => p.code);
}

/** Stored `pathwayLevel` for a level number — the format the dropdown writes. */
export const levelValue = (n) => `L${n}`;

/**
 * Level number from any stored level string: `L3` → 3, `L1P3` → 1, `4-1` → 4
 * (the roles-sheet `PM 4-1` form). 0 when there is none.
 */
export function levelNumber(raw) {
  const m = String(raw || '').match(/[1-5]/);
  return m ? Number(m[0]) : 0;
}

const requiredFor = (path, level) => path.required?.[String(level)] || [];

/**
 * Projects to offer for a path + level, as `[{ level, kind, items }]` groups
 * (`kind` is 'required' | 'elective' | 'any'). A path never offers its own
 * required projects as electives. Missing path → every current path's
 * projects for that level merged; missing level → every level.
 */
export function projectGroups(code, level) {
  const levels = level ? [level] : LEVELS;
  const path = pathByCode.get(code);
  return levels.flatMap((l) => {
    const pool = catalog.electives[String(l)] || [];
    if (path) {
      const own = new Set(LEVELS.flatMap((x) => requiredFor(path, x)));
      const electives = pool.filter((p) => !own.has(p));
      return [
        { level: l, kind: 'required', items: requiredFor(path, l) },
        ...(electives.length ? [{ level: l, kind: 'elective', items: electives }] : []),
      ];
    }
    const merged = new Set(pool);
    catalog.paths.filter((p) => !p.legacy).forEach((p) => requiredFor(p, l).forEach((x) => merged.add(x)));
    return merged.size ? [{ level: l, kind: 'any', items: [...merged].sort() }] : [];
  });
}

/** The level at which `project` is required on `code`'s path, else 0. */
export function requiredLevelOf(code, project) {
  const path = pathByCode.get(code);
  if (!path) return 0;
  return LEVELS.find((l) => requiredFor(path, l).includes(project)) || 0;
}

/**
 * Canonical English name for a stored project value — accepts either
 * language, ignoring case/extra spaces. '' when it isn't a catalog project.
 */
export function canonicalProject(raw) {
  const v = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!v) return '';
  return byKey.get(v.toLowerCase()) || '';
}

/** A project's name in `lang` ('en' | 'zh'); unknown values come back unchanged. */
export function projectName(raw, lang) {
  const en = canonicalProject(raw);
  if (!en) return String(raw || '');
  return lang === 'zh' ? (zhByEn.get(en) || en) : en;
}

/** Bilingual label for editor dropdowns: `Ice Breaker｜初試啼聲`. */
export function projectLabel(en) {
  const zh = zhByEn.get(en);
  return zh ? `${en}｜${zh}` : en;
}

// ---------------------------------------------------------------- <select> HTML
// Shared by the agenda editor and the /roles matrix, both of which build their
// forms as HTML strings. Every builder keeps a stored value it doesn't
// recognise as its own "（原值）" option, so a value imported from the roles
// sheet or typed before these were dropdowns is never rewritten by just
// opening the form.

/** Option value that stands for "type your own" in the project select. */
export const CUSTOM_PROJECT = '__custom__';

const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NONE = '<option value="">— 不指定 —</option>';
const keepRaw = (raw) => `<option value="${escHtml(raw)}">${escHtml(raw)}（原值）</option>`;

export function pathwayOptionsHtml(raw = '') {
  const opt = (p) => `<option value="${escHtml(p.code)}">${escHtml(`${p.code} — ${p.en}${p.zh ? `｜${p.zh}` : ''}`)}</option>`;
  const group = (label, list) => (list.length ? `<optgroup label="${label}">${list.map(opt).join('')}</optgroup>` : '');
  return NONE + (raw && !pathByCode.has(raw) ? keepRaw(raw) : '')
    + group('現行路徑 Current', catalog.paths.filter((p) => !p.legacy))
    + group('已停用 Legacy', catalog.paths.filter((p) => p.legacy));
}

export function levelOptionsHtml(raw = '') {
  const unknown = raw && !LEVELS.some((n) => levelValue(n) === raw);
  return NONE + (unknown ? keepRaw(raw) : '')
    + LEVELS.map((n) => `<option value="${levelValue(n)}">第 ${n} 級 Level ${n}</option>`).join('');
}

/**
 * Project options for a path + level, plus the value the select should show.
 * With `allowCustom`, a non-catalog value selects the CUSTOM_PROJECT option
 * (the caller shows its own text box); without it, the value is kept as a
 * "（原值）" option instead.
 */
export function projectSelect(code, level, raw = '', { allowCustom = false } = {}) {
  const current = canonicalProject(raw);
  const groups = projectGroups(code, levelNumber(level));
  const kindLabel = { required: ' · 必修 Required', elective: ' · 選修 Electives', any: '' };
  const opt = (p) => `<option value="${escHtml(p)}">${escHtml(projectLabel(p))}</option>`;
  const listed = groups.some((g) => g.items.includes(current));
  const custom = !!raw && !current;

  const html = NONE
    + (custom && !allowCustom ? keepRaw(raw) : '')
    + (current && !listed ? `<optgroup label="目前的專案 Current">${opt(current)}</optgroup>` : '')
    + groups.map((g) => `<optgroup label="第 ${g.level} 級 Level ${g.level}${kindLabel[g.kind]}">`
      + g.items.map(opt).join('') + '</optgroup>').join('')
    + (allowCustom ? `<option value="${CUSTOM_PROJECT}">其他／自訂備註 Other…</option>` : '');

  return { html, value: custom ? (allowCustom ? CUSTOM_PROJECT : raw) : current, custom };
}
