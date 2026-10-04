// ================================================================
// AGENDA TEMPLATE ENGINE
// ----------------------------------------------------------------
// Ported near-verbatim from the legacy templates.js — pure functions
// operating on (data, club, ctx), no DOM access, so this module needed
// no real changes beyond `export` and /media/ asset paths.
//
// Each template exposes:
//   key    — must match clubs.template_key
//   label  — shown in the club-management template picker
//   render(data, club, ctx) → HTML string (or string[] for multi-page) for #agendaPreview
//
// `club`  is the active club's branding object (or null → use defaults).
//         Field names are snake_case, matching the raw /api/clubs response
//         (name_zh, name_en, charter_no, founded_date, fee, logo_url,
//         fb_qr_url, line_qr_url, template_key, settings) — NOT the
//         camelCase convention /api/users uses.
// `ctx`   bundles shared helpers/globals injected by the agenda page
//         (buildRenderCtx), so templates never reach into page internals directly.
//
// To add a new layout: add an entry here + namespace its CSS under
// `.tmpl-<key>` in agenda.css. No page changes required.
// ================================================================

// ----------------------------------------------------------------
// Per-template default assets / values — the single source of truth for
// fallbacks used when a club hasn't uploaded/filled its own. Consumed by:
//   • this file's render()s                 (bundled image fallbacks)
//   • app/agenda/page.js applyClubImages / applyDefaultState
//   • app/club/page.js 版型設定 modal previews
// assetDefaults keys mirror the club fields (logo_url, fb_qr_url, …).
// ----------------------------------------------------------------
const STANDARD_ASSETS = {
  logo_url: '/media/toastmasters_logo.png',
  fb_qr_url: '/media/Entrepreneur/FacebookQR.png',
  line_qr_url: '/media/Entrepreneur/LINEQR.png',
};
const STANDARD_FIELD_DEFAULTS = {
  timeRange: '19:10 ~ 21:00',
  venue: 'Venue: 鑫喜文創｜台北市信義區忠孝東路五段71巷11弄25號1樓\n（捷運板南線：市政府站4號出口，走路3分鐘）',
};
// Example text shown (grayed out) in shared inputs before the user types —
// per-template so a club never sees another club's wording as the hint.
const STANDARD_PLACEHOLDERS = {
  meetingTheme: '-Urban Legend-',
  timeRange: '19:10 ~ 21:00',
  tableTopicsQuestion: '你覺得「最不適合開玩笑」的議題是什麼？…',
};

// ENTREPRENEUR — the live Entrepreneur club defaults. Deliberately a separate
// copy of the STANDARD_* values rather than an alias: `standard` is frozen, so
// editing the club's real defaults here must not reach back into it.
const ENTREPRENEUR_ASSETS = {
  logo_url: '/media/toastmasters_logo.png',
  fb_qr_url: '/media/Entrepreneur/FacebookQR.png',
  line_qr_url: '/media/Entrepreneur/LINEQR.png',
};
const ENTREPRENEUR_FIELD_DEFAULTS = {
  timeRange: '19:10 ~ 21:00',
  venue: 'Venue: 鑫喜文創｜台北市信義區忠孝東路五段71巷11弄25號1樓\n（捷運板南線：市政府站4號出口，走路3分鐘）',
};
const ENTREPRENEUR_PLACEHOLDERS = {
  meetingTheme: '-Urban Legend-',
  timeRange: '19:10 ~ 21:00',
  tableTopicsQuestion: '你覺得「最不適合開玩笑」的議題是什麼？…',
};
const CHH_ASSETS = {
  logo_url: '/media/ChillHiHigh/chh-logo.png',
  fb_qr_url: '/media/ChillHiHigh/chh-facebook.png',
  line_qr_url: '/media/ChillHiHigh/chh-line.png',
  ig_qr_url: '/media/ChillHiHigh/chh-instagram.png',
  page2_hero_url: '/media/ChillHiHigh/chh-p2-1.png',
  page2_img2_url: '/media/ChillHiHigh/chh-p2-2.png',
};
const CHH_FIELD_DEFAULTS = {
  venue: '社會創新實驗中心 (臺北市大安區仁愛路三段 99 號) 107 會議室',
};

const CHINA_ASSETS = {
  logo_url: '/media/China/china-logo.png',
  fb_qr_url: '/media/China/china-fb-qr.png',
  line_qr_url: '/media/China/china-line-qr.png',
  ig_qr_url: '/media/China/china-ig-qr.png',
  threads_qr_url: '/media/China/china-threads-qr.png',
  evoting_qr_url: '/media/China/china-evoting-qr.png',
  membership_qr_url: '/media/China/china-membership-qr.png',
};
const CHINA_FIELD_DEFAULTS = {
  timeRange: '18:45 ~ 21:15',
  venue: '台北市基隆路一段 333號27樓 2703室（國貿大樓 資誠會計師事務所）',
  scheduleText: 'Every 2nd & 4th Thursday, 18:45-21:15',
  admissionFeeText: 'NT$100 for guest, NT$50 for student, free for member',
};
const CHINA_PLACEHOLDERS = {
  meetingTheme: 'Comfort Zone',
  timeRange: '18:45 ~ 21:15',
  tableTopicsQuestion: 'When was the last time you stepped out of your comfort zone, and how did that experience change you?',
};

// CHINA's real weekly script — a fixed row sequence (same spirit as standard's
// hardcoded table), each row bound to the shared role field(s) it reads (plus
// 3 CHINA-only fields: voteCounter/wordOfTheDay/quizHost).
// `fields` rows show that value for "this meeting" (`data`) and, alongside it,
// the same field looked up on `ctx.nextMeetingRoles` (the next meeting's data,
// resolved live — see app/agenda/page.js's ensureNextMeetingRoles) for the
// "Next Meeting" column. `kind: 'speech'|'evaluator'` rows instead pull from
// the shared `data.speeches`/`data.evaluators` arrays, same as every other
// template — CHINA's 3 prepared speeches (idx 0-2) are each evaluated later
// in the same meeting by the evaluator at the same idx. Rows with neither
// (Manual Speech / Group Photo / Meeting Adjournment) are unassigned dividers.
const CHINA_SCHEDULE = [
  { time: '6:45', duration: '15', program: 'Registration and Reception', fields: ['receptionHost'] },
  { time: '7:03', duration: '2', program: 'Calling the meeting to order', fields: ['callingToOrder'] },
  { time: '7:05', duration: '3', program: 'Words of welcome, guests introduction', fields: ['welcomeTME'] },
  { time: '7:09', duration: '3', program: 'Toastmaster of the Evening', fields: ['tme'] },
  { time: '7:13', duration: '1', program: 'Timer', fields: ['timer'] },
  { time: '7:15', duration: '1', program: 'Ah Counter & Boardwriter', fields: ['ahCounter'] },
  { time: '7:17', duration: '1', program: 'Vote Counter', fields: ['voteCounter'] },
  { time: '7:19', duration: '2', program: 'Word of the Day', fields: ['wordOfTheDay'] },
  { time: '7:33', duration: '1', program: 'Manual Speech', section: true },
  { time: '7:35', duration: "5-7", kind: 'speech', idx: 0 },
  { time: '7:43', duration: "5-7", kind: 'speech', idx: 1 },
  { time: '7:51', duration: "5-7", kind: 'speech', idx: 2 },
  { time: '7:59', duration: '1', program: "1st Timer and Ah Counter's Report", fields: ['timer', 'ahCounter'] },
  { time: '8:01', duration: '10', program: 'Group Photo & Intermission' },
  { time: '8:12', duration: '1', program: 'Toastmaster of the Evening', fields: ['tme'] },
  { time: '8:14', duration: '15', program: 'Table Topics Session', fields: ['tableTopicsMaster'], section: true },
  { time: '8:30', duration: '1', program: 'General Evaluation', fields: ['generalEvaluator'], section: true },
  { time: '8:32', duration: "2-3", kind: 'evaluator', idx: 0 },
  { time: '8:36', duration: "2-3", kind: 'evaluator', idx: 1 },
  { time: '8:40', duration: "2-3", kind: 'evaluator', idx: 2 },
  { time: '8:44', duration: '1', program: "2nd Timer and Ah Counter's Report", fields: ['timer', 'ahCounter'] },
  { time: '8:46', duration: '5', program: 'Quiz Session', fields: ['quizHost'] },
  { time: '8:52', duration: "3-5", program: 'Language Evaluation', fields: ['langEvaluator'] },
  // `expand: 'evalEvaluator'` → this row is followed by one row per entry in
  // `data.evalEvaluators` (0-3, usually none). See expandChinaSchedule().
  { time: '8:58', duration: "3-5", program: 'General Evaluation', fields: ['generalEvaluator'], expand: 'evalEvaluator' },
  { time: '9:04', duration: '1', program: 'Vote for the Best', fields: ['voteCounter'] },
  { time: '9:06', duration: '5', program: 'TME (Feedback from the guests)', fields: ['sharingFeedback'] },
  { time: '9:12', duration: '3', program: 'Awards, Announcements', fields: ['awardsPresenter'] },
  { time: '9:15', duration: '', program: 'Meeting Adjournment' },
];

// Splice the (0-3) 講評員講評 rows in after the row that declares itself their
// anchor, so CHINA's otherwise-fixed schedule stays a plain literal. Row count
// is the larger of this and the next meeting's, since both share these rows —
// otherwise a next-meeting assignment would have nowhere to print.
function expandChinaSchedule(data, next) {
  const n = Math.max(evalEvaluatorList(data).length, evalEvaluatorList(next).length);
  if (!n) return CHINA_SCHEDULE;
  const extras = Array.from({ length: n }, (_, i) => ({ time: '', duration: "2-3", kind: 'evalEvaluator', idx: i }));
  return CHINA_SCHEDULE.flatMap((row) => (row.expand === 'evalEvaluator' ? [row, ...extras] : [row]));
}

// Duration labels for the fixed evaluation rows. Ranges rather than numbers, so
// they are display strings the meeting can override (ctx.durationLabels, edited
// in the 時間設定 panel). Kept here as a last-resort fallback so a render never
// emits `undefined` if the caller supplies no labels.
const DEFAULT_DURATION_LABELS = {
  evaluator: "2'~3'",
  timerReport: "1'",
  ahReport: "1'",
  langEval: "3'~5'",
  generalEval: "3'~5'",
  evalEvaluator: "2'~3'",
};

// ----------------------------------------------------------------
// 講評員講評 (Evaluator's Evaluator) — 0 to MAX_EVAL_EVALUATORS people who
// evaluate the evaluators themselves. Rendered right after 總講評, still
// inside the evaluation block. Optional and usually absent, so every render
// must tolerate the key being missing entirely (older saved agendas).
// The cap is enforced here as well as in the form so a hand-edited/legacy
// payload can never push a 4th row onto the sheet.
// ----------------------------------------------------------------
export const MAX_EVAL_EVALUATORS = 3;

function evalEvaluatorList(data) {
  const list = (data && data.evalEvaluators) || [];
  return Array.isArray(list) ? list.slice(0, MAX_EVAL_EVALUATORS) : [];
}

export const AGENDA_TEMPLATES = {
  // --------------------------------------------------------------
  // STANDARD — the original Entrepreneur Toastmasters layout.
  // Branding text falls back to the historic hard-coded values when a
  // club has no branding set, so existing agendas render identically.
  // --------------------------------------------------------------
  standard: {
    key: 'standard',
    label: '標準版（企業家，舊版）',
    langToggle: true, // offers a 中/英 switch
    assetDefaults: STANDARD_ASSETS,
    fieldDefaults: STANDARD_FIELD_DEFAULTS,
    placeholders: STANDARD_PLACEHOLDERS,
    // Manifest of this template's club-editable fields. Drives the 版型設定
    // modal (rendering, populate, save) in app/club/page.js — declare a field once here.
    //   store: 'column' (top-level club field) | 'setting' (settings JSON)
    //   group: 'basic' (編輯) | 'template' (版型)   row: pair fields in a 2-col grid
    settings: [
      { key: 'fb_qr_url', label: 'Facebook QR', type: 'image', store: 'column', group: 'template', section: '社群 QR（議程顯示用）', row: 'qr' },
      { key: 'line_qr_url', label: 'LINE QR', type: 'image', store: 'column', group: 'template', section: '社群 QR（議程顯示用）', row: 'qr' },
      { key: 'charter_no', label: '章程編號', type: 'text', store: 'column', group: 'template', section: '標準版（企業家）專屬', row: 'meta', placeholder: 'No. 4069930' },
      { key: 'founded_date', label: '成立日', type: 'text', store: 'column', group: 'template', section: '標準版（企業家）專屬', row: 'meta', placeholder: '2014.06.29' },
      { key: 'timeRange', label: '預設時間 Time（議程可覆寫；日期仍動態帶入當日）', type: 'text', store: 'setting', group: 'template', section: '標準版（企業家）專屬', placeholder: '19:10 ~ 21:00' },
      { key: 'venue', label: '預設地點 Venue（議程可覆寫）', type: 'textarea', store: 'setting', group: 'template', section: '標準版（企業家）專屬', placeholder: 'Venue: 鑫喜文創｜台北市信義區忠孝東路五段71巷11弄25號1樓\n（捷運板南線：市政府站4號出口，走路3分鐘）' },
      { key: 'scheduleZh', label: '會議日期行（中文）', type: 'text', store: 'setting', group: 'template', section: '標準版（企業家）專屬', placeholder: '會議日期為每月第 1 個星期二 (中文) / 第 3 個星期二 (English)' },
      { key: 'scheduleEn', label: '會議日期行（English）', type: 'text', store: 'setting', group: 'template', section: '標準版（企業家）專屬', placeholder: 'Meeting on every 1st (中文) and 3rd (English) Tuesday evening' },
    ],
    render(data, club, ctx) {
      const {
        t, esc, calcTimes, displayMember, buildSpeechAgendaLine,
        formatDate, varietySession, durationLabels, PATHWAYS, PATHWAYS_ZH, images, lang,
      } = ctx;

      const brand = {
        nameZh: (club && club.name_zh) || '企業家國際演講會',
        nameEn: (club && club.name_en) || 'Entrepreneur Toastmasters Club',
        charterNo: (club && club.charter_no) || 'No. 4069930',
        founded: (club && club.founded_date) || '2014.06.29',
        fee: (club && club.fee) || 'NTD150',
      };

      // Meeting-schedule line is club-managed (per language); fall back to the
      // historic hard-coded translation when a club hasn't set it.
      const set = (club && club.settings) || {};
      const schedule = (lang === 'zh' ? set.scheduleZh : set.scheduleEn) || t('meetingSchedule');

      // ---- header ----
      const dateDisplay = data.meetingDate ? formatDate(data.meetingDate) : '____.__.__';
      const logoHtml = images.logo
        ? `<img src="${images.logo}" class="hg-logo-img" alt="TM Logo">`
        : `<div class="hg-logo-ph"><div class="logo-ring"><span>TM</span></div></div>`;
      const themeImgHtml = images.themeImg
        ? `<img src="${images.themeImg}" class="hg-theme-img" alt="Theme">`
        : `<div class="hg-theme-ph"><span>Theme<br>Image</span></div>`;

      const headerHtml = `<div class="doc-header">
  <div class="hg-logo">${logoHtml}</div>
  <div class="hg-names">
    <div class="club-name-zh">${esc(brand.nameZh)}</div>
    <div class="club-name-en">${esc(brand.nameEn)}</div>
  </div>
  <div class="hg-img">${themeImgHtml}</div>
  <div class="hg-meta-left">
    <div>${esc(brand.charterNo)}</div>
    <div>${t('foundedSince')}:</div>
    <div>${esc(brand.founded)}</div>
    <div>&nbsp;</div>
    <div>${t('fee')} : ${esc(brand.fee)}</div>
  </div>
  <div class="hg-meta-right">
    <div class="hmr-text" style="grid-column:span 2"><strong>${t('thTime')} : ${dateDisplay} ｜ ${esc(data.timeRange)}</strong></div>
    <div class="hmr-text" style="grid-column:span 2">${esc(schedule)}</div>
    <div class="hmr-text" style="grid-column:span 2">${esc(data.venueInfo).replace(/\n/g, '<br>')}</div>
  </div>
</div>`;

      // ---- right panel (pathways / time rules / QR) ----
      const pwSource = lang === 'zh' ? PATHWAYS_ZH : PATHWAYS;
      const pwList = pwSource.map(([code, name]) =>
        `<div class="rp-pw"><span class="rp-pwc">${esc(code)}｜</span><em class="rp-pwn">${esc(name)}</em></div>`
      ).join('');
      const fbContent = images.fbQr
        ? `<img src="${images.fbQr}" class="qr-img" alt="FB QR">`
        : `<div class="qr-ph"></div>`;
      const lineContent = images.lineQr
        ? `<img src="${images.lineQr}" class="qr-img" alt="LINE QR">`
        : `<div class="qr-ph"></div>`;

      const rightPanelHtml = `<div class="rp-wrap">
  <div class="rp-pw-list">${pwList}</div>
  <div class="rp-tr">
    <div class="rp-tr-title">${t('timeRules')}</div>
    <table class="rp-tr-table">
      <thead><tr><td></td><th class="tc-g">min</th><th class="tc-y">ok</th><th class="tc-r">max</th></tr></thead>
      <tbody>
        <tr><td class="tr-lbl">${t('trPrepared')}</td><td class="tc-g">5</td><td class="tc-y">6</td><td class="tc-r">7</td></tr>
        <tr><td class="tr-lbl">${t('trTopic')}</td><td class="tc-g">1</td><td class="tc-y">1.5</td><td class="tc-r">2</td></tr>
        <tr><td class="tr-lbl">${t('trEval')}</td><td class="tc-g">2</td><td class="tc-y">2.5</td><td class="tc-r">3</td></tr>
        <tr><td class="tr-lbl">${t('trLEGE')}</td><td class="tc-g">3</td><td class="tc-y">4</td><td class="tc-r">5</td></tr>
      </tbody>
    </table>
  </div>
  <div class="rp-qr-items">
    <div class="rp-qr-item">${fbContent}<div class="rp-qr-lbl">${t('fbLabel')}</div></div>
    <div class="rp-qr-item">${lineContent}<div class="rp-qr-lbl">${t('lineLabel')}</div></div>
  </div>
</div>`;

      // ---- body table ----
      const speechCount = data.speeches.length;
      const evalCount = data.evaluators.length;
      const evalEvals = evalEvaluatorList(data);
      const times = calcTimes(data.speeches);
      const DL = { ...DEFAULT_DURATION_LABELS, ...(durationLabels || {}) };

      // rows: reception(1) + opening(5) + speech_header(1) + speeches(N)
      //       + photo(1) + intermission(1) + topics(1) + spacer(1)
      //       + eval_header(1) + evaluators(M) + timer(1) + ah(1) + LE(1) + GE(1)
      //       + eval-evaluators(K) + closing(2) + sharing(1) + meeting-end(1)  = 20 + N + M + K
      const totalRows = 20 + speechCount + evalCount + evalEvals.length;

      // Dynamic duration column width: size it to the longest single-column
      // duration string (e.g. "12'-15'") so double-digit minutes don't overflow.
      const DUR_POOL = 69; // mm shared by col-dur + col-agenda
      const durStrings = data.speeches.map((sp) => sp.duration || "5'-7'").concat(Object.values(DL));
      const maxDurLen = durStrings.reduce((m, s) => Math.max(m, String(s).length), 0);
      const durWidth = Math.min(16, Math.max(8, Math.round(maxDurLen * 1.5 + 3)));
      const agendaWidth = DUR_POOL - durWidth;

      let tbody = '';

      // Reception — right panel cell starts here with rowspan
      tbody += `
  <tr>
    <td class="time-cell">${times.receptionStart}</td>
    <td class="dur-cell" colspan="2">${times.receptionMins}'</td>
    <td class="agenda-cell">${t('reception')}</td>
    <td class="taker-cell">${esc(displayMember(data.receptionHost))}</td>
    <td class="rp-cell" rowspan="${totalRows}">${rightPanelHtml}</td>
  </tr>`;

      // Opening block — time & dur rowspan 5
      tbody += `
  <tr>
    <td class="time-cell" rowspan="5">${times.openingStart}</td>
    <td class="dur-cell" rowspan="5" colspan="2">${times.openingMins}'</td>
    <td class="agenda-cell">${t('callingOrder')}</td>
    <td class="taker-cell">${esc(displayMember(data.callingToOrder))}</td>
  </tr>
  <tr>
    <td class="agenda-cell">${t('welcomeGuests')}</td>
    <td class="taker-cell">${esc(displayMember(data.welcomeTME))}</td>
  </tr>
  <tr>
    <td class="agenda-cell">${t('tmeIntro')}</td>
    <td class="taker-cell">${esc(displayMember(data.tme))}</td>
  </tr>
  <tr>
    <td class="agenda-cell">${t('timerExplain')}</td>
    <td class="taker-cell">${esc(displayMember(data.timer))}</td>
  </tr>
  <tr>
    <td class="agenda-cell">${t('ahExplain')}</td>
    <td class="taker-cell">${esc(displayMember(data.ahCounter))}</td>
  </tr>`;

      // Variety Session (optional)
      if (varietySession.enabled) {
        tbody += `
  <tr class="row-section">
    <td class="time-cell">${times.speechStart}</td>
    <td class="dur-cell" colspan="2">${times.varietyMins}'</td>
    <td class="agenda-cell"><strong>${t('varietySession')}</strong></td>
    <td class="taker-cell">${esc(displayMember(varietySession.host))}</td>
  </tr>`;
      }

      // Prepared Speech block — time rowspan = 1 + speechCount
      const speechBlockSpan = 1 + speechCount;
      tbody += `
  <tr class="row-section">
    <td class="time-cell" rowspan="${speechBlockSpan}">${times.preparedSpeechStart}</td>
    <td class="secdur-cell" rowspan="${speechBlockSpan}">${times.speechMins}'</td>
    <td class="agenda-cell" colspan="2"><strong>${t('preparedSpeech')}</strong></td>
    <td class="taker-cell">${esc(displayMember(data.tme))}</td>
  </tr>`;

      data.speeches.forEach((sp) => {
        tbody += `
  <tr>
    <td class="dur-cell">${esc(sp.duration || "5'-7'")}</td>
    <td class="agenda-cell">${buildSpeechAgendaLine(sp)}</td>
    <td class="taker-cell">${esc(displayMember(sp.speaker))}</td>
  </tr>`;
      });

      // Group Photo
      tbody += `
  <tr>
    <td class="time-cell">${times.photoStart}</td>
    <td class="dur-cell" colspan="2">${times.photoMins}'</td>
    <td class="agenda-cell">${t('groupPhoto')}</td>
    <td class="taker-cell">${t('allParticipants')}</td>
  </tr>`;

      // Intermission
      tbody += `
  <tr class="row-intermission">
    <td colspan="5">${t('intermission', times.intermissionMins)}</td>
  </tr>`;

      // Table Topics
      tbody += `
  <tr class="row-section">
    <td class="time-cell">${times.topicsStart}</td>
    <td class="dur-cell" colspan="2">${times.topicsMins}'</td>
    <td class="agenda-cell"><strong>${t('tableTopics')}</strong></td>
    <td class="taker-cell">${esc(displayMember(data.tableTopicsMaster))}</td>
  </tr>`;

      // Spacer
      tbody += `<tr class="row-spacer"><td colspan="5"></td></tr>`;

      // Evaluation block — rowspan = 1 (header) + M (evaluators)
      //                            + 4 (timer, ah, LE, GE) + K (講評員講評)
      const evalRowSpan = evalCount + evalEvals.length + 5;
      tbody += `
  <tr class="row-section">
    <td class="time-cell" rowspan="${evalRowSpan}">${times.evalStart}</td>
    <td class="secdur-cell" rowspan="${evalRowSpan}">${times.evalMins}'</td>
    <td class="agenda-cell" colspan="2"><strong>${t('evaluation')}</strong></td>
    <td class="taker-cell">${esc(displayMember(data.generalEvaluator))}</td>
  </tr>`;

      data.evaluators.forEach((ev, i) => {
        tbody += `
  <tr>
    <td class="dur-cell">${esc(DL.evaluator)}</td>
    <td class="agenda-cell">${t('evaluatorFor', i + 1)}</td>
    <td class="taker-cell">${esc(displayMember(ev))}</td>
  </tr>`;
      });

      tbody += `
  <tr>
    <td class="dur-cell">${esc(DL.timerReport)}</td>
    <td class="agenda-cell">${t('timerReport')}</td>
    <td class="taker-cell">${esc(displayMember(data.timer))}</td>
  </tr>
  <tr>
    <td class="dur-cell">${esc(DL.ahReport)}</td>
    <td class="agenda-cell">${t('ahReport')}</td>
    <td class="taker-cell">${esc(displayMember(data.ahCounter))}</td>
  </tr>
  <tr>
    <td class="dur-cell">${esc(DL.langEval)}</td>
    <td class="agenda-cell">${t('langEval')}</td>
    <td class="taker-cell">${esc(displayMember(data.langEvaluator))}</td>
  </tr>
  <tr>
    <td class="dur-cell">${esc(DL.generalEval)}</td>
    <td class="agenda-cell">${t('generalEval')}</td>
    <td class="taker-cell">${esc(displayMember(data.generalEvaluator))}</td>
  </tr>`;

      // 講評員講評 — optional, closes out the evaluation block after 總講評.
      evalEvals.forEach((ev, i) => {
        tbody += `
  <tr>
    <td class="dur-cell">${esc(DL.evalEvaluator)}</td>
    <td class="agenda-cell">${t('evalEvaluatorFor', i + 1)}</td>
    <td class="taker-cell">${esc(displayMember(ev))}</td>
  </tr>`;
      });

      // Closing — time rowspan 2
      tbody += `
  <tr>
    <td class="time-cell" rowspan="2">${times.closingStart}</td>
    <td class="dur-cell" colspan="2">${Math.ceil(times.closingMins / 2)}'</td>
    <td class="agenda-cell">${t('tmeClosing')}</td>
    <td class="taker-cell">${esc(displayMember(data.tme))}</td>
  </tr>
  <tr>
    <td class="dur-cell" colspan="2">${Math.floor(times.closingMins / 2)}'</td>
    <td class="agenda-cell">${t('awards')}</td>
    <td class="taker-cell">${esc(displayMember(data.awardsPresenter))}</td>
  </tr>`;

      // Sharing & Feedback
      tbody += `
  <tr>
    <td class="time-cell">${times.sharingStart}</td>
    <td class="dur-cell" colspan="2">${times.sharingMins}'</td>
    <td class="agenda-cell">${t('sharing')}</td>
    <td class="taker-cell">${esc(displayMember(data.sharingFeedback))}</td>
  </tr>
  <tr>
    <td class="time-cell">${times.meetingEnd}</td>
    <td class="dur-cell" colspan="2"></td>
    <td class="agenda-cell">${t('meetingEnd')}</td>
    <td class="taker-cell"></td>
  </tr>`;

      return `
${headerHtml}

<div class="theme-row">
  <span class="theme-label">${t('themeLabel')}</span>
  <span class="theme-value"><strong><em>${esc(data.meetingTheme) || '—'}</em></strong></span>
  <span class="meeting-no-label">${t('meetingNoLabel', data.meetingNo)}</span>
</div>

<div class="mission-section">
  <div class="mission-title">${t('missionTitle')}</div>
  <div class="mission-text">${t('missionText')}</div>
</div>

<table class="agenda-table">
  <colgroup>
    <col class="col-time">
    <col class="col-secdur">
    <col class="col-dur" style="width:${durWidth}mm">
    <col class="col-agenda" style="width:${agendaWidth}mm">
    <col class="col-taker">
    <col class="col-rp">
  </colgroup>
  <thead>
    <tr>
      <th>${t('thTime')}</th>
      <th colspan="2"></th>
      <th>${t('thAgenda')}</th>
      <th>${t('thTaker')}</th>
      <th>${t('thPathways')}</th>
    </tr>
  </thead>
  <tbody>${tbody}</tbody>
</table>

<div class="agenda-footer">${t('adjournment')}</div>
`;
    },
  },

  // --------------------------------------------------------------
  // COMPACT — a deliberately different single-column layout (no right
  // pathways panel, simpler header). Demonstrates that a club can use a
  // structurally different template. All styles are namespaced .tmpl-compact.
  // --------------------------------------------------------------
  compact: {
    key: 'compact',
    label: '精簡版（單欄）',
    langToggle: true, // offers a 中/英 switch
    assetDefaults: {}, // uses no logo/QR
    fieldDefaults: { timeRange: '19:00 ~ 21:00' }, // neutral — not any specific club's real schedule
    settings: [], // no club-editable template-specific fields
    render(data, club, ctx) {
      const { t, esc, calcTimes, displayMember, buildSpeechAgendaLine, formatDate, varietySession, durationLabels, lang } = ctx;
      const DL = { ...DEFAULT_DURATION_LABELS, ...(durationLabels || {}) };

      // No club branding set yet → generic placeholder text, never another
      // club's real name (this template is meant to be usable by any club).
      const brand = {
        nameZh: (club && club.name_zh) || '分會名稱 Club Name',
        nameEn: (club && club.name_en) || 'Toastmasters Club',
      };
      const dateDisplay = data.meetingDate ? formatDate(data.meetingDate) : '____.__.__';
      const times = calcTimes(data.speeches);

      // Each entry: [time, dur, agenda(html), taker(html), isSection]
      const rows = [];
      const section = (time, dur, label) => rows.push([time, dur, `<strong>${label}</strong>`, '', true]);
      const item = (time, dur, label, who) => rows.push([time, dur, label, who, false]);

      item(times.receptionStart, `${times.receptionMins}'`, t('reception'), esc(displayMember(data.receptionHost)));
      section(times.openingStart, `${times.openingMins}'`, lang === 'zh' ? '開場' : 'Opening');
      item('', '', t('callingOrder'), esc(displayMember(data.callingToOrder)));
      item('', '', t('welcomeGuests'), esc(displayMember(data.welcomeTME)));
      item('', '', t('tmeIntro'), esc(displayMember(data.tme)));
      item('', '', t('timerExplain'), esc(displayMember(data.timer)));
      item('', '', t('ahExplain'), esc(displayMember(data.ahCounter)));

      if (varietySession.enabled) {
        section(times.speechStart, `${times.varietyMins}'`, t('varietySession'));
        item('', '', '', esc(displayMember(varietySession.host)));
      }

      section(times.preparedSpeechStart, `${times.speechMins}'`, t('preparedSpeech'));
      data.speeches.forEach((sp) => {
        item('', esc(sp.duration || "5'-7'"), buildSpeechAgendaLine(sp), esc(displayMember(sp.speaker)));
      });

      item(times.photoStart, `${times.photoMins}'`, t('groupPhoto'), t('allParticipants'));
      item(times.topicsStart, `${times.intermissionMins}'`, t('intermission', times.intermissionMins), '');
      section(times.topicsStart, `${times.topicsMins}'`, t('tableTopics'));
      item('', '', '', esc(displayMember(data.tableTopicsMaster)));

      section(times.evalStart, `${times.evalMins}'`, t('evaluation'));
      item('', '', t('generalEval'), esc(displayMember(data.generalEvaluator)));
      data.evaluators.forEach((ev, i) => item('', esc(DL.evaluator), t('evaluatorFor', i + 1), esc(displayMember(ev))));
      item('', esc(DL.timerReport), t('timerReport'), esc(displayMember(data.timer)));
      item('', esc(DL.ahReport), t('ahReport'), esc(displayMember(data.ahCounter)));
      item('', esc(DL.langEval), t('langEval'), esc(displayMember(data.langEvaluator)));
      // 講評員講評 — optional; last rows of the evaluation block, as in `standard`.
      evalEvaluatorList(data).forEach((ev, i) =>
        item('', esc(DL.evalEvaluator), t('evalEvaluatorFor', i + 1), esc(displayMember(ev))));

      section(times.closingStart, `${times.closingMins}'`, t('tmeClosing'));
      item('', '', t('awards'), esc(displayMember(data.awardsPresenter)));
      item(times.sharingStart, `${times.sharingMins}'`, t('sharing'), esc(displayMember(data.sharingFeedback)));
      item(times.meetingEnd, '', t('meetingEnd'), '');

      const tbody = rows.map(([time, dur, agenda, who, isSec]) => `
    <tr class="${isSec ? 'c-row-section' : ''}">
      <td class="c-time">${time}</td>
      <td class="c-dur">${dur}</td>
      <td class="c-agenda">${agenda}</td>
      <td class="c-taker">${who}</td>
    </tr>`).join('');

      return `
<div class="c-header">
  <div class="c-club">${esc(brand.nameZh)} <span class="c-club-en">${esc(brand.nameEn)}</span></div>
  <div class="c-meta">${t('thTime')} : ${dateDisplay} ｜ ${esc(data.timeRange)} ｜ ${t('meetingNoLabel', data.meetingNo)}</div>
  <div class="c-theme">${t('themeLabel')} <strong><em>${esc(data.meetingTheme) || '—'}</em></strong></div>
</div>

<table class="c-table">
  <thead>
    <tr><th>${t('thTime')}</th><th></th><th>${t('thAgenda')}</th><th>${t('thTaker')}</th></tr>
  </thead>
  <tbody>${tbody}</tbody>
</table>

<div class="c-footer">${t('adjournment')}</div>
`;
    },
  },

  // --------------------------------------------------------------
  // CHILL HI HIGH — bilingual humor club layout: inline green/yellow/red
  // time-signal columns, extra ceremonial roles, and a Meeting Roles glossary.
  // Per-meeting signal times come from ctx.signals (editable in the form).
  // Branding extras (slogan / transit / closingLine) live in club.settings.
  // --------------------------------------------------------------
  chillhihigh: {
    key: 'chillhihigh',
    label: '雙語幽默版（Chill Hi High）',
    fields: ['chillhihigh'],
    // Inherently 中英混用: no language switch, pinned render lang, and member
    // names show English + Chinese together.
    langToggle: false,
    fixedLang: 'zh',
    bilingualNames: true,
    assetDefaults: CHH_ASSETS,
    fieldDefaults: CHH_FIELD_DEFAULTS,
    settings: [
      { key: 'logo_url', label: 'Logo', type: 'image', store: 'column', group: 'basic', section: 'Logo（上傳至雲端）' },
      { key: 'venue', label: '預設地點 Venue（議程可覆寫）', type: 'textarea', store: 'setting', group: 'template', section: '版型專屬設定', placeholder: '社會創新實驗中心 (臺北市大安區仁愛路三段 99 號) 107 會議室' },
      { key: 'fb_qr_url', label: 'Facebook QR', type: 'image', store: 'column', group: 'template', section: '社群 QR（議程顯示用）', row: 'qr' },
      { key: 'line_qr_url', label: 'LINE QR', type: 'image', store: 'column', group: 'template', section: '社群 QR（議程顯示用）', row: 'qr' },
      { key: 'ig_qr_url', label: 'Instagram QR', type: 'image', store: 'setting', group: 'template', section: '社群 QR（議程顯示用）', row: 'qr' },
      { key: 'slogan', label: '標語 Slogan', type: 'text', store: 'setting', group: 'template', section: '版型專屬設定', placeholder: 'Amuse to Amaze: A bilingual Toastmasters club…' },
      { key: 'transit', label: '交通 Transit', type: 'text', store: 'setting', group: 'template', section: '版型專屬設定', placeholder: '忠孝復興捷運站 2 號出口步行 7 分鐘' },
      { key: 'closingLine', label: '結尾句 Closing Line', type: 'text', store: 'setting', group: 'template', section: '版型專屬設定', placeholder: '活動結束，期待下次與你一起 Chill Hi High！' },
      { key: 'upcomingMeetings', label: '近期例會 Upcoming Meetings', type: 'text', store: 'setting', group: 'template', section: '第二頁宣傳後頁（Chill Hi High 版型）', placeholder: '5/26、6/9、6/23、7/14、7/28' },
      { key: 'specialEvent', label: '特別活動 Special Event', type: 'text', store: 'setting', group: 'template', section: '第二頁宣傳後頁（Chill Hi High 版型）', placeholder: '7/28 (二) 新任幹部交接典禮' },
      { key: 'membershipFee', label: '入會費用 Membership Fee', type: 'text', store: 'setting', group: 'template', section: '第二頁宣傳後頁（Chill Hi High 版型）', placeholder: 'TWD $6,000（含年費 5,000 + 終身註冊費 1,000）' },
      { key: 'page2_hero_url', label: '第二頁 圖1 Hero（我們是誰）', type: 'image', store: 'setting', group: 'template', section: '第二頁宣傳後頁（Chill Hi High 版型）', row: 'p2img' },
      { key: 'page2_img2_url', label: '第二頁 圖2（招生／入會流程／Pathways）', type: 'image', store: 'setting', group: 'template', section: '第二頁宣傳後頁（Chill Hi High 版型）', row: 'p2img' },
      // Read server-side by GET /api/clubs/{id}/roles-sheet and turned into a
      // CSV export URL there — the link must carry #gid= so the right tab is
      // pulled. Consumed by the 「從 Google Sheet 匯入」button on /roles.
      { key: 'roles_sheet_url', label: '角色表網址（需含分頁 #gid=…，共用設為「知道連結的任何人可檢視」）', type: 'text', store: 'setting', group: 'template', section: '例會角色匯入（Google Sheet）', placeholder: 'https://docs.google.com/spreadsheets/d/…/edit#gid=2129055481' },
    ],
    render(data, club, ctx) {
      const { esc, calcTimes, displayMember, buildSpeechAgendaLine, formatDate, varietySession, signals } = ctx;
      const s = {
        ...{
          variety: {}, preparedSpeech: {}, tableTopics: {}, evaluation: {},
          langEval: {}, generalEval: {}, ttSpeakerSpec: '',
        }, ...(signals || {}),
      };
      const set = (club && club.settings) || {};

      const brand = {
        nameZh: (club && club.name_zh) || '中英雙語國際演講會',
        nameEn: (club && club.name_en) || 'Chill Hi High Toastmasters Club',
        fee: (club && club.fee) || '',
      };

      // Bundled default assets (CHH_ASSETS) overridable by a club upload
      // (top-level columns for logo/QR, settings for page-2 images).
      const A = CHH_ASSETS;
      const img = {
        logo: (club && club.logo_url) || A.logo_url,
        fb: (club && club.fb_qr_url) || A.fb_qr_url,
        line: (club && club.line_qr_url) || A.line_qr_url,
        ig: set.ig_qr_url || A.ig_qr_url,
        hero: set.page2_hero_url || A.page2_hero_url,
        img2: set.page2_img2_url || A.page2_img2_url,
      };

      const dateDisplay = data.meetingDate ? formatDate(data.meetingDate) : '____.__.__';
      const times = calcTimes(data.speeches);

      const m = (v) => esc(displayMember(v));
      // bare numbers get a trailing '; values like 2'30" are shown as-is
      const fmtSig = (v) => (v == null || v === '') ? '' : (/^\d+$/.test(String(v)) ? `${v}'` : esc(v));
      const sig = (cat) => {
        const o = s[cat] || {};
        return `<td class="ch-g">${fmtSig(o.g)}</td><td class="ch-y">${fmtSig(o.y)}</td><td class="ch-r">${fmtSig(o.r)}</td>`;
      };
      const noSig = `<td></td><td></td><td></td>`;

      let rows = '';
      const row = (time, dur, agenda, host, sigCells = noSig, cls = '') => {
        rows += `<tr class="${cls}"><td class="ch-time">${esc(time || '')}</td><td class="ch-dur">${esc(dur == null ? '' : String(dur))}</td><td class="ch-ag">${agenda}</td><td class="ch-host">${host}</td>${sigCells}</tr>`;
      };
      const full = (label) => { rows += `<tr class="ch-band"><td colspan="7">${label}</td></tr>`; };

      // ---- Opening / first half ----
      row(times.receptionStart, times.receptionMins, '報到 Registration', m(data.receptionHost));
      row(times.openingStart, '', '致歡迎詞 Opening Remarks', m(data.welcomeTME));
      row('', '', '總主持人上半場開場 TME Opening - First Half', m(data.tme));
      row('', '', '計時員介紹 Timer Introduction', m(data.timer));
      row('', '', '贅字/笑聲記錄員介紹 Ah/Ha Counter Introduction', m(data.ahCounter));
      row('', '', '白板記錄員 Board Writer / 攝影師 Photographer',
        [m(data.boardWriter), m(data.photographer)].filter(Boolean).join(' / '));

      if (varietySession.enabled) {
        row(times.speechStart, times.varietyMins, '<strong>暖場活動 Variety Session</strong>',
          m(varietySession.host), sig('variety'), 'ch-section');
      }

      // ---- Prepared speeches ----
      row(times.preparedSpeechStart, times.speechMins, '<strong>指定演講 Prepared Speeches</strong>', m(data.tme), noSig, 'ch-section');
      data.speeches.forEach((sp) => {
        row('', esc(sp.duration || "5'-7'"), buildSpeechAgendaLine(sp), m(sp.speaker), sig('preparedSpeech'));
      });
      row('', '', '計時員報告 Timer\'s Report', m(data.timer));
      row('', '', '贅字/笑聲記錄員報告 Ah/Ha Counter\'s Report', m(data.ahCounter));
      row('', '', '來賓介紹 Guest Introduction', m(data.tme));

      // ---- Intermission / second half ----
      full('團體照、中場休息 Group Photo &amp; Intermission');
      row(times.topicsStart, '', '總主持人下半場開場 TME Opening - Second Half', m(data.tme));
      row('', times.topicsMins,
        `<strong>小組即席問答 Group Table Topics Session</strong>${s.ttSpeakerSpec ? ` <span class="ch-spec">(講者: ${esc(s.ttSpeakerSpec)})</span>` : ''}`,
        m(data.tableTopicsMaster), sig('tableTopics'), 'ch-section');

      // ---- Evaluation ----
      row(times.evalStart, times.evalMins, '<strong>講評環節 Evaluation Session</strong>', m(data.generalEvaluator), noSig, 'ch-section');
      // Each individual evaluator is matched to the same-index prepared speech;
      // label them by that speech's language (default English).
      data.evaluators.forEach((ev, i) => {
        const sp = data.speeches[i];
        const label = (sp && sp.speechLang === 'zh')
          ? '國語講評員 Mandarin Evaluator'
          : '英語講評員 English Evaluator';
        row('', '', label, m(ev), sig('evaluation'));
      });
      row('', '', '計時員報告 Timer\'s Report', m(data.timer));
      row('', '', '贅字/笑聲記錄員報告 Ah/Ha Counter\'s Report', m(data.ahCounter));
      row('', '', '語言/幽默講評 Language/Humor Evaluation', m(data.langEvaluator), sig('langEval'));
      row(times.closingStart, '', '總講評 General Evaluation', m(data.generalEvaluator), sig('generalEval'));
      // 講評員講評 — optional; same 2-3' green/yellow/red card as an individual evaluator.
      const chhEvalEvals = evalEvaluatorList(data);
      chhEvalEvals.forEach((ev) => {
        row('', '', '講評員講評 Evaluator\'s Evaluator', m(ev), sig('evaluation'));
      });
      row(times.sharingStart, times.sharingMins, '來賓回饋與結語 Guest Feedback &amp; Closing Remarks',
        [m(data.awardsPresenter), m(data.sharingFeedback)].filter(Boolean).join(' / '));
      row(times.meetingEnd, '', '會議結束 Meeting Ends', '');

      // ---- Meeting Roles glossary (static, bilingual) ----
      const roleGloss = [
        ['總主持人<br>Toastmaster of the Evening (TME)', '決定例會主題，並主持及串接整場會議流程與互動'],
        ['計時員<br>Timer', '協助講者在指定時間內完成演講'],
        ['贅字/笑聲記錄員<br>Ah/Ha Counter', '紀錄講者的冗言贅字及觀眾笑聲次數'],
        ['暖場活動主持人<br>Variety Session Master', '活絡例會氣氛，鼓勵參與者互相認識'],
        ['備稿演講者<br>Prepared Speech Speaker', '依循學習途徑 (Pathways) 的專案目標，準備 5-7 分鐘演講'],
        ['小組即席問答主持人<br>Group Table Topics Master', '準備 4-6 題目，帶領小組討論，並邀請成員上台分享 1-2 分鐘的答案'],
        ['總講評<br>General Evaluator', '介紹例會後半場的講評員，並提供整場會議總體評價'],
        ['個別講評員<br>Individual Evaluator', '針對備稿演講者提供 2-3 分鐘講評、鼓勵與改進建議'],
        ['語言/幽默講評<br>Language/Humor Evaluator', '整理全場用語、文法、佳句與幽默設計'],
        // Only listed when the meeting actually has one — the glossary is a
        // legend for the rows above it, not a catalogue of every possible role.
        ...(chhEvalEvals.length
          ? [['講評員講評<br>Evaluator\'s Evaluator', '針對個別講評員的講評內容給予回饋與改進建議']]
          : []),
      ].map(([r, d]) => `<div class="ch-role"><div class="ch-role-t">${r}</div><div class="ch-role-d">${d}</div></div>`).join('');

      const logoHtml = `<img src="${img.logo}" class="ch-logo-img" alt="logo">`;

      const page1 = `
<div class="ch-header">
  <div class="ch-logo">${logoHtml}</div>
  <div class="ch-titles">
    <div class="ch-name"><strong>${esc(brand.nameEn)}</strong> ${esc(brand.nameZh)}</div>
    ${set.slogan ? `<div class="ch-slogan">${esc(set.slogan)}</div>` : ''}
    <div class="ch-info">
      <div>時間 : ${dateDisplay} ${esc(data.timeRange)}</div>
      <div>地點 : ${esc(data.venueInfo).replace(/\n/g, '<br>')}</div>
      ${set.transit ? `<div>交通 : ${esc(set.transit)}</div>` : ''}
      ${brand.fee ? `<div>入場費 : ${esc(brand.fee)}</div>` : ''}
    </div>
  </div>
</div>

<div class="ch-theme">
  <div>會議主題 : ${esc(data.meetingTheme) || '—'}</div>
  ${data.tableTopicsQuestion ? `<div class="ch-theme-q">主題題目 : ${esc(data.tableTopicsQuestion)}</div>` : ''}
</div>

<table class="ch-table">
  <colgroup><col class="ch-c-time"><col class="ch-c-dur"><col class="ch-c-ag"><col class="ch-c-host"><col span="3" class="ch-c-sig"></colgroup>
  <thead>
    <tr>
      <th rowspan="2">時間</th><th rowspan="2">時長(分)</th><th rowspan="2">議程</th><th rowspan="2">主持</th>
      <th colspan="3">時間管理</th>
    </tr>
    <tr><th class="ch-g">綠牌</th><th class="ch-y">黃牌</th><th class="ch-r">紅牌</th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="ch-footer">${esc(set.closingLine) || '活動結束'}</div>

<div class="ch-roles">
  <div class="ch-roles-title">例會角色 Meeting Roles</div>
  <div class="ch-roles-grid">${roleGloss}</div>
</div>
`;

      // ================= PAGE 2 — club promo back-page =================
      // Static parts are images (hero banner + a combined pitch/join/pathways
      // graphic); only "近期例會" is dynamic. Images default to bundled assets
      // and are overridable per club. When img2 is absent, fall back to HTML.
      const heroHtml = `<div class="ch2-hero"><img src="${img.hero}" class="ch2-hero-img" alt="intro"></div>`;

      // Current (non-legacy) paths from the Pathways catalog (/pathways page).
      const pathways = (ctx.pathwayList || [])
        .filter((p) => !p.legacy)
        .map((p) => `<div class="ch2-pw"><div class="ch2-pw-zh">${esc(p.zh || p.en)} (${esc(p.code)})</div><div class="ch2-pw-en">${esc(p.en)}</div></div>`)
        .join('');

      const joinSteps = [
        ['1', '填寫入會表格'],
        ['2', `繳交入會費用${set.membershipFee ? `<br><span class="ch2-fee">${esc(set.membershipFee)}</span>` : ''}`],
        ['3', '參加迎新會'],
        ['4', '成為會員'],
      ].map(([n, label]) => `<div class="ch2-step"><span class="ch2-step-n">${n}</span><span class="ch2-step-l">${label}</span></div>`).join('');

      const wishList = [
        '克服舞台恐懼 Overcome stage fright',
        '提升舞台表現與幽默感 Enhance stage presence and sense of humor',
        '增強領導力 Strengthen leadership skills',
        '擴大人脈圈 Expand your network',
        '…或其他 Or others',
      ].map((w) => `<li>${esc(w)}</li>`).join('');

      const qrItems = [
        [img.fb, 'Facebook'],
        [img.ig, 'Instagram'],
        [img.line, 'LINE'],
      ].filter(([u]) => u)
        .map(([u, label]) => `<div class="ch2-qr"><div class="ch2-qr-l">${label}</div><img src="${u}" class="ch2-qr-img" alt="${label}"></div>`)
        .join('');

      // The combined pitch/join/pathways graphic; HTML fallback if no image.
      const bodyHtml = img.img2
        ? `<div class="ch2-img2"><img src="${img.img2}" class="ch2-img2-img" alt="join"></div>`
        : `
  <div class="ch2-join">
    <div class="ch2-join-left">
      <div class="ch2-title">如果你想要…</div>
      <ul class="ch2-wish">${wishList}</ul>
    </div>
    <div class="ch2-join-right">
      加入 ${esc(brand.nameZh)}，我們一起實現你/妳的成長目標！<br>
      <em>Become a member of ${esc(brand.nameEn)}, and let's achieve your goals together!</em>
    </div>
  </div>
  <div class="ch2-block">
    <div class="ch2-title">入會流程 How to Join</div>
    <div class="ch2-steps">${joinSteps}</div>
  </div>
  <div class="ch2-block">
    <div class="ch2-title">國際演講會 學習途徑 Toastmasters Pathways</div>
    <div class="ch2-pw-grid">${pathways}</div>
  </div>`;

      const page2 = `
<div class="ch2-page">
  ${heroHtml}

  ${(set.upcomingMeetings || set.specialEvent) ? `
  <div class="ch2-block">
    <div class="ch2-title">未來例會及活動時間 Upcoming Meetings &amp; Events</div>
    <div class="ch2-upcoming">
      ${set.upcomingMeetings ? `<div><strong>例會</strong>：${esc(set.upcomingMeetings)}</div>` : ''}
      ${set.specialEvent ? `<div><strong>特別活動</strong>：${esc(set.specialEvent)}</div>` : ''}
    </div>
  </div>` : ''}

  ${bodyHtml}

  ${qrItems ? `<div class="ch2-qrs">${qrItems}</div>` : ''}
</div>
`;

      return [page1, page2];
    },
  },

  // --------------------------------------------------------------
  // CHINA — "CHANGE IN ACTION" layout for CHINA Toastmasters Club.
  // English-only agenda body built from CHINA_SCHEDULE (a fixed row
  // sequence, same shared role fields as every other template plus 4
  // CHINA-only ones) rather than a free-form per-meeting row list — see
  // CHINA_SCHEDULE's own comment. The "Next Meeting" column is resolved
  // live from `ctx.nextMeetingRoles` (the next chronological meeting's
  // data, looked up by the caller — app/agenda/page.js's
  // ensureNextMeetingRoles), not stored on this meeting. Page 2 adds a
  // previous-meeting recap, per-project Purpose/Evaluator reference
  // cards, a next-meeting speaker preview, the standard TM time-control
  // legend, the Officer Team roster, and Upcoming Events — the latter
  // two parsed from club settings text.
  // --------------------------------------------------------------
  china: {
    key: 'china',
    label: 'CHINA Toastmasters（CHANGE IN ACTION）',
    langToggle: false, // this layout is always English, matching the club's real agenda
    fixedLang: 'en',
    assetDefaults: CHINA_ASSETS,
    fieldDefaults: CHINA_FIELD_DEFAULTS,
    placeholders: CHINA_PLACEHOLDERS,
    settings: [
      { key: 'fb_qr_url', label: 'Facebook QR', type: 'image', store: 'column', group: 'template', section: '社群 QR（頁尾顯示用）', row: 'qr1' },
      { key: 'line_qr_url', label: 'LINE QR', type: 'image', store: 'column', group: 'template', section: '社群 QR（頁尾顯示用）', row: 'qr1' },
      { key: 'ig_qr_url', label: 'Instagram QR', type: 'image', store: 'setting', group: 'template', section: '社群 QR（頁尾顯示用）', row: 'qr2' },
      { key: 'threads_qr_url', label: 'Threads QR', type: 'image', store: 'setting', group: 'template', section: '社群 QR（頁尾顯示用）', row: 'qr2' },
      { key: 'evoting_qr_url', label: 'E-Voting QR', type: 'image', store: 'setting', group: 'template', section: '議程頁首 QR', row: 'qr3' },
      { key: 'membership_qr_url', label: 'Membership Registration QR', type: 'image', store: 'setting', group: 'template', section: '議程頁首 QR', row: 'qr3' },
      { key: 'charter_no', label: 'Club No.', type: 'text', store: 'column', group: 'template', section: 'CHINA 專屬', row: 'meta', placeholder: '5844-67' },
      { key: 'founded_date', label: 'Since', type: 'text', store: 'column', group: 'template', section: 'CHINA 專屬', row: 'meta', placeholder: '1985' },
      { key: 'scheduleText', label: '會議時間 Meeting Time', type: 'text', store: 'setting', group: 'template', section: 'CHINA 專屬', placeholder: 'Every 2nd & 4th Thursday, 18:45-21:15' },
      { key: 'venue', label: '地點 Venue', type: 'textarea', store: 'setting', group: 'template', section: 'CHINA 專屬', placeholder: '台北市基隆路一段 333號27樓 2703室（國貿大樓 資誠會計師事務所）' },
      { key: 'admissionFeeText', label: '入場費 Admission Fee', type: 'text', store: 'setting', group: 'template', section: 'CHINA 專屬', placeholder: 'NT$100 for guest, NT$50 for student, free for member' },
      { key: 'contactEmail', label: '聯絡 Email', type: 'text', store: 'setting', group: 'template', section: 'CHINA 專屬', placeholder: 'CHINA@toastmasters.org.tw' },
      { key: 'officerTeamYear', label: '幹部任期 Officer Team 年度', type: 'text', store: 'setting', group: 'template', section: '幹部與活動', placeholder: '2026 - 2027' },
      { key: 'officerTeam', label: '幹部名單 Officer Team（每行：職稱|Lead|Deputy）', type: 'textarea', store: 'setting', group: 'template', section: '幹部與活動', placeholder: 'President|Eric Kuo|\nVice President Education|Emma Liu|Judy Hsu' },
      { key: 'upcomingEvents', label: '近期活動 Upcoming Events（每行：日期|活動）', type: 'textarea', store: 'setting', group: 'template', section: '幹部與活動', placeholder: '2026/08/02|1st Club Officer Training' },
    ],
    render(data, club, ctx) {
      const { esc, formatDate, displayMember, buildSpeechAgendaLine } = ctx;
      const set = (club && club.settings) || {};
      const A = CHINA_ASSETS;
      const next = ctx.nextMeetingRoles || {};

      const brand = {
        nameZh: (club && club.name_zh) || '中華英語國際演講會',
        nameEn: (club && club.name_en) || 'CHINA Toastmasters Club, Taiwan (R.O.C.)',
        clubNo: (club && club.charter_no) || '5844-67',
        since: (club && club.founded_date) || '1985',
      };
      const img = {
        logo: (club && club.logo_url) || A.logo_url,
        fb: (club && club.fb_qr_url) || A.fb_qr_url,
        line: (club && club.line_qr_url) || A.line_qr_url,
        ig: set.ig_qr_url || A.ig_qr_url,
        threads: set.threads_qr_url || A.threads_qr_url,
        evoting: set.evoting_qr_url || A.evoting_qr_url,
        membership: set.membership_qr_url || A.membership_qr_url,
      };
      const scheduleText = set.scheduleText || CHINA_FIELD_DEFAULTS.scheduleText;
      const admissionFeeText = set.admissionFeeText || CHINA_FIELD_DEFAULTS.admissionFeeText;
      const contactEmail = set.contactEmail || 'CHINA@toastmasters.org.tw';

      // "Role|Lead|Deputy" / "Date|Event" — one entry per line, blank lines skipped.
      const parseLines = (text, n) => (text || '').split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => { const parts = l.split('|').map((p) => p.trim()); while (parts.length < n) parts.push(''); return parts; });
      const officerRows = parseLines(set.officerTeam, 3);
      const eventRows = parseLines(set.upcomingEvents, 2);

      const dateDisplay = data.meetingDate ? formatDate(data.meetingDate) : '____.__.__';
      const nextDateDisplay = next.meetingDate ? formatDate(next.meetingDate) : '';

      const qrImg = (src, alt) => src ? `<img src="${src}" class="china-qr-img" alt="${esc(alt)}">` : `<div class="china-qr-ph"></div>`;

      // ---- Page 1 ----
      const logoHtml = img.logo ? `<img src="${img.logo}" class="china-logo-img" alt="logo">` : `<div class="china-logo-ph"><span>TM</span></div>`;

      const m = (v) => esc(displayMember(v));

      const rowAssignee = (row, src) => {
        if (row.kind === 'speech')    return m((src.speeches || [])[row.idx]?.speaker);
        if (row.kind === 'evaluator') return m((src.evaluators || [])[row.idx]);
        if (row.kind === 'evalEvaluator') return m(evalEvaluatorList(src)[row.idx]);
        if (!row.fields) return '';
        return row.fields.map((f) => m(src[f])).filter(Boolean).join(' / ');
      };
      // Speech rows show the title + Pathways code (shared formatting, same as
      // every other template — ctx.buildSpeechAgendaLine). Evaluation rows
      // reference the matching speech (same idx) by that same formatted line,
      // prefixed to make clear this row is its evaluation, not the speech itself.
      const rowProgram = (row) => {
        const sp = (data.speeches || [])[row.idx] || {};
        if (row.kind === 'speech')    return buildSpeechAgendaLine(sp);
        if (row.kind === 'evaluator') return `Evaluation for Speaker ${row.idx + 1}\n${buildSpeechAgendaLine(sp)}`;
        if (row.kind === 'evalEvaluator') return `Evaluator's Evaluator ${row.idx + 1}`;
        return esc(row.program);
      };

      // The 講評員講評 rows (if any) are spliced in after 總講評 — the schedule
      // itself stays a fixed literal; only this meeting's copy grows.
      const tbody = expandChinaSchedule(data, next).map((row) => `
    <tr class="${row.section ? 'china-row-section' : ''}">
      <td class="china-time">${esc(row.time)}</td>
      <td class="china-dur">${esc(row.duration)}</td>
      <td class="china-program">${rowProgram(row)}</td>
      <td class="china-assignee">${rowAssignee(row, data)}</td>
      <td class="china-assignee">${rowAssignee(row, next)}</td>
    </tr>`).join('');

      const page1 = `
<div class="china-header">
  <div class="china-logo">${logoHtml}<div class="china-logo-tagline">WHERE LEADERS ARE MADE</div></div>
  <div class="china-titles">
    <div class="china-title-main"><span class="china-title-accent">CH</span>ANGE <span class="china-title-accent">IN</span> <span class="china-title-accent">A</span>CTION</div>
    <div class="china-name-zh">${esc(brand.nameZh)}</div>
    <div class="china-name-en">${esc(brand.nameEn)}</div>
  </div>
  <div class="china-meta-right">
    <div>Club No. ${esc(brand.clubNo)}</div>
    <div>Since ${esc(brand.since)}</div>
  </div>
</div>

<div class="china-infobar">
  <div>Meeting Time : ${esc(scheduleText)}</div>
  <div>Venue: ${esc(data.venueInfo).replace(/\n/g, '<br>')}</div>
  <div>Admission Fee : ${esc(admissionFeeText)}</div>
</div>

<div class="china-meetingbar">
  <div>Meeting No. ${esc(data.meetingNo)}</div>
  <div>Date(Y/M/D): <strong class="china-date-val">${dateDisplay}</strong></div>
</div>

<div class="china-theme">
  <div><strong>Theme:</strong> ${esc(data.meetingTheme) || '—'}</div>
  ${data.tableTopicsQuestion ? `<div><strong>Question:</strong> ${esc(data.tableTopicsQuestion)}</div>` : ''}
</div>

<table class="china-table">
  <thead>
    <tr>
      <th>Time</th><th>min.</th><th>Program</th>
      <th>${dateDisplay}</th><th>${nextDateDisplay || 'Next Meeting'}</th>
    </tr>
  </thead>
  <tbody>${tbody}</tbody>
</table>

<div class="china-consent">Photo and video consent: Please note that photos and videos will be taken during this event for use on our social media platforms. By attending, you consent to being photographed and recorded. If you prefer not to appear in any photos or videos, please inform our officers upon arrival or excuse yourself during the group photo. Thank you for your understanding!</div>

<div class="china-qrrow">
  <div class="china-qr-item"><div class="china-qr-lbl">E-Voting</div>${qrImg(img.evoting, 'E-Voting')}</div>
  <div class="china-qr-item"><div class="china-qr-lbl">Membership Registration</div>${qrImg(img.membership, 'Membership Registration')}</div>
  <div class="china-join"><div class="china-join-title">Join Us NOW!</div>Talk to club officers for <strong>member benefits!</strong></div>
</div>
`;

      // ---- Page 2 ----
      const pm = { label: 'The Fresh Start Before', date: '', attendMembers: '', attendGuests: '', bestSpeaker: '', bestEvaluator: '', bestTopicsSpeaker: '', bestSessionMaster: '', ...(data.prevMeeting || {}) };
      const projects = (Array.isArray(data.speechProjects) && data.speechProjects.length) ? data.speechProjects : [{}, {}, {}];
      const nextSpeakers = (Array.isArray(data.nextSpeakers) && data.nextSpeakers.length) ? data.nextSpeakers : ['', '', ''];

      const projectCards = projects.map((p, i) => `
  <div class="china-project">
    <div class="china-project-h">Speaker ${i + 1}: <strong>${esc(p.speaker) || '—'}</strong>${p.spotlight ? ' <span class="china-spotlight">(Spotlight)</span>' : ''}</div>
    ${p.projectCode ? `<div class="china-project-code">${esc(p.projectCode)}</div>` : ''}
    ${p.purpose ? `<div class="china-project-line"><span>Purpose:</span> ${esc(p.purpose)}</div>` : ''}
    ${p.evaluatorNote ? `<div class="china-project-line"><span>Evaluator:</span> ${esc(p.evaluatorNote)}</div>` : ''}
  </div>`).join('');

      const futureList = nextSpeakers.map((n, i) => `<div class="china-future-item"><strong>Speaker${i + 1}:</strong> ${esc(n) || '—'}</div>`).join('');

      const officerTeamLabel = `Officer Team${set.officerTeamYear ? ` ${set.officerTeamYear}` : ''}`;
      const officerTable = officerRows.length ? `
<table class="china-officer-table">
  <thead><tr><th>${esc(officerTeamLabel)}</th><th>Lead</th><th>Deputy</th></tr></thead>
  <tbody>${officerRows.map(([role, lead, deputy]) => `<tr><td>${esc(role)}</td><td>${esc(lead)}</td><td>${esc(deputy)}</td></tr>`).join('')}</tbody>
</table>` : '';

      const upcomingList = eventRows.length ? eventRows.map(([d, e]) => `<div>${esc(d)} ${esc(e)}</div>`).join('') : '';

      const socialQrs = [[img.fb, 'Facebook'], [img.ig, 'Instagram'], [img.line, 'LINE'], [img.threads, 'Threads']]
        .filter(([u]) => u).map(([u, label]) => `<div class="china-social-qr">${qrImg(u, label)}<div class="china-qr-lbl">${label}</div></div>`).join('');

      const page2 = `
<div class="china-recap">
  <div class="china-recap-stats">
    <div class="china-recap-title">${esc(pm.label)}${pm.date ? `, ${esc(pm.date)}` : ''}</div>
    <div class="china-recap-inline"><span>Attend Members: <strong>${esc(pm.attendMembers)}</strong></span><span>Attend Guests: <strong>${esc(pm.attendGuests)}</strong></span></div>
    <div>Best Speaker: <strong>${esc(pm.bestSpeaker)}</strong></div>
    <div>Best Evaluator: <strong>${esc(pm.bestEvaluator)}</strong></div>
    <div>Best Topics Speaker: <strong>${esc(pm.bestTopicsSpeaker)}</strong></div>
    <div>Best Session Master: <strong>${esc(pm.bestSessionMaster)}</strong></div>
  </div>
</div>

<div class="china-section-title">The ENGAGING Present</div>
<div class="china-projects">${projectCards}</div>

<div class="china-section-title">The PROMISING Future</div>
<div class="china-future">${futureList}</div>

<div class="china-timecontrol">
  <div class="china-section-title">What you need to know – Time Control</div>
  <table class="china-tc-table">
    <thead><tr><td></td><th class="tc-g">min</th><th class="tc-y">ok</th><th class="tc-r">max</th></tr></thead>
    <tbody>
      <tr><td>Prepared Speech</td><td class="tc-g">5</td><td class="tc-y">6</td><td class="tc-r">7</td></tr>
      <tr><td>Table Topics</td><td class="tc-g">1</td><td class="tc-y">1.5</td><td class="tc-r">2</td></tr>
      <tr><td>Individual Evaluations</td><td class="tc-g">2</td><td class="tc-y">2.5</td><td class="tc-r">3</td></tr>
      <tr><td>General/Language Evaluator</td><td class="tc-g">3</td><td class="tc-y">4</td><td class="tc-r">5</td></tr>
    </tbody>
  </table>
</div>

${officerTable}

<div class="china-footer-brand">CHANGE IN ACTION</div>

<div class="china-connect">
  <div><strong>Connect with us online!</strong></div>
  <div><strong>Email: ${esc(contactEmail)}</strong></div>
  <div class="china-social-qrs">${socialQrs}</div>
</div>

${upcomingList ? `<div class="china-section-title">Upcoming Events</div><div class="china-upcoming">${upcomingList}</div>` : ''}
`;

      return [page1, page2];
    },
  },

  // --------------------------------------------------------------
  // ENTREPRENEUR — the Entrepreneur Toastmasters Club's own template, and
  // the live one: this is the entry to edit when that club's agenda layout
  // changes. It started as a copy of `standard` and still renders identically,
  // but it owns its render() and its own default assets/fields/placeholders
  // outright — nothing here is shared with `standard`, so the two can diverge
  // freely. `standard` is deliberately frozen: it exists only so club records
  // still on template_key='standard' keep rendering exactly as they always did.
  //
  // The styling is forked the same way: agenda.css carries two independent
  // copies of this layout's rules, namespaced `.tmpl-standard` and
  // `.tmpl-entrepreneur`, so editing either one — markup or CSS — cannot reach
  // the other. (`.agenda-page` and the `.tc-*` colour chips stay global: the
  // first is every template's sheet frame, the second is shared with CHINA.)
  // --------------------------------------------------------------
  entrepreneur: {
    key: 'entrepreneur',
    label: '企業家版',
    langToggle: true, // offers a 中/英 switch
    assetDefaults: ENTREPRENEUR_ASSETS,
    fieldDefaults: ENTREPRENEUR_FIELD_DEFAULTS,
    placeholders: ENTREPRENEUR_PLACEHOLDERS,
    // Manifest of this template's club-editable fields. Drives the 版型設定
    // modal (rendering, populate, save) in app/club/page.js — declare a field once here.
    //   store: 'column' (top-level club field) | 'setting' (settings JSON)
    //   group: 'basic' (編輯) | 'template' (版型)   row: pair fields in a 2-col grid
    settings: [
      { key: 'fb_qr_url', label: 'Facebook QR', type: 'image', store: 'column', group: 'template', section: '社群 QR（議程顯示用）', row: 'qr' },
      { key: 'line_qr_url', label: 'LINE QR', type: 'image', store: 'column', group: 'template', section: '社群 QR（議程顯示用）', row: 'qr' },
      { key: 'charter_no', label: '章程編號', type: 'text', store: 'column', group: 'template', section: '企業家版專屬', row: 'meta', placeholder: 'No. 4069930' },
      { key: 'founded_date', label: '成立日', type: 'text', store: 'column', group: 'template', section: '企業家版專屬', row: 'meta', placeholder: '2014.06.29' },
      { key: 'timeRange', label: '預設時間 Time（議程可覆寫；日期仍動態帶入當日）', type: 'text', store: 'setting', group: 'template', section: '企業家版專屬', placeholder: '19:10 ~ 21:00' },
      { key: 'venue', label: '預設地點 Venue（議程可覆寫）', type: 'textarea', store: 'setting', group: 'template', section: '企業家版專屬', placeholder: 'Venue: 鑫喜文創｜台北市信義區忠孝東路五段71巷11弄25號1樓\n（捷運板南線：市政府站4號出口，走路3分鐘）' },
      { key: 'scheduleZh', label: '會議日期行（中文）', type: 'text', store: 'setting', group: 'template', section: '企業家版專屬', placeholder: '會議日期為每月第 1 個星期二 (中文) / 第 3 個星期二 (English)' },
      { key: 'scheduleEn', label: '會議日期行（English）', type: 'text', store: 'setting', group: 'template', section: '企業家版專屬', placeholder: 'Meeting on every 1st (中文) and 3rd (English) Tuesday evening' },
    ],
    render(data, club, ctx) {
      const {
        t, esc, calcTimes, displayMember, buildSpeechAgendaLine,
        formatDate, varietySession, durationLabels, PATHWAYS, PATHWAYS_ZH, images, lang,
      } = ctx;

      const brand = {
        nameZh: (club && club.name_zh) || '企業家國際演講會',
        nameEn: (club && club.name_en) || 'Entrepreneur Toastmasters Club',
        charterNo: (club && club.charter_no) || 'No. 4069930',
        founded: (club && club.founded_date) || '2014.06.29',
        fee: (club && club.fee) || 'NTD150',
      };

      // Meeting-schedule line is club-managed (per language); fall back to the
      // historic hard-coded translation when a club hasn't set it.
      const set = (club && club.settings) || {};
      const schedule = (lang === 'zh' ? set.scheduleZh : set.scheduleEn) || t('meetingSchedule');

      // ---- header ----
      const dateDisplay = data.meetingDate ? formatDate(data.meetingDate) : '____.__.__';
      const logoHtml = images.logo
        ? `<img src="${images.logo}" class="hg-logo-img" alt="TM Logo">`
        : `<div class="hg-logo-ph"><div class="logo-ring"><span>TM</span></div></div>`;
      const themeImgHtml = images.themeImg
        ? `<img src="${images.themeImg}" class="hg-theme-img" alt="Theme">`
        : `<div class="hg-theme-ph"><span>Theme<br>Image</span></div>`;

      const headerHtml = `<div class="doc-header">
  <div class="hg-logo">${logoHtml}</div>
  <div class="hg-names">
    <div class="club-name-zh">${esc(brand.nameZh)}</div>
    <div class="club-name-en">${esc(brand.nameEn)}</div>
  </div>
  <div class="hg-img">${themeImgHtml}</div>
  <div class="hg-meta-left">
    <div>${esc(brand.charterNo)}</div>
    <div>${t('foundedSince')}:</div>
    <div>${esc(brand.founded)}</div>
    <div>&nbsp;</div>
    <div>${t('fee')} : ${esc(brand.fee)}</div>
  </div>
  <div class="hg-meta-right">
    <div class="hmr-text" style="grid-column:span 2"><strong>${t('thTime')} : ${dateDisplay} ｜ ${esc(data.timeRange)}</strong></div>
    <div class="hmr-text" style="grid-column:span 2">${esc(schedule)}</div>
    <div class="hmr-text" style="grid-column:span 2">${esc(data.venueInfo).replace(/\n/g, '<br>')}</div>
  </div>
</div>`;

      // ---- right panel (pathways / time rules / QR) ----
      const pwSource = lang === 'zh' ? PATHWAYS_ZH : PATHWAYS;
      const pwList = pwSource.map(([code, name]) =>
        `<div class="rp-pw"><span class="rp-pwc">${esc(code)}｜</span><em class="rp-pwn">${esc(name)}</em></div>`
      ).join('');
      const fbContent = images.fbQr
        ? `<img src="${images.fbQr}" class="qr-img" alt="FB QR">`
        : `<div class="qr-ph"></div>`;
      const lineContent = images.lineQr
        ? `<img src="${images.lineQr}" class="qr-img" alt="LINE QR">`
        : `<div class="qr-ph"></div>`;

      const rightPanelHtml = `<div class="rp-wrap">
  <div class="rp-pw-list">${pwList}</div>
  <div class="rp-tr">
    <div class="rp-tr-title">${t('timeRules')}</div>
    <table class="rp-tr-table">
      <thead><tr><td></td><th class="tc-g">min</th><th class="tc-y">ok</th><th class="tc-r">max</th></tr></thead>
      <tbody>
        <tr><td class="tr-lbl">${t('trPrepared')}</td><td class="tc-g">5</td><td class="tc-y">6</td><td class="tc-r">7</td></tr>
        <tr><td class="tr-lbl">${t('trTopic')}</td><td class="tc-g">1</td><td class="tc-y">1.5</td><td class="tc-r">2</td></tr>
        <tr><td class="tr-lbl">${t('trEval')}</td><td class="tc-g">2</td><td class="tc-y">2.5</td><td class="tc-r">3</td></tr>
        <tr><td class="tr-lbl">${t('trLEGE')}</td><td class="tc-g">3</td><td class="tc-y">4</td><td class="tc-r">5</td></tr>
      </tbody>
    </table>
  </div>
  <div class="rp-qr-items">
    <div class="rp-qr-item">${fbContent}<div class="rp-qr-lbl">${t('fbLabel')}</div></div>
    <div class="rp-qr-item">${lineContent}<div class="rp-qr-lbl">${t('lineLabel')}</div></div>
  </div>
</div>`;

      // ---- body table ----
      const speechCount = data.speeches.length;
      const evalCount = data.evaluators.length;
      const evalEvals = evalEvaluatorList(data);
      const times = calcTimes(data.speeches);
      const DL = { ...DEFAULT_DURATION_LABELS, ...(durationLabels || {}) };

      // rows: reception(1) + opening(5) + speech_header(1) + speeches(N)
      //       + photo(1) + intermission(1) + topics(1) + spacer(1)
      //       + eval_header(1) + evaluators(M) + timer(1) + ah(1) + LE(1) + GE(1)
      //       + eval-evaluators(K) + closing(2) + sharing(1) + meeting-end(1)  = 20 + N + M + K
      const totalRows = 20 + speechCount + evalCount + evalEvals.length;

      // Dynamic duration column width: size it to the longest single-column
      // duration string (e.g. "12'-15'") so double-digit minutes don't overflow.
      const DUR_POOL = 69; // mm shared by col-dur + col-agenda
      const durStrings = data.speeches.map((sp) => sp.duration || "5'-7'").concat(Object.values(DL));
      const maxDurLen = durStrings.reduce((m, s) => Math.max(m, String(s).length), 0);
      const durWidth = Math.min(16, Math.max(8, Math.round(maxDurLen * 1.5 + 3)));
      const agendaWidth = DUR_POOL - durWidth;

      let tbody = '';

      // Reception — right panel cell starts here with rowspan
      tbody += `
  <tr>
    <td class="time-cell">${times.receptionStart}</td>
    <td class="dur-cell" colspan="2">${times.receptionMins}'</td>
    <td class="agenda-cell">${t('reception')}</td>
    <td class="taker-cell">${esc(displayMember(data.receptionHost))}</td>
    <td class="rp-cell" rowspan="${totalRows}">${rightPanelHtml}</td>
  </tr>`;

      // Opening block — time & dur rowspan 5
      tbody += `
  <tr>
    <td class="time-cell" rowspan="5">${times.openingStart}</td>
    <td class="dur-cell" rowspan="5" colspan="2">${times.openingMins}'</td>
    <td class="agenda-cell">${t('callingOrder')}</td>
    <td class="taker-cell">${esc(displayMember(data.callingToOrder))}</td>
  </tr>
  <tr>
    <td class="agenda-cell">${t('welcomeGuests')}</td>
    <td class="taker-cell">${esc(displayMember(data.welcomeTME))}</td>
  </tr>
  <tr>
    <td class="agenda-cell">${t('tmeIntro')}</td>
    <td class="taker-cell">${esc(displayMember(data.tme))}</td>
  </tr>
  <tr>
    <td class="agenda-cell">${t('timerExplain')}</td>
    <td class="taker-cell">${esc(displayMember(data.timer))}</td>
  </tr>
  <tr>
    <td class="agenda-cell">${t('ahExplain')}</td>
    <td class="taker-cell">${esc(displayMember(data.ahCounter))}</td>
  </tr>`;

      // Variety Session (optional)
      if (varietySession.enabled) {
        tbody += `
  <tr class="row-section">
    <td class="time-cell">${times.speechStart}</td>
    <td class="dur-cell" colspan="2">${times.varietyMins}'</td>
    <td class="agenda-cell"><strong>${t('varietySession')}</strong></td>
    <td class="taker-cell">${esc(displayMember(varietySession.host))}</td>
  </tr>`;
      }

      // Prepared Speech block — time rowspan = 1 + speechCount
      const speechBlockSpan = 1 + speechCount;
      tbody += `
  <tr class="row-section">
    <td class="time-cell" rowspan="${speechBlockSpan}">${times.preparedSpeechStart}</td>
    <td class="secdur-cell" rowspan="${speechBlockSpan}">${times.speechMins}'</td>
    <td class="agenda-cell" colspan="2"><strong>${t('preparedSpeech')}</strong></td>
    <td class="taker-cell">${esc(displayMember(data.tme))}</td>
  </tr>`;

      data.speeches.forEach((sp) => {
        tbody += `
  <tr>
    <td class="dur-cell">${esc(sp.duration || "5'-7'")}</td>
    <td class="agenda-cell">${buildSpeechAgendaLine(sp)}</td>
    <td class="taker-cell">${esc(displayMember(sp.speaker))}</td>
  </tr>`;
      });

      // Group Photo
      tbody += `
  <tr>
    <td class="time-cell">${times.photoStart}</td>
    <td class="dur-cell" colspan="2">${times.photoMins}'</td>
    <td class="agenda-cell">${t('groupPhoto')}</td>
    <td class="taker-cell">${t('allParticipants')}</td>
  </tr>`;

      // Intermission
      tbody += `
  <tr class="row-intermission">
    <td colspan="5">${t('intermission', times.intermissionMins)}</td>
  </tr>`;

      // Table Topics
      tbody += `
  <tr class="row-section">
    <td class="time-cell">${times.topicsStart}</td>
    <td class="dur-cell" colspan="2">${times.topicsMins}'</td>
    <td class="agenda-cell"><strong>${t('tableTopics')}</strong></td>
    <td class="taker-cell">${esc(displayMember(data.tableTopicsMaster))}</td>
  </tr>`;

      // Spacer
      tbody += `<tr class="row-spacer"><td colspan="5"></td></tr>`;

      // Evaluation block — rowspan = 1 (header) + M (evaluators)
      //                            + 4 (timer, ah, LE, GE) + K (講評員講評)
      const evalRowSpan = evalCount + evalEvals.length + 5;
      tbody += `
  <tr class="row-section">
    <td class="time-cell" rowspan="${evalRowSpan}">${times.evalStart}</td>
    <td class="secdur-cell" rowspan="${evalRowSpan}">${times.evalMins}'</td>
    <td class="agenda-cell" colspan="2"><strong>${t('evaluation')}</strong></td>
    <td class="taker-cell">${esc(displayMember(data.generalEvaluator))}</td>
  </tr>`;

      data.evaluators.forEach((ev, i) => {
        tbody += `
  <tr>
    <td class="dur-cell">${esc(DL.evaluator)}</td>
    <td class="agenda-cell">${t('evaluatorFor', i + 1)}</td>
    <td class="taker-cell">${esc(displayMember(ev))}</td>
  </tr>`;
      });

      tbody += `
  <tr>
    <td class="dur-cell">${esc(DL.timerReport)}</td>
    <td class="agenda-cell">${t('timerReport')}</td>
    <td class="taker-cell">${esc(displayMember(data.timer))}</td>
  </tr>
  <tr>
    <td class="dur-cell">${esc(DL.ahReport)}</td>
    <td class="agenda-cell">${t('ahReport')}</td>
    <td class="taker-cell">${esc(displayMember(data.ahCounter))}</td>
  </tr>
  <tr>
    <td class="dur-cell">${esc(DL.langEval)}</td>
    <td class="agenda-cell">${t('langEval')}</td>
    <td class="taker-cell">${esc(displayMember(data.langEvaluator))}</td>
  </tr>
  <tr>
    <td class="dur-cell">${esc(DL.generalEval)}</td>
    <td class="agenda-cell">${t('generalEval')}</td>
    <td class="taker-cell">${esc(displayMember(data.generalEvaluator))}</td>
  </tr>`;

      // 講評員講評 — optional, closes out the evaluation block after 總講評.
      evalEvals.forEach((ev, i) => {
        tbody += `
  <tr>
    <td class="dur-cell">${esc(DL.evalEvaluator)}</td>
    <td class="agenda-cell">${t('evalEvaluatorFor', i + 1)}</td>
    <td class="taker-cell">${esc(displayMember(ev))}</td>
  </tr>`;
      });

      // Closing — time rowspan 2
      tbody += `
  <tr>
    <td class="time-cell" rowspan="2">${times.closingStart}</td>
    <td class="dur-cell" colspan="2">${Math.ceil(times.closingMins / 2)}'</td>
    <td class="agenda-cell">${t('tmeClosing')}</td>
    <td class="taker-cell">${esc(displayMember(data.tme))}</td>
  </tr>
  <tr>
    <td class="dur-cell" colspan="2">${Math.floor(times.closingMins / 2)}'</td>
    <td class="agenda-cell">${t('awards')}</td>
    <td class="taker-cell">${esc(displayMember(data.awardsPresenter))}</td>
  </tr>`;

      // Sharing & Feedback
      tbody += `
  <tr>
    <td class="time-cell">${times.sharingStart}</td>
    <td class="dur-cell" colspan="2">${times.sharingMins}'</td>
    <td class="agenda-cell">${t('sharing')}</td>
    <td class="taker-cell">${esc(displayMember(data.sharingFeedback))}</td>
  </tr>
  <tr>
    <td class="time-cell">${times.meetingEnd}</td>
    <td class="dur-cell" colspan="2"></td>
    <td class="agenda-cell">${t('meetingEnd')}</td>
    <td class="taker-cell"></td>
  </tr>`;

      return `
${headerHtml}

<div class="theme-row">
  <span class="theme-label">${t('themeLabel')}</span>
  <span class="theme-value"><strong><em>${esc(data.meetingTheme) || '—'}</em></strong></span>
  <span class="meeting-no-label">${t('meetingNoLabel', data.meetingNo)}</span>
</div>

<div class="mission-section">
  <div class="mission-title">${t('missionTitle')}</div>
  <div class="mission-text">${t('missionText')}</div>
</div>

<table class="agenda-table">
  <colgroup>
    <col class="col-time">
    <col class="col-secdur">
    <col class="col-dur" style="width:${durWidth}mm">
    <col class="col-agenda" style="width:${agendaWidth}mm">
    <col class="col-taker">
    <col class="col-rp">
  </colgroup>
  <thead>
    <tr>
      <th>${t('thTime')}</th>
      <th colspan="2"></th>
      <th>${t('thAgenda')}</th>
      <th>${t('thTaker')}</th>
      <th>${t('thPathways')}</th>
    </tr>
  </thead>
  <tbody>${tbody}</tbody>
</table>

<div class="agenda-footer">${t('adjournment')}</div>
`;
    },
  },
};

// Metadata for the club-management template picker (no render fns).
export const TEMPLATE_OPTIONS = Object.values(AGENDA_TEMPLATES).map((t) => ({ key: t.key, label: t.label }));

// Per-template default resolvers (single source of truth for fallbacks).
// Used by the agenda page and club page so default assets/values live in one place.
// Unrecognized/missing key falls back to `compact` — the neutral template with
// no club-specific branding baked in — not `standard`/`entrepreneur`, so a club
// that hasn't picked (or mistyped) a template never inherits Entrepreneur's info.
export function templateAssetDefaults(key) {
  return (AGENDA_TEMPLATES[key] || AGENDA_TEMPLATES.compact).assetDefaults || {};
}
export function templateFieldDefaults(key) {
  return (AGENDA_TEMPLATES[key] || AGENDA_TEMPLATES.compact).fieldDefaults || {};
}
export function templatePlaceholders(key) {
  return (AGENDA_TEMPLATES[key] || AGENDA_TEMPLATES.compact).placeholders || {};
}

// Unified per-template visibility: show elements whose data-tmpl lists `key`,
// hide the rest. Used by the agenda form; the club modal generates its
// template-specific fields directly, so it doesn't need this.
export function applyTmplVisibility(root, key) {
  root.querySelectorAll('[data-tmpl]').forEach((el) => {
    el.style.display = el.dataset.tmpl.split(/\s+/).includes(key) ? '' : 'none';
  });
}
