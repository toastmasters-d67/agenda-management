// Builds scripts/word-templates/entrepreneur.docx (or, with `en`,
// entrepreneur-en.docx for English meetings) — a Word template in the
// Entrepreneur agenda's layout (lib/agendaTemplates.js `entrepreneur`, styles
// under `.tmpl-entrepreneur` in agenda.css): header with logo, club names and
// a theme-image box, theme row, mission box, the agenda table with its time /
// duration columns, and the Pathways · time rules · QR panel on the right.
// The theme-image box is a grey placeholder picture with alt text {{主題圖片}}
// (WORD_PICTURES): the meeting's theme image replaces it when downloaded.
//
// It isn't served by the app: the club uploads it as its own template
// (分會設定 → Word 匯出範本), like any club-made .docx.
//
//   node scripts/build-word-template-entrepreneur.mjs [en]
//
// Marks are {{…}} (WORD_FIELDS / WORD_LOOPS in lib/wordExport.js). A loop's
// open and close marks sit in the same table row, so the row repeats; a block's
// time cell is merged down over its rows, loop rows included.
//
// The agenda table is marked {{填滿:AGENDA_FILL_MM}} (its alt-text title):
// when a meeting is downloaded, that height is shared out over the rows it
// actually has (lib/wordFit.js), so the page is full whether there are two
// speeches or four — like the web agenda, which stretches to the page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { markFillTable } from './mark-fill-table.mjs';
import {
  AlignmentType, BorderStyle, Document, ImageRun, Packer, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, VerticalAlign, VerticalMergeType, WidthType,
} from 'docx';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EN = process.argv[2] === 'en';
const OUT = path.join(root, `scripts/word-templates/entrepreneur${EN ? '-en' : ''}.docx`);

// The printed labels, as on the web agenda (TRANSLATIONS in app/agenda/page.js).
const T = EN ? {
  founded: 'Founded Since:', fee: 'Fee', date: 'Date',
  schedule: '{{例會時間說明英文}}{{^例會時間說明英文}}Meeting on every 1st (中文) and 3rd (English) Tuesday evening{{/例會時間說明英文}}',
  themeLabel: 'Meeting  Theme:', meetingNo: 'Meeting No.{{例會次數}}',
  missionTitle: '— Mission of Toastmasters Club —',
  missionText: '"We provide a supportive and positive learning experience in which members are empowered to develop communication and leadership skills, resulting in greater self-confidence and personal growth."',
  thTime: 'Time', thAgenda: 'Agenda (Program)', thTaker: 'Assignment Taker',
  reception: 'Reception & Social Gathering',
  opening: ["1' Calling Meeting to Order", "2' Welcome Guests & TME", "3' Toastmaster of The Evening",
    "2' Timer｜Meeting Rules Explanation", "2' Ah-counter｜Meeting Rules Explanation"],
  variety: 'Variety Session', prepared: 'Prepared Speech', photo: 'Group Photo', all: 'All Participants',
  intermission: '— Intermission & Social Time ({{休息分鐘}} min) —', topics: 'Table Topics Session',
  evaluation: 'Evaluation Session', evaluator: 'Individual Evaluator for Speaker #{{序號}}',
  timerReport: 'Timer Report', ahReport: 'Ah-counter Report', langEval: 'Language Evaluation',
  generalEval: 'General Evaluation', evalEval: "Evaluator's Evaluator #{{序號}}",
  tmeClosing: 'Toastmaster of the Evening', awards: 'Awards Presentation', sharing: 'Sharing & Feedback',
  pathways: '⏱ Pathways', pathwayName: '{{英文名稱}}', timeRules: 'Time Rules',
  trRows: ['Prepared Speech', 'Table Topic', 'Evaluator', 'LE&GE'],
  fb: 'Follow us on FB!', line: 'Connect us with LINE@', adjournment: '— Meeting Adjournment —',
} : {
  founded: '成立日期:', fee: '入場費', date: '時間',
  schedule: '{{例會時間說明}}{{^例會時間說明}}會議日期為每月第 1 個星期二 (中文) / 第 3 個星期二 (English){{/例會時間說明}}',
  themeLabel: '會議主題：', meetingNo: '第 {{例會次數}} 次例會',
  missionTitle: '——— 演講會宗旨 ———',
  missionText: '訓練溝通及領導能力，強調終身學習。參加國際演講協會是增進溝通技巧的最佳方法，除了大幅增加公開演講的自信外，在這裡所學到的領導技巧，更是您邁向成功之路的必備基石。',
  thTime: '時間', thAgenda: '議程表', thTaker: '角色擔任',
  reception: '報到 & 交誼',
  opening: ["1' 宣布例會開始－領導宣讀宣言", "2' 會長致歡迎詞", "3' 總主持人", "2' 計時員", "2' 贅語記錄員"],
  variety: '多元單元', prepared: '指定演講', photo: '大合照', all: '所有與會者',
  intermission: '——— 休息 & 交誼時間（{{休息分鐘}} 分鐘）———', topics: '即席問答',
  evaluation: '講評時間', evaluator: '個別講評員 #{{序號}}',
  timerReport: '計時員報告', ahReport: '贅語記錄員報告', langEval: '語言講評',
  generalEval: '總講評', evalEval: '講評員講評 #{{序號}}',
  tmeClosing: '總主持人', awards: '贈感謝狀', sharing: '會後分享 & 來賓回饋',
  pathways: '⏱ 學習路徑', pathwayName: '{{名稱}}', timeRules: '時間規則',
  trRows: ['指定演講', '即席問答', '個別講評', '語言&總講評'],
  fb: '追蹤我們的 FB！', line: '加入企業家 LINE 群組！', adjournment: '——— 會議圓滿 ———',
};
const media = (f) => fs.readFileSync(path.join(root, 'public/media', f));
const LOGO = media('toastmasters_logo.png');
const FB_QR = media('Entrepreneur/FacebookQR.png');
const LINE_QR = media('Entrepreneur/LINEQR.png');

// Colours from .tmpl-entrepreneur.
const GREEN = 'BDD5A0';
const GREEN_LINE = '9CBA7A';
const BLUE = 'C2D8EC';
const GREY_ROW = 'F5F5F5';
const LINE = '777777';
const TC = { g: '5CB85C', y: 'F0AD4E', r: 'D9534F' };
// Noto Sans CJK TC: the font the server lays PDF / JPG out with (/api/word-render),
// so they match this file. A PC without it shows its own substitute in Word.
const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Noto Sans CJK TC' };

// A4 portrait with 16 mm side margins → 178 mm, the agenda's own width.
const mm = (n) => Math.round(n * 56.693);
const PAGE_W = 11906;
const MARGIN_X = mm(16);
const MARGIN_Y = mm(10);
const WIDTH = PAGE_W - MARGIN_X * 2;
const COL = { time: mm(12), secdur: mm(7), dur: mm(11), agenda: mm(57), taker: mm(43) };
const AGENDA_W = COL.time + COL.secdur + COL.dur + COL.agenda + COL.taker;
const PANEL_W = WIDTH - AGENDA_W;

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
const thin = (color = LINE) => ({ style: BorderStyle.SINGLE, size: 3, color });
const BOX = (color) => ({ top: thin(color), bottom: thin(color), left: thin(color), right: thin(color) });

// Sizes are half-points (16 = 8 pt).
const run = (text, o = {}) => new TextRun({
  text, font: FONT, size: o.size || 16, bold: o.bold, italics: o.italic, color: o.color,
});
const para = (children, o = {}) => new Paragraph({
  children: Array.isArray(children) ? children : [children],
  alignment: o.align, spacing: { before: o.before || 0, after: o.after || 0, line: o.line },
});
const cell = (children, width, o = {}) => new TableCell({
  children, width: { size: width, type: WidthType.DXA }, borders: o.borders || NO_BORDERS,
  shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
  verticalAlign: o.vAlign || VerticalAlign.CENTER, columnSpan: o.span, verticalMerge: o.merge,
  margins: o.margins || { top: 30, bottom: 30, left: 60, right: 60 },
});
const image = (data, w, h, altText) => new ImageRun({ data, type: 'png', transformation: { width: w, height: h }, altText });

// A one-pixel PNG of `hex`, stretched to fill the theme-image placeholder.
function solidPng(hex) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const pixel = Buffer.from([0, ...Buffer.from(hex, 'hex')]); // filter byte + RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(pixel)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Theme-image box, as on the agenda (38 mm wide, both header rows tall).
const px = (n) => Math.round(n * 96 / 25.4);
const THEME_IMG = image(solidPng('888888'), px(38), px(40),
  { name: '主題圖片', title: '主題圖片', description: '{{主題圖片}}' });

// ---- header: logo | names | theme image, then meta lines under logo / names ----
const HEAD_W = { logo: mm(26), img: mm(38) };
HEAD_W.names = WIDTH - HEAD_W.logo - HEAD_W.img;
const meta = (text, o = {}) => para(run(text, { size: 14, ...o }), { line: 260 });
// The rule under the header sits on the meta cells (a table's own bottom
// border is dropped by Word when the last row has merged cells).
const RULE = { ...NO_BORDERS, bottom: { style: BorderStyle.SINGLE, size: 12, color: '000000' } };
const metaCell = (children, width) => cell(children, width,
  { vAlign: VerticalAlign.TOP, borders: RULE, margins: { top: 40, bottom: 100, left: 60, right: 60 } });
const header = new Table({
  width: { size: WIDTH, type: WidthType.DXA },
  columnWidths: [HEAD_W.logo, HEAD_W.names, HEAD_W.img],
  borders: NO_BORDERS,
  rows: [
    new TableRow({
      children: [
        cell([para(image(LOGO, 80, 67), { align: AlignmentType.CENTER })], HEAD_W.logo),
        cell([
          para(run('{{分會名稱}}', { size: 34, bold: true }), { align: AlignmentType.CENTER }),
          para(run('{{分會英文名稱}}', { size: 24, bold: true }), { align: AlignmentType.CENTER, before: 20 }),
        ], HEAD_W.names),
        cell([para(THEME_IMG, { align: AlignmentType.CENTER })],
          HEAD_W.img, { merge: VerticalMergeType.RESTART, margins: { top: 0, bottom: 0, left: 0, right: 0 } }),
      ],
    }),
    new TableRow({
      children: [
        metaCell([
          meta('{{分會編號}}{{^分會編號}}No. 4069930{{/分會編號}}'),
          meta(T.founded),
          meta('{{成立日}}{{^成立日}}2014.06.29{{/成立日}}'),
          meta(''),
          meta(`${T.fee} : {{入場費}}`),
        ], HEAD_W.logo),
        metaCell([
          meta(`${T.date} : {{例會日期}} ｜ {{時間}}`, { bold: true }),
          meta(T.schedule),
          meta('{{地點}}'),
        ], HEAD_W.names),
        cell([para(run(''))], HEAD_W.img, { merge: VerticalMergeType.CONTINUE, borders: RULE }),
      ],
    }),
  ],
});

// ---- theme row ----
const THEME_W = { label: mm(30), no: mm(30) };
THEME_W.value = WIDTH - THEME_W.label - THEME_W.no;
const themeRow = new Table({
  width: { size: WIDTH, type: WidthType.DXA },
  columnWidths: [THEME_W.label, THEME_W.value, THEME_W.no],
  borders: NO_BORDERS,
  rows: [new TableRow({
    children: [
      cell([para(run(T.themeLabel, { size: 15, italic: true }))], THEME_W.label),
      cell([para(run('{{例會主題}}', { size: 34, bold: true, italic: true }), { align: AlignmentType.CENTER })], THEME_W.value),
      cell([para(run(T.meetingNo, { size: 14 }), { align: AlignmentType.RIGHT })], THEME_W.no),
    ],
  })],
});

// ---- mission ----
const mission = new Table({
  width: { size: WIDTH, type: WidthType.DXA },
  columnWidths: [WIDTH],
  borders: NO_BORDERS,
  rows: [new TableRow({
    children: [cell([
      para(run(T.missionTitle, { size: 15, bold: true }), { align: AlignmentType.CENTER }),
      para(run(T.missionText, { size: 14 }),
        { align: AlignmentType.CENTER, before: 20 }),
    ], WIDTH, { fill: BLUE, margins: { top: 80, bottom: 80, left: 110, right: 110 } })],
  })],
});

// ---- agenda table: time | section total | duration | item | who ----
const B = BOX(LINE);
const txt = (text, o = {}) => para(run(text, { size: o.size || 16, bold: o.bold, italic: o.italic }), { align: o.align, line: 280 });
const C = AlignmentType.CENTER;
const timeCell = (text, merge, fill) => cell([txt(text, { bold: true, size: 18, align: C })], COL.time, { borders: B, merge, fill });
const durCell = (text, o = {}) => cell([txt(text, { align: C, bold: o.bold })], o.width || COL.dur, { borders: B, span: o.span, merge: o.merge, fill: o.fill });
const itemCell = (text, o = {}) => cell([txt(text, { bold: o.bold, align: o.bold ? C : undefined })], o.width || COL.agenda, { borders: B, span: o.span, fill: o.fill });
const whoCell = (text, fill) => cell([txt(text)], COL.taker, { borders: B, fill });
const DUR2 = COL.secdur + COL.dur;

// One-line block: time | minutes (over both duration columns) | item | who.
const single = (time, mins, item, who, o = {}) => new TableRow({
  children: [
    timeCell(time, undefined, o.fill),
    durCell(mins, { span: 2, width: DUR2, fill: o.fill }),
    itemCell(item, { bold: o.bold, fill: o.fill }),
    whoCell(who, o.fill),
  ],
});
// A block whose time and minutes are merged down over `items` rows.
const merged = (time, mins, items) => items.map(([item, who], i) => new TableRow({
  children: [
    timeCell(i ? '' : time, i ? VerticalMergeType.CONTINUE : VerticalMergeType.RESTART),
    durCell(i ? '' : mins, { span: 2, width: DUR2, merge: i ? VerticalMergeType.CONTINUE : VerticalMergeType.RESTART }),
    itemCell(item),
    whoCell(who),
  ],
}));
// A section (speeches, evaluation): a green header row whose time and section
// total run down its rows; each row below has its own duration.
const sectionHead = (time, mins, title, who) => new TableRow({
  children: [
    timeCell(time, VerticalMergeType.RESTART, GREEN),
    durCell(mins, { width: COL.secdur, merge: VerticalMergeType.RESTART, bold: true, fill: GREEN }),
    itemCell(title, { span: 2, width: COL.dur + COL.agenda, bold: true, fill: GREEN }),
    whoCell(who, GREEN),
  ],
});
const sectionRow = (dur, item, who) => new TableRow({
  children: [
    timeCell('', VerticalMergeType.CONTINUE),
    durCell('', { width: COL.secdur, merge: VerticalMergeType.CONTINUE }),
    durCell(dur),
    itemCell(item),
    whoCell(who),
  ],
});
const fullRow = (text, o = {}) => new TableRow({
  children: [cell([txt(text, { align: C, bold: o.bold, italic: o.italic, size: 14 })], AGENDA_W, {
    span: 5, fill: o.fill, borders: o.borders || { top: thin(), bottom: thin(), left: NONE, right: NONE },
  })],
});

const agenda = new Table({
  width: { size: AGENDA_W, type: WidthType.DXA },
  columnWidths: [COL.time, COL.secdur, COL.dur, COL.agenda, COL.taker],
  rows: [
    new TableRow({
      tableHeader: true,
      children: [
        cell([txt(T.thTime, { bold: true, size: 15, align: C })], COL.time, { borders: BOX(GREEN_LINE), fill: GREEN }),
        cell([txt('')], DUR2, { borders: BOX(GREEN_LINE), fill: GREEN, span: 2 }),
        cell([txt(T.thAgenda, { bold: true, size: 15, align: C })], COL.agenda, { borders: BOX(GREEN_LINE), fill: GREEN }),
        cell([txt(T.thTaker, { bold: true, size: 15, align: C })], COL.taker, { borders: BOX(GREEN_LINE), fill: GREEN }),
      ],
    }),
    single('{{報到時間}}', "{{報到分鐘}}'", T.reception, '{{接待}}'),
    ...merged('{{開場時間}}', "{{開場分鐘}}'", [
      [T.opening[0], '{{宣布開會}}'],
      [T.opening[1], '{{會長致詞}}'],
      [T.opening[2], '{{總主持人}}'],
      [T.opening[3], '{{計時員}}'],
      [T.opening[4], '{{贅語記錄員}}'],
    ]),
    // Shown only when the meeting has a variety session.
    single('{{#多元單元}}{{時間}}', "{{分鐘}}'", T.variety, '{{主持人}}{{/多元單元}}', { bold: true, fill: GREEN }),
    sectionHead('{{演講時間}}', "{{演講分鐘}}'", T.prepared, '{{總主持人}}'),
    sectionRow('{{#演講}}{{時長}}', '{{講題}}  {{專案}}', '{{講者}}{{/演講}}'),
    single('{{合照時間}}', "{{合照分鐘}}'", T.photo, T.all),
    fullRow(T.intermission, { bold: true, italic: true, fill: GREY_ROW }),
    single('{{即席時間}}', "{{即席分鐘}}'", T.topics, '{{即席主持人}}', { bold: true, fill: GREEN }),
    fullRow('', { borders: { top: NONE, bottom: NONE, left: NONE, right: NONE } }),
    sectionHead('{{講評時間}}', "{{講評分鐘}}'", T.evaluation, '{{總講評}}'),
    sectionRow('{{#講評員}}{{時長}}', T.evaluator, '{{姓名}}{{/講評員}}'),
    sectionRow('{{計時員報告時長}}', T.timerReport, '{{計時員}}'),
    sectionRow('{{贅語報告時長}}', T.ahReport, '{{贅語記錄員}}'),
    sectionRow('{{語言講評時長}}', T.langEval, '{{語言講評}}'),
    sectionRow('{{總講評時長}}', T.generalEval, '{{總講評}}'),
    sectionRow('{{#講評員講評}}{{時長}}', T.evalEval, '{{姓名}}{{/講評員講評}}'),
    ...merged('{{閉幕時間}}', "{{閉幕分鐘}}'", [[T.tmeClosing, '{{總主持人}}'], [T.awards, '{{頒獎人}}']]),
    single('{{分享時間}}', "{{分享分鐘}}'", T.sharing, '{{分享回饋}}'),
  ],
});

// ---- right panel: Pathways list, time rules, QR codes ----
const PW = { code: mm(9) };
PW.name = PANEL_W - PW.code - 120;
const pathways = new Table({
  width: { size: PW.code + PW.name, type: WidthType.DXA },
  columnWidths: [PW.code, PW.name],
  borders: NO_BORDERS,
  rows: [new TableRow({
    children: [
      cell([para(run('{{#學習路徑}}{{代碼}}｜', { size: 18, bold: true, color: '444444' }), { align: AlignmentType.RIGHT })], PW.code,
        { margins: { top: 10, bottom: 10, left: 0, right: 0 } }),
      cell([para(run(`${T.pathwayName}{{/學習路徑}}`, { size: 17, italic: true, color: '444444' }))], PW.name,
        { margins: { top: 10, bottom: 10, left: 0, right: 0 } }),
    ],
  })],
});

const TR_W = [PANEL_W - 120 - mm(9) * 3, mm(9), mm(9), mm(9)];
const trCell = (text, i, fill) => cell([para(run(text, { size: 17, bold: !!fill, color: fill ? 'FFFFFF' : undefined }),
  { align: i ? C : AlignmentType.LEFT })], TR_W[i], { borders: BOX('AAAAAA'), fill });
const trRow = (label, a, b, c) => new TableRow({
  children: [trCell(label, 0), trCell(a, 1, TC.g), trCell(b, 2, TC.y), trCell(c, 3, TC.r)],
});
const timeRules = new Table({
  width: { size: TR_W.reduce((s, w) => s + w, 0), type: WidthType.DXA },
  columnWidths: TR_W,
  rows: [
    trRow('', 'min', 'ok', 'max'),
    trRow(T.trRows[0], '5', '6', '7'),
    trRow(T.trRows[1], '1', '1.5', '2'),
    trRow(T.trRows[2], '2', '2.5', '3'),
    trRow(T.trRows[3], '3', '4', '5'),
  ],
});

const qr = (data, label) => [
  para(image(data, 90, 90), { align: C, before: 100 }),
  para(run(label, { size: 14, bold: true }), { align: C, before: 20 }),
];

const panel = [
  para(run(T.pathways, { size: 15, bold: true }), { align: C, after: 60 }),
  pathways,
  para(run(T.timeRules, { size: 20, bold: true }), { align: C, before: 200, after: 60 }),
  timeRules,
  ...qr(FB_QR, T.fb),
  ...qr(LINE_QR, T.line),
];

// The agenda and the panel side by side; the panel's top lines up with the
// agenda header.
const body = new Table({
  width: { size: WIDTH, type: WidthType.DXA },
  columnWidths: [AGENDA_W, PANEL_W],
  borders: NO_BORDERS,
  rows: [new TableRow({
    children: [
      cell([agenda], AGENDA_W, { vAlign: VerticalAlign.TOP, margins: { top: 0, bottom: 0, left: 0, right: 0 } }),
      cell(panel, PANEL_W, {
        vAlign: VerticalAlign.TOP,
        borders: { top: thin(), bottom: thin(), right: thin(), left: { style: BorderStyle.SINGLE, size: 6, color: LINE } },
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
      }),
    ],
  })],
});

const footer = new Table({
  width: { size: WIDTH, type: WidthType.DXA },
  columnWidths: [WIDTH],
  borders: NO_BORDERS,
  rows: [new TableRow({
    children: [cell([para(run(T.adjournment, { size: 17, bold: true }), { align: C })], WIDTH,
      { fill: BLUE, margins: { top: 80, bottom: 80, left: 60, right: 60 } })],
  })],
});

const gap = (pt) => para(run('', { size: 2 }), { after: pt * 20 });
const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 16 } } } },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN_Y, bottom: MARGIN_Y, left: MARGIN_X, right: MARGIN_X } } },
    // Word ends a document with a paragraph after the last table; left at the
    // default size it alone can push a full agenda onto a second page.
    children: [header, gap(2), themeRow, gap(2), mission, gap(3), body, gap(3), footer,
      para(run('', { size: 2 }), { line: 20 })],
  }],
});

// How tall the agenda table may be, in mm: what is left of the A4 page once the
// header, theme row, mission box and footer are placed, less a margin so a
// long meeting still keeps to one page in Word and in LibreOffice (the PDF).
// English: rows estimate taller than Word draws them (Latin text wraps less
// than the estimate assumes), so a larger value reaches the same page bottom.
const AGENDA_FILL_MM = EN ? 160 : 148;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, markFillTable(await Packer.toBuffer(doc), '{{報到時間}}', AGENDA_FILL_MM));
console.log('wrote', path.relative(root, OUT));
