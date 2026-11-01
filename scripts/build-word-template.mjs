// Builds public/templates/agenda-default.docx — the Word template used for
// 下載 Word when a club hasn't uploaded its own (see lib/wordExport.js).
// It mirrors the standard agenda: burgundy banner, a sidebar (date,
// officers, meeting info, club mission) and the agenda table, all plain Word
// tables so the downloaded file stays easy to edit.
//
//   node scripts/build-word-template.mjs
//
// Marks are {{…}} (WORD_FIELDS / WORD_LOOPS in lib/wordExport.js). A loop's
// open and close marks sit in the same table row, so the row repeats.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markFillTable } from './mark-fill-table.mjs';
import {
  AlignmentType, BorderStyle, Document, ImageRun, Packer, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType,
} from 'docx';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'public/templates/agenda-default.docx');
const LOGO = fs.readFileSync(path.join(root, 'public/media/toastmasters_logo.png'));

const MAIN = '772432'; // Toastmasters burgundy — same as the standard template
const DARK = '4A1630';
const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft JhengHei' };

// A4 portrait, 1 cm margins → 10,466 DXA of usable width.
const PAGE_W = 11906;
const MARGIN = 567;
const WIDTH = PAGE_W - MARGIN * 2;
const SIDE_W = 2900;
const AGENDA_W = WIDTH - SIDE_W;
const COL = { time: 900, who: 2300 };
COL.item = AGENDA_W - COL.time - COL.who - 200; // 200 = left padding of the agenda cell

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };

const run = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 18, bold: o.bold, color: o.color });
const para = (children, o = {}) => new Paragraph({
  children: Array.isArray(children) ? children : [children],
  alignment: o.align, spacing: { before: o.before || 0, after: o.after || 0 },
});
const cell = (children, width, o = {}) => new TableCell({
  children, width: { size: width, type: WidthType.DXA }, borders: o.borders || NO_BORDERS,
  shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
  verticalAlign: o.vAlign, margins: o.margins,
});

// ---- banner: logo | club name, number, theme (white on burgundy) ----
const banner = new Table({
  width: { size: WIDTH, type: WidthType.DXA },
  columnWidths: [2200, WIDTH - 2200],
  borders: NO_BORDERS,
  rows: [new TableRow({
    height: { value: 1700, rule: 'atLeast' },
    children: [
      cell([para(new ImageRun({ data: LOGO, type: 'png', transformation: { width: 95, height: 79 } }), { align: AlignmentType.CENTER })],
        2200, { fill: MAIN, vAlign: VerticalAlign.CENTER }),
      cell([
        para([run('{{分會名稱}} {{分會編號}}', { size: 34, bold: true, color: 'FFFFFF' })], { align: AlignmentType.RIGHT }),
        para([run('{{分會英文名稱}}', { size: 18, color: 'FFFFFF' })], { align: AlignmentType.RIGHT, before: 40 }),
        para([run('{{例會主題}}', { size: 22, color: 'FFFFFF' })], { align: AlignmentType.RIGHT, before: 80 }),
      ], WIDTH - 2200, { fill: DARK, vAlign: VerticalAlign.CENTER, margins: { right: 300 } }),
    ],
  })],
});

// ---- sidebar ----
const label = (text) => para(run(text, { bold: true, color: MAIN }), { before: 120 });
const line = (text, o = {}) => para(run(text, o));
const officers = ['會長', '教育副會長', '會員副會長', '公關副會長', '秘書', '財務長', '事務長']
  .flatMap((t) => [label(t), line(`{{${t}}}`)]);
const sidebar = [
  line('{{例會日期}}', { bold: true, size: 20 }),
  line('第 {{例會次數}} 次例會'),
  ...officers,
  para(run('{{例會時間說明}}'), { before: 240 }),
  line('{{時間}}'),
  line('{{地點}}'),
  line('{{分會網站}}', { color: '1A4FA0' }),
  para(run('Toastmasters International'), { before: 240 }),
  line('www.toastmasters.org', { color: '1A4FA0' }),
  para(run('分會使命', { bold: true }), { before: 240 }),
  line('我們提供一個支持且正向的學習環境，讓會員培養溝通與領導能力，從而建立更強的自信並獲得個人成長。'),
];

// ---- agenda table: time | item | who ----
const row = (time, item, who, o = {}) => new TableRow({
  children: [
    cell([para(run(time, { bold: true }), { before: o.gap ? 160 : 20 })], COL.time),
    cell([para(run(item, { bold: o.head }), { before: o.gap ? 160 : 20 })], COL.item, { margins: { left: o.head ? 0 : 200 } }),
    cell([para(run(who), { before: o.gap ? 160 : 20 })], COL.who),
  ],
});
const head = (time, item, who = '') => row(time, item, who, { head: true, gap: true });
const agenda = new Table({
  width: { size: COL.time + COL.item + COL.who, type: WidthType.DXA },
  columnWidths: [COL.time, COL.item, COL.who],
  borders: NO_BORDERS,
  rows: [
    head('{{報到時間}}', '報到 & 交誼', '{{接待}}'),
    head('{{開場時間}}', '宣布例會開始', '{{宣布開會}}'),
    row('', '會長致歡迎詞', '{{會長致詞}}'),
    row('', '總主持人', '{{總主持人}}'),
    row('', '計時員', '{{計時員}}'),
    row('', '贅語記錄員', '{{贅語記錄員}}'),
    head('{{#多元單元}}{{時間}}', '多元單元', '{{主持人}}{{/多元單元}}'),
    head('{{演講時間}}', '指定演講', '{{總主持人}}'),
    row('', '{{#演講}}{{講題}}（{{時長}}）', '{{講者}}{{/演講}}'),
    head('{{合照時間}}', '大合照', '所有與會者'),
    head('', '休息 & 交誼時間（{{休息分鐘}} 分鐘）'),
    head('{{即席時間}}', '即席問答', '{{即席主持人}}'),
    head('{{講評時間}}', '講評時間', '{{總講評}}'),
    row('', '{{#講評員}}個別講評員 #{{序號}}', '{{姓名}}{{/講評員}}'),
    row('', '計時員報告', '{{計時員}}'),
    row('', '贅語記錄員報告', '{{贅語記錄員}}'),
    row('', '語言講評', '{{語言講評}}'),
    row('', '總講評', '{{總講評}}'),
    row('', '{{#講評員講評}}講評員講評 #{{序號}}', '{{姓名}}{{/講評員講評}}'),
    head('{{閉幕時間}}', '總主持人', '{{總主持人}}'),
    row('', '贈感謝狀', '{{頒獎人}}'),
    head('{{分享時間}}', '會後分享 & 來賓回饋', '{{分享回饋}}'),
  ],
});

// ---- body: sidebar | agenda, split by a vertical rule ----
const body = new Table({
  width: { size: WIDTH, type: WidthType.DXA },
  columnWidths: [SIDE_W, AGENDA_W],
  borders: NO_BORDERS,
  rows: [new TableRow({
    children: [
      cell(sidebar, SIDE_W, {
        borders: { ...NO_BORDERS, right: { style: BorderStyle.SINGLE, size: 6, color: '000000' } },
        margins: { top: 200, right: 200 },
      }),
      cell([agenda, para(run('——— 會議圓滿 ———', { bold: true, color: MAIN }), { align: AlignmentType.CENTER, before: 400 })],
        AGENDA_W, { margins: { top: 200, left: 200 } }),
    ],
  })],
});

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 18 } } } },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
    // Word ends a document with a paragraph after the last table; kept tiny so
    // it alone cannot push a full agenda onto a second page.
    children: [banner, para(run(''), { after: 0 }), body, para(run('', { size: 2 }))],
  }],
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
// How tall the agenda table may be, in mm: it is marked {{填滿:…}} so a
// downloaded meeting's rows share that height and reach the page bottom
// (lib/wordFit.js), with a margin so a long meeting keeps to one page.
const AGENDA_FILL_MM = 210;
fs.writeFileSync(OUT, markFillTable(await Packer.toBuffer(doc), '{{報到時間}}', AGENDA_FILL_MM));
console.log('wrote', path.relative(root, OUT));
