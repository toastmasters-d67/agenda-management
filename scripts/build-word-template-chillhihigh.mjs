// Builds scripts/word-templates/chillhihigh.docx — a Word template in the
// Chill Hi High agenda's layout (lib/agendaTemplates.js `chillhihigh`, styles
// under `.tmpl-chillhihigh` in agenda.css). Page 1: logo and club info, the
// burgundy theme band, the agenda with its green / yellow / red signal columns,
// the closing line and the Meeting Roles glossary. Page 2: the promo back-page
// (hero image, upcoming meetings, join graphic, QR codes).
//
// It isn't served by the app: the club uploads it as its own template
// (分會設定 → Word 匯出範本), like any club-made .docx. Pictures are the bundled
// Chill Hi High assets (public/media/ChillHiHigh); marks can't carry pictures,
// so a club that changes its logo / QR / page-2 images rebuilds and re-uploads.
//
//   node scripts/build-word-template-chillhihigh.mjs
//
// Marks are {{…}} (WORD_FIELDS / WORD_LOOPS in lib/wordExport.js). A loop's
// open and close marks sit in the same table row, so the row repeats; a
// section whose marks stand in paragraphs of their own drops those paragraphs
// when it's empty (an unset slogan leaves no blank line).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlignmentType, BorderStyle, Document, ImageRun, Packer, PageBreak, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, VerticalAlign, VerticalMergeType, WidthType,
} from 'docx';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'scripts/word-templates/chillhihigh.docx');
const media = (f) => fs.readFileSync(path.join(root, 'public/media/ChillHiHigh', f));
const LOGO = media('chh-logo.png');
const HERO = media('chh-p2-1.png');
const IMG2 = media('chh-p2-2.png');
const QRS = [['Facebook', media('chh-facebook.png')], ['Instagram', media('chh-instagram.png')], ['LINE', media('chh-line.png')]];

// Colours from .tmpl-chillhihigh.
const BLUE = '1D3A8A';
const NAVY = '1E3A5F';
const WINE = '7B1F2B';
const INK = '1F2937';
const MUTED = '374151';
const GRID = 'CBD5E1';
const HEAD_BG = 'F1F5F9';
const SECTION_BG = 'FDF1D6';
const BAND_BG = 'E5E7EB';
const SIG = { g: ['DCFCE7', '15803D'], y: ['FEF9C3', 'A16207'], r: ['FEE2E2', 'B91C1C'] };
const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft JhengHei' };

// A4 portrait, 8 mm margins → 194 mm, the agenda page's width.
const mm = (n) => Math.round(n * 56.693);
const PAGE_W = 11906;
const MARGIN = mm(8);
const WIDTH = PAGE_W - MARGIN * 2;
const COL = { time: mm(12), dur: mm(13), host: mm(38), sig: mm(11) };
COL.ag = WIDTH - COL.time - COL.dur - COL.host - COL.sig * 3;
const C = AlignmentType.CENTER;

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
const line = (color = GRID) => ({ style: BorderStyle.SINGLE, size: 4, color });
const BOX = { top: line(), bottom: line(), left: line(), right: line() };

// Sizes are half-points (16 = 8 pt).
const run = (text, o = {}) => new TextRun({
  text, font: FONT, size: o.size || 16, bold: o.bold, italics: o.italic, color: o.color || INK,
});
const para = (children, o = {}) => new Paragraph({
  children: Array.isArray(children) ? children : [children],
  alignment: o.align, spacing: { before: o.before || 0, after: o.after || 0, line: o.line },
});
const cell = (children, width, o = {}) => new TableCell({
  children, width: { size: width, type: WidthType.DXA }, borders: o.borders || NO_BORDERS,
  shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
  verticalAlign: o.vAlign || VerticalAlign.CENTER, columnSpan: o.span, verticalMerge: o.merge,
  margins: o.margins || { top: 15, bottom: 15, left: 80, right: 80 },
});
const table = (widths, rows, o = {}) => new Table({
  width: { size: widths.reduce((s, w) => s + w, 0), type: WidthType.DXA },
  columnWidths: widths, borders: o.borders || NO_BORDERS, rows,
});
// A section that shows only when `mark` has a value: open and close marks in
// paragraphs of their own, so an empty one leaves nothing behind.
const when = (mark, ...paras) => [para(run(`{{#${mark}}}`)), ...paras, para(run(`{{/${mark}}}`))];

// PNG size from its IHDR chunk, to keep pictures in proportion.
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
// Scale into a box given in points (Word's image transformation unit is px at 96 dpi).
const fit = (buf, maxWmm, maxHmm) => {
  const { w, h } = pngSize(buf);
  const px = (n) => n * 96 / 25.4;
  const k = Math.min(px(maxWmm) / w, px(maxHmm) / h);
  return new ImageRun({ data: buf, type: 'png', transformation: { width: Math.round(w * k), height: Math.round(h * k) } });
};

// ================= PAGE 1 =================
const info = (text) => para(run(text, { size: 16, color: MUTED }), { line: 240 });
const header = table([mm(30), WIDTH - mm(30)], [new TableRow({
  children: [
    cell([para(fit(LOGO, 26, 26))], mm(30), { vAlign: VerticalAlign.TOP, margins: { top: 0, bottom: 0, left: 0, right: 100 } }),
    cell([
      para([run('{{分會英文名稱}}', { size: 28, bold: true, color: BLUE }), run(' {{分會名稱}}', { size: 28, color: BLUE })]),
      ...when('標語', para(run('{{標語}}', { size: 20, italic: true, color: MUTED }), { before: 40, after: 60 })),
      info('時間 : {{例會日期}} {{時間}}'),
      info('地點 : {{地點}}'),
      ...when('交通', info('交通 : {{交通}}')),
      ...when('入場費', info('入場費 : {{入場費}}')),
    ], WIDTH - mm(30), { vAlign: VerticalAlign.TOP, margins: { top: 0, bottom: 0, left: 0, right: 0 } }),
  ],
})]);

const wineBand = (paras) => table([WIDTH], [new TableRow({
  children: [cell(paras, WIDTH, { fill: WINE, margins: { top: 60, bottom: 60, left: 200, right: 200 } })],
})]);
const theme = wineBand([
  para(run('會議主題 : {{例會主題}}', { bold: true, color: 'FFFFFF' }), { align: C }),
  ...when('即席題目', para(run('主題題目 : {{即席題目}}', { size: 15, color: 'FFFFFF' }), { align: C, before: 40 })),
]);

// ---- agenda: time | minutes | item | host | green | yellow | red ----
const txt = (text, o = {}) => para(run(text, { size: o.size || 16, bold: o.bold, color: o.color }), { align: o.align, line: 228 });
const sigCells = (cat, fill, close = '') => ['g', 'y', 'r'].map((c, i) => {
  const mark = cat ? `{{${cat}${['綠牌', '黃牌', '紅牌'][i]}}}` : '';
  return cell([txt(`${mark}${i === 2 ? close : ''}`, { bold: true, align: C, color: SIG[c][1] })], COL.sig,
    { borders: BOX, fill: cat ? SIG[c][0] : fill });
});
// One agenda row. `open` / `close` wrap the row in a loop (row repeats).
const row = (time, dur, item, host, o = {}) => new TableRow({
  children: [
    cell([txt(`${o.open || ''}${time}`, { align: C, color: BLUE })], COL.time, { borders: BOX, fill: o.fill }),
    cell([txt(dur, { align: C, color: '475569', bold: o.bold })], COL.dur, { borders: BOX, fill: o.fill }),
    cell(Array.isArray(item) ? item : [txt(item, { bold: o.bold })], COL.ag, { borders: BOX, fill: o.fill }),
    cell([txt(host, { bold: o.bold })], COL.host, { borders: BOX, fill: o.fill }),
    ...sigCells(o.sig, o.fill, o.close),
  ],
});
const section = (time, dur, item, host, o = {}) => row(time, dur, item, host, { ...o, bold: true, fill: SECTION_BG });
const band = (text) => new TableRow({
  children: [cell([txt(text, { bold: true, align: C, color: MUTED })], WIDTH, { span: 7, borders: BOX, fill: BAND_BG })],
});
const th = (text, o = {}) => cell([txt(text, { bold: true, align: C, size: 15, color: o.color || '334155' })], o.width,
  { borders: BOX, fill: o.fill || HEAD_BG, merge: o.merge, span: o.span });
const R = VerticalMergeType.RESTART;
const K = VerticalMergeType.CONTINUE;

// "A / B" with the slash only when both are set.
const pair = (a, b) => `{{${a}}}{{#${a}}}{{#${b}}} / {{/${b}}}{{/${a}}}{{${b}}}`;

const agenda = table([COL.time, COL.dur, COL.ag, COL.host, COL.sig, COL.sig, COL.sig], [
  new TableRow({
    tableHeader: true,
    children: [
      th('時間', { width: COL.time, merge: R }), th('時長(分)', { width: COL.dur, merge: R }),
      th('議程', { width: COL.ag, merge: R }), th('主持', { width: COL.host, merge: R }),
      th('時間管理', { width: COL.sig * 3, span: 3 }),
    ],
  }),
  new TableRow({
    tableHeader: true,
    children: [
      th('', { width: COL.time, merge: K }), th('', { width: COL.dur, merge: K }),
      th('', { width: COL.ag, merge: K }), th('', { width: COL.host, merge: K }),
      th('綠牌', { width: COL.sig, fill: SIG.g[0], color: SIG.g[1] }),
      th('黃牌', { width: COL.sig, fill: SIG.y[0], color: SIG.y[1] }),
      th('紅牌', { width: COL.sig, fill: SIG.r[0], color: SIG.r[1] }),
    ],
  }),
  row('{{報到時間}}', '{{報到分鐘}}', '報到 Registration', '{{接待}}'),
  row('{{開場時間}}', '', '致歡迎詞 Opening Remarks', '{{會長致詞}}'),
  row('', '', '總主持人上半場開場 TME Opening - First Half', '{{總主持人}}'),
  row('', '', '計時員介紹 Timer Introduction', '{{計時員}}'),
  row('', '', '贅字/笑聲記錄員介紹 Ah/Ha Counter Introduction', '{{贅語記錄員}}'),
  row('', '', '白板記錄員 Board Writer / 攝影師 Photographer', pair('板書', '攝影')),
  // Shown only when the meeting has a variety session.
  section('{{時間}}', '{{分鐘}}', '暖場活動 Variety Session', '{{主持人}}', { sig: '多元單元', open: '{{#多元單元}}', close: '{{/多元單元}}' }),
  section('{{演講時間}}', '{{演講分鐘}}', '指定演講 Prepared Speeches', '{{總主持人}}'),
  row('', '{{時長}}', [
    txt('{{講題}}'),
    ...when('專案', txt(' [{{專案}}]')),
  ], '{{講者}}', { sig: '指定演講', open: '{{#演講}}', close: '{{/演講}}' }),
  row('', '', "計時員報告 Timer's Report", '{{計時員}}'),
  row('', '', "贅字/笑聲記錄員報告 Ah/Ha Counter's Report", '{{贅語記錄員}}'),
  row('', '', '來賓介紹 Guest Introduction', '{{總主持人}}'),
  band('團體照、中場休息 Group Photo & Intermission'),
  row('{{即席時間}}', '', '總主持人下半場開場 TME Opening - Second Half', '{{總主持人}}'),
  section('', '{{即席分鐘}}', [para([
    run('小組即席問答 Group Table Topics Session', { bold: true }),
    run('{{#即席講者時間}} (講者: {{即席講者時間}}){{/即席講者時間}}', { bold: true, color: WINE }),
  ], { line: 228 })], '{{即席主持人}}', { sig: '即席' }),
  section('{{講評時間}}', '{{講評分鐘}}', '講評環節 Evaluation Session', '{{總講評}}'),
  row('', '', '{{#國語}}國語講評員 Mandarin Evaluator{{/國語}}{{^國語}}英語講評員 English Evaluator{{/國語}}', '{{姓名}}',
    { sig: '個別講評', open: '{{#講評員}}', close: '{{/講評員}}' }),
  row('', '', "計時員報告 Timer's Report", '{{計時員}}'),
  row('', '', "贅字/笑聲記錄員報告 Ah/Ha Counter's Report", '{{贅語記錄員}}'),
  row('', '', '語言/幽默講評 Language/Humor Evaluation', '{{語言講評}}', { sig: '語言講評' }),
  row('{{閉幕時間}}', '', '總講評 General Evaluation', '{{總講評}}', { sig: '總講評' }),
  row('', '', "講評員講評 Evaluator's Evaluator", '{{姓名}}', { sig: '個別講評', open: '{{#講評員講評}}', close: '{{/講評員講評}}' }),
  row('{{分享時間}}', '{{分享分鐘}}', '來賓回饋與結語 Guest Feedback & Closing Remarks', pair('頒獎人', '分享回饋')),
], { borders: { top: line(), bottom: line(), left: line(), right: line(), insideHorizontal: line(), insideVertical: line() } });

const closing = wineBand([para(run('{{結尾句}}{{^結尾句}}活動結束{{/結尾句}}', { bold: true, color: 'FFFFFF' }), { align: C })]);

// ---- Meeting Roles glossary: 3 per row, title | description ----
const ROLES = [
  ['總主持人', 'Toastmaster of the Evening (TME)', '決定例會主題，並主持及串接整場會議流程與互動'],
  ['計時員', 'Timer', '協助講者在指定時間內完成演講'],
  ['贅字/笑聲記錄員', 'Ah/Ha Counter', '紀錄講者的冗言贅字及觀眾笑聲次數'],
  ['暖場活動主持人', 'Variety Session Master', '活絡例會氣氛，鼓勵參與者互相認識'],
  ['備稿演講者', 'Prepared Speech Speaker', '依循學習途徑 (Pathways) 的專案目標，準備 5-7 分鐘演講'],
  ['小組即席問答主持人', 'Group Table Topics Master', '準備 4-6 題目，帶領小組討論，並邀請成員上台分享 1-2 分鐘的答案'],
  ['總講評', 'General Evaluator', '介紹例會後半場的講評員，並提供整場會議總體評價'],
  ['個別講評員', 'Individual Evaluator', '針對備稿演講者提供 2-3 分鐘講評、鼓勵與改進建議'],
  ['語言/幽默講評', 'Language/Humor Evaluator', '整理全場用語、文法、佳句與幽默設計'],
];
const GL_T = Math.round(WIDTH / 3 * 0.38);
const GL_D = Math.round(WIDTH / 3) - GL_T;
const glSmall = (text, o = {}) => para(run(text, { size: 13, bold: o.bold, color: o.color }), { line: 216 });
const RULE = { top: NONE, left: NONE, bottom: line('E5E7EB'), right: NONE };
const glossaryRows = [];
for (let i = 0; i < ROLES.length; i += 3) {
  glossaryRows.push(new TableRow({
    children: ROLES.slice(i, i + 3).flatMap(([zh, en, desc], j) => [
      cell([glSmall(zh, { bold: true }), glSmall(en, { bold: true })], GL_T, { borders: RULE, vAlign: VerticalAlign.TOP }),
      cell([glSmall(desc, { color: '4B5563' })], GL_D, {
        borders: { ...RULE, right: j < 2 ? line('E5E7EB') : NONE }, vAlign: VerticalAlign.TOP,
      }),
    ]),
  }));
}
const glossary = table([GL_T, GL_D, GL_T, GL_D, GL_T, GL_D], [
  new TableRow({
    children: [cell([txt('例會角色 Meeting Roles', { bold: true, align: C, color: '334155' })], GL_T * 3 + GL_D * 3,
      { span: 6, fill: HEAD_BG, borders: { bottom: line(), top: NONE, left: NONE, right: NONE } })],
  }),
  ...glossaryRows,
], { borders: { top: line(), bottom: line(), left: line(), right: line(), insideHorizontal: NONE, insideVertical: NONE } });

// ================= PAGE 2 — promo back-page =================
const navyTitle = (text) => table([WIDTH], [new TableRow({
  children: [cell([para(run(text, { size: 21, color: 'FFFFFF' }))], WIDTH, { fill: NAVY, margins: { top: 60, bottom: 60, left: 200, right: 200 } })],
})]);
const QR_W = Math.floor(WIDTH / QRS.length);
const qrRow = table(QRS.map(() => QR_W), [new TableRow({
  children: QRS.map(([label, buf]) => cell([
    para(run(label, { size: 24, bold: true, color: NAVY }), { align: C, after: 80 }),
    para(fit(buf, 32, 32), { align: C }),
  ], QR_W, { vAlign: VerticalAlign.TOP })),
})]);

const gap = (pt) => para(run('', { size: 2 }), { after: pt * 20 });
const page2 = [
  new Paragraph({ children: [new PageBreak()] }),
  para(fit(HERO, 194, 75), { align: C }),
  gap(6),
  // Each line only when the club has set it.
  ...when('近期例會',
    navyTitle('未來例會及活動時間 Upcoming Meetings & Events'),
    para([run('例會', { size: 21, color: 'B45309' }), run('：{{近期例會}}', { size: 21 })], { before: 60 }),
  ),
  ...when('特別活動', para([run('特別活動', { size: 21, color: 'B45309' }), run('：{{特別活動}}', { size: 21 })], { before: 40 })),
  gap(6),
  para(fit(IMG2, 194, 112), { align: C }),
  gap(6),
  qrRow,
];

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 16, color: INK } } } },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
    children: [header, gap(4), theme, gap(4), agenda, gap(4), closing, gap(3), glossary, ...page2],
  }],
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, await Packer.toBuffer(doc));
console.log('wrote', path.relative(root, OUT));
