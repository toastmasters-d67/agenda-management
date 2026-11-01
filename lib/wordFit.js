// ----------------------------------------------------------------
// Make a Word table fill the space it is given, whatever the row count.
//
// The web agenda stretches its table to the bottom of the A4 page (flex), and
// Word has no such thing: a table is only as tall as its rows. So a template
// marks the table and how tall it may be — the table's alt-text title
// (Table Properties → Alt Text → Title) set to {{填滿:175}}, in millimetres —
// and after the meeting is filled in, that height is shared out over the rows
// the table actually has. Fewer speeches → taller rows; more → shorter. Each
// row gets it as a minimum (hRule="atLeast"), so a row whose text needs more
// still grows rather than being cut.
//
// Kept free of imports so it runs anywhere (the browser fill, a Node check).
// ----------------------------------------------------------------

const MARK_RE = /<w:tblCaption\s+w:val="\{\{填滿[:：]\s*(\d+(?:\.\d+)?)\s*\}\}"\s*\/>/g;
const TWIPS_PER_MM = 56.6929;

/** [start, end) of the <w:tbl> that contains `pos` (nested tables allowed). */
function enclosingTable(xml, pos) {
  // Walk back to the <w:tbl> that is still open at `pos`.
  let depth = 0;
  let i = pos;
  while (i > 0) {
    const open = xml.lastIndexOf('<w:tbl>', i - 1);
    const close = xml.lastIndexOf('</w:tbl>', i - 1);
    if (open === -1) return null;
    if (close > open) { depth += 1; i = close; continue; }
    if (depth === 0) { i = open; break; }
    depth -= 1;
    i = open;
  }
  const start = i;
  // Then forward to its matching </w:tbl>.
  const tag = /<w:tbl>|<\/w:tbl>/g;
  tag.lastIndex = start;
  let d = 0;
  let m;
  while ((m = tag.exec(xml))) {
    d += m[0] === '<w:tbl>' ? 1 : -1;
    if (d === 0) return [start, m.index + m[0].length];
  }
  return null;
}

/** The table's own rows (not those of tables nested in its cells): [start, end) each. */
function ownRows(tbl) {
  const rows = [];
  const tag = /<w:tbl>|<\/w:tbl>|<w:tr[ >]|<\/w:tr>/g;
  let depth = 0;
  let rowStart = -1;
  let m;
  while ((m = tag.exec(tbl))) {
    if (m[0] === '<w:tbl>') depth += 1;
    else if (m[0] === '</w:tbl>') depth -= 1;
    else if (depth === 1 && m[0].startsWith('<w:tr')) rowStart = m.index;
    else if (depth === 1 && m[0] === '</w:tr>' && rowStart !== -1) {
      rows.push([rowStart, m.index + m[0].length]);
      rowStart = -1;
    }
  }
  return rows;
}

// ---- how tall a row is on its own, estimated from its text ----
// Rows whose text wraps (a speech title with its Pathways project) are taller
// than an even share would make them, so sharing the height out evenly would
// overshoot the page. Each row's own height is estimated — lines of text at
// their font size in the cell's width — and only the space left over is
// shared out (fitShare). An estimate, so templates keep a little margin.

const DEFAULT_SZ = 16;          // half-points (8 pt) when a run sets none
const LINE_GAP = 1.09;          // line box over the em size, calibrated against Word (Noto Sans CJK TC + Arial)
const WIDE_RE = /[⺀-￿]/;

function textWidth(text, szHalfPt) {
  let em = 0;
  for (const ch of text) em += WIDE_RE.test(ch) ? 1 : 0.56;
  return em * szHalfPt * 10;     // twips
}

function attr(xml, re, fallback) {
  const m = xml.match(re);
  return m ? Number(m[1]) : fallback;
}

/** Estimated height of one cell's content, in twips (margins included). */
function cellHeight(tc) {
  const width = attr(tc, /<w:tcW\b[^>]*w:w="(\d+)"/, 2000)
    - attr(tc, /<w:tcMar>[\s\S]*?<w:(?:left|start)\b[^>]*w:w="(\d+)"/, 108)
    - attr(tc, /<w:tcMar>[\s\S]*?<w:(?:right|end)\b[^>]*w:w="(\d+)"/, 108);
  let height = attr(tc, /<w:tcMar>[\s\S]*?<w:top\b[^>]*w:w="(\d+)"/, 0)
    + attr(tc, /<w:tcMar>[\s\S]*?<w:bottom\b[^>]*w:w="(\d+)"/, 0);
  for (const p of tc.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []) {
    const sz = Math.max(DEFAULT_SZ, ...[...p.matchAll(/<w:sz w:val="(\d+)"/g)].map((m) => Number(m[1])));
    // Entities (&apos; in 22') are one character each, not six.
    const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
      .replace(/&(?:#\d+|[a-z]+);/g, "'");
    const lines = Math.max(1, Math.ceil(textWidth(text, sz) / Math.max(width, 200)));
    const spacing = attr(p, /<w:spacing\b[^>]*w:line="(\d+)"/, 240) / 240;
    height += lines * sz * 10 * LINE_GAP * spacing
      + attr(p, /<w:spacing\b[^>]*w:before="(\d+)"/, 0) + attr(p, /<w:spacing\b[^>]*w:after="(\d+)"/, 0);
  }
  return height;
}

/** Estimated height of a row on its own: its tallest cell. */
function naturalHeight(row) {
  const cells = row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [];
  return Math.max(0, ...cells.map((tc) => (/<w:vMerge\b(?![^>]*restart)/.test(tc) ? 0 : cellHeight(tc))));
}

/**
 * The minimum row height that makes the rows total `budget`: rows already
 * taller keep their height, the rest are raised to it. Null when the rows
 * already need the whole budget (leave the table as it is).
 */
function fitShare(heights, budget) {
  if (heights.reduce((a, b) => a + b, 0) >= budget) return null;
  let lo = 0;
  let hi = budget;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const total = heights.reduce((a, h) => a + Math.max(h, mid), 0);
    if (total > budget) hi = mid; else lo = mid;
  }
  return Math.floor(lo);
}

/** One row with its minimum height set to `twips` (keeps a taller one already set). */
function withMinHeight(row, twips) {
  const height = `<w:trHeight w:val="${twips}" w:hRule="atLeast"/>`;
  const existing = row.match(/<w:trHeight\b[^>]*\/>/);
  if (existing) {
    const val = Number((existing[0].match(/w:val="(\d+)"/) || [])[1] || 0);
    const exact = /w:hRule="exact"/.test(existing[0]);
    if (exact || val >= twips) return row;          // a fixed or taller row stays as designed
    return row.replace(existing[0], height);
  }
  if (/<w:trPr>/.test(row)) return row.replace('<w:trPr>', `<w:trPr>${height}`);
  if (/<w:trPr\/>/.test(row)) return row.replace('<w:trPr/>', `<w:trPr>${height}</w:trPr>`);
  return row.replace(/^<w:tr\b[^>]*>/, (open) => `${open}<w:trPr>${height}</w:trPr>`);
}

/**
 * Every table marked {{填滿:mm}} in `xml` (word/document.xml) gets its rows
 * sized to share that height. Returns the new XML; unmarked documents come
 * back unchanged.
 */
export function fitMarkedTables(xml) {
  const marks = [...xml.matchAll(MARK_RE)];
  // From the last mark backwards, so earlier offsets stay valid.
  for (const mark of marks.reverse()) {
    const span = enclosingTable(xml, mark.index);
    if (!span) continue;
    const [start, end] = span;
    let tbl = xml.slice(start, end);
    const rows = ownRows(tbl);
    if (!rows.length) continue;
    const twips = fitShare(rows.map(([rs, re]) => naturalHeight(tbl.slice(rs, re))),
      Number(mark[1]) * TWIPS_PER_MM);
    if (twips === null) continue;
    for (const [rs, re] of rows.reverse()) {
      tbl = tbl.slice(0, rs) + withMinHeight(tbl.slice(rs, re), twips) + tbl.slice(re);
    }
    xml = xml.slice(0, start) + tbl + xml.slice(end);
  }
  return xml;
}
