'use strict';

// ================================================================
// AUTH
// ================================================================
async function checkAuth() {
  const token = getToken();
  if (!token) { window.location.href = '/login'; return; }
  try {
    const res = await fetch(`${API_BASE}/api/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      // Keep localStorage in sync with server (role/club_id may have changed)
      setAuth(data.token || token, data.username, data.role, data.club_id, data.must_change_pw);
      if (data.must_change_pw) {
        window.location.href = '/change-password';
        return;
      }
      document.querySelector('.app-layout').style.display = 'flex';
      const btn = document.getElementById('logoutBtn');
      if (btn) btn.textContent = `登出（${getUsername()}）`;
    } else {
      clearAuth();
      window.location.href = '/login';
    }
  } catch {
    clearAuth();
    window.location.href = '/login';
  }
}

function doLogout() {
  if (!confirm('確定要登出嗎？')) return;
  clearAuth();
  window.location.href = '/login';
}

// ================================================================
// CONSTANTS
// ================================================================
const PATHWAYS = [
  ['DL', 'Dynamic Leadership'],
  ['EH', 'Engaging Humor'],
  ['MS', 'Motivational Strategies'],
  ['PI', 'Persuasive Influence'],
  ['PM', 'Presentation Mastery'],
  ['VC', 'Visionary Communication'],
  ['EC', 'Effective Coaching'],
  ['IP', 'Innovative Planning'],
  ['SR', 'Strategic Relationships'],
  ['TC', 'Team Collaboration'],
  ['LD', 'Leadership Development'],
];

const PATHWAYS_ZH = [
  ['DL', '動態領導'],
  ['EH', '風趣表達'],
  ['MS', '激勵策略'],
  ['PI', '說服影響'],
  ['PM', '演講精粹'],
  ['VC', '願景溝通'],
  ['EC', '高效教練'],
  ['IP', '創新規劃'],
  ['SR', '策略人脈'],
  ['TC', '團隊合作'],
  ['LD', '領導力發展'],
];

const PATHWAY_OPTIONS = PATHWAYS.map(([code, name]) =>
  `<option value="${code}">${code} — ${name}</option>`
).join('');

// ================================================================
// STATE
// ================================================================
let speeches = [
  { title: 'TBD', speaker: '', duration: "5'-7'", pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
  { title: '', speaker: '', duration: "5'-7'", pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
  { title: '', speaker: '', duration: "5'-7'", pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
];

let evaluators = ['', '', ''];

let lang = 'en';

const TRANSLATIONS = {
  en: {
    reception:      'Reception & Social Gathering',
    callingOrder:   "1' Calling Meeting to Order",
    welcomeGuests:  "2' Welcome Guests & TME",
    tmeIntro:       "3' Toastmaster of The Evening",
    timerExplain:   "2' Timer｜Meeting Rules Explanation",
    ahExplain:      "2' Ah-counter｜Meeting Rules Explanation",
    preparedSpeech: 'Prepared Speech',
    groupPhoto:     'Group Photo',
    allParticipants:'All Participants',
    intermission:   n => `— Intermission & Social Time (${n} min) —`,
    tableTopics:    'Table Topics Session',
    evaluation:     'Evaluation Session',
    evaluatorFor:   n => `Individual Evaluator for Speaker #${n}`,
    timerReport:    'Timer Report',
    ahReport:       'Ah-counter Report',
    langEval:       'Language Evaluation',
    generalEval:    'General Evaluation',
    tmeClosing:     'Toastmaster of the Evening',
    awards:         'Awards Presentation',
    sharing:        'Sharing & Feedback',
    adjournment:    '— Meeting Adjournment —',
    thTime:         'Time',
    thAgenda:       'Agenda (Program)',
    thTaker:        'Assignment Taker',
    thPathways:     '⏱ Pathways',
    themeLabel:     'Meeting  Theme:',
    meetingNoLabel: n => `Meeting No.${n}`,
    missionTitle:   '— Mission of Toastmasters Club —',
    missionText:    '"We provide a supportive and positive learning experience in which members are empowered to develop communication and leadership skills, resulting in greater self-confidence and personal growth."',
    timeRules:      'Time Rules',
    trPrepared:     'Prepared Speech',
    trTopic:        'Table Topic',
    trEval:         'Evaluator',
    trLEGE:         'LE&GE',
    fbLabel:        'Follow us on FB!',
    lineLabel:      'Connect us with LINE@',
    foundedSince:    'Founded Since',
    fee:             'Fee',
    varietySession:  'Variety Session',
    meetingSchedule: 'Meeting on every 1st (中文) and 3rd (English) Tuesday evening',
  },
  zh: {
    reception:      '報到 & 交誼',
    callingOrder:   "1' 宣布例會開始－領導宣讀宣言",
    welcomeGuests:  "2' 會長致歡迎詞",
    tmeIntro:       "3' 總主持人",
    timerExplain:   "2' 計時員",
    ahExplain:      "2' 贅語記錄員",
    preparedSpeech: '指定演講',
    groupPhoto:     '大合照',
    allParticipants:'所有與會者',
    intermission:   n => ` ——— 休息 & 交誼時間（${n} 分鐘）——— `,
    tableTopics:    '即席問答',
    evaluation:     '講評時間',
    evaluatorFor:   n => `個別講評員 #${n}`,
    timerReport:    '計時員報告',
    ahReport:       '贅語記錄員報告',
    langEval:       '語言講評',
    generalEval:    '總講評',
    tmeClosing:     '總主持人',
    awards:         '贈感謝狀',
    sharing:        '會後分享 & 來賓回饋',
    adjournment:    '——— 會議圓滿 ———',
    thTime:         '時間',
    thAgenda:       '議程表',
    thTaker:        '角色擔任',
    thPathways:     '⏱ 學習路徑',
    themeLabel:     '會議主題：',
    meetingNoLabel: n => `第 ${n} 次例會`,
    missionTitle:   '——— 演講會宗旨 ———',
    missionText:    '訓練溝通及領導能力，強調終身學習。參加國際演講協會是增進溝通技巧的最佳方法，除了大幅增加公開演講的自信外，在這裡所學到的領導技巧，更是您邁向成功之路的必備基石。',
    timeRules:      '時間規則',
    trPrepared:     '指定演講',
    trTopic:        '即席問答',
    trEval:         '個別講評',
    trLEGE:         '語言&總講評',
    fbLabel:        '追蹤我們的 FB！',
    lineLabel:      '加入企業家 LINE 群組！',
    foundedSince:    '成立日期',
    fee:             '入場費',
    varietySession:  '多元單元',
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
  rebuildDatalist();
  refreshInputsForLang();
  updatePreview();
}

function refreshInputsForLang() {
  const staticFields = [
    'receptionHost', 'callingToOrder', 'welcomeTME', 'tme', 'timer', 'ahCounter',
    'tableTopicsMaster', 'generalEvaluator', 'langEvaluator', 'awardsPresenter', 'sharingFeedback',
  ];
  staticFields.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value) el.value = displayMember(el.value);
  });

  speeches.forEach(sp => {
    if (sp.speaker) sp.speaker = displayMember(sp.speaker);
  });
  evaluators = evaluators.map(ev => ev ? displayMember(ev) : ev);

  if (varietySession.host) {
    varietySession.host = displayMember(varietySession.host);
    const el = document.getElementById('varietyHost');
    if (el) el.value = varietySession.host;
  }

  renderSpeechForms();
  renderEvaluatorForms();
}

const timeOverrides = {
  endTime:         '',
  openingStart:    '',
  speechStart:     '',
  photoStart:      '',
  intermissionMins:'',
  topicsStart:     '',
  evalStart:       '',
  closingStart:    '',
  sharingStart:    '',
};

const durationSettings = {
  tmeMins: 4,
  geMins:  4,
};

function updateDuration(key, value) {
  const n = parseInt(value, 10);
  durationSettings[key] = isNaN(n) || n < 0 ? 0 : n;
  updatePreview();
}

const varietySession = {
  enabled:  false,
  duration: 15,
  host:     '',
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

const images = {
  logo:          'media/toastmasters_logo.png',
  themeImg:      null,
  themeImgBase64: null,  // local base64, avoids CORS when rendering to canvas
  fbQr:          'media/FacebookQR.png',
  lineQr:        'media/LINEQR.png',
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
    // Read local base64 first so download works even if R2 CORS blocks fetch
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const presignRes = await fetch(`${API_BASE}/api/upload/presign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
      },
      body: JSON.stringify({
        filename: file.name,
        content_type: file.type,
        meeting_date: val('meetingDate') || null,
        meeting_no: val('meetingNo') || null,
      }),
    });
    if (!presignRes.ok) throw new Error((await presignRes.json()).detail || '取得上傳網址失敗');
    const { uploadUrl, publicUrl } = await presignRes.json();

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
  container.innerHTML = speeches.map((sp, i) => `
    <div class="speech-entry" id="speech-${i}">
      <div class="speech-entry-header">
        <span>演講 #${i + 1}</span>
        <button class="btn-remove" onclick="removeSpeech(${i})">✕ 移除</button>
      </div>
      <div class="form-row">
        <label>演講標題 Title</label>
        <textarea rows="2" oninput="updateSpeech(${i},'title',this.value)">${sp.title}</textarea>
      </div>
      <div class="form-row">
        <label>講者 Speaker (姓名 + 頭銜)</label>
        <input type="text" class="member-ac" value="${sp.speaker}" oninput="updateSpeech(${i},'speaker',this.value)" placeholder="e.g. John Smith, TM">
      </div>
      <div class="form-row">
        <label>時長 Duration</label>
        <input type="text" value="${sp.duration}" oninput="updateSpeech(${i},'duration',this.value)" placeholder="5'-7'">
      </div>
      <div class="form-row">
        <label>學習路徑 Pathway</label>
        <select oninput="updateSpeech(${i},'pathwayCode',this.value)">
          <option value="">— 不指定 —</option>
          ${PATHWAY_OPTIONS}
        </select>
      </div>
      <div class="form-row">
        <label>等級 Level (e.g. L1P3)</label>
        <input type="text" value="${sp.pathwayLevel}" oninput="updateSpeech(${i},'pathwayLevel',this.value)" placeholder="L1P3">
      </div>
      <div class="form-row">
        <label>專案名稱 / 備註</label>
        <input type="text" value="${sp.pathwayProject}" oninput="updateSpeech(${i},'pathwayProject',this.value)" placeholder="Introduction to...">
      </div>
    </div>
  `).join('');

  speeches.forEach((sp, i) => {
    const sel = document.querySelector(`#speech-${i} select`);
    if (sel) sel.value = sp.pathwayCode || '';
  });

  renderEvaluatorForms();

  updatePreview();
}

function renderEvaluatorForms() {
  const container = document.getElementById('evaluatorsList');
  if (!container) return;
  container.innerHTML = evaluators.map((ev, i) => `
    <div class="speech-entry" style="padding:8px 10px">
      <div class="speech-entry-header">
        <span>講評 #${i + 1} <span class="time-hint">2'~3'</span></span>
        <button class="btn-remove" onclick="removeEvaluator(${i})">✕ 移除</button>
      </div>
      <div class="form-row" style="margin-bottom:0">
        <input type="text" value="${esc(ev)}"
               oninput="evaluators[${i}] = this.value; updatePreview()"
               placeholder="Name, Title" class="member-ac">
      </div>
    </div>
  `).join('') + `<button class="btn-add" onclick="addEvaluator()">+ 新增講評</button>`;
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

function addSpeech() {
  speeches.push({ title: '', speaker: '', duration: "5'-7'", pathwayCode: '', pathwayLevel: '', pathwayProject: '' });
  renderSpeechForms();
  updatePreview();
}

function removeSpeech(i) {
  speeches.splice(i, 1);
  renderSpeechForms();
  updatePreview();
}

function updateSpeech(i, key, val) {
  speeches[i][key] = val;
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
  const ov = timeOverrides;
  const valid = s => /^\d{1,2}:\d{2}$/.test((s || '').trim());
  const get   = (key, auto) => valid(ov[key]) ? ov[key].trim() : auto;

  const openingStart = get('openingStart', '19:10');
  const endTime      = get('endTime',      '21:00');
  const speechStart  = get('speechStart',  addMins(openingStart, 10));

  // variety session (optional, before prepared speeches)
  const varietyMins = varietySession.enabled ? varietySession.duration : 0;
  const preparedSpeechStart = addMins(speechStart, varietyMins);

  // speech block: sum of max durations + 4 min transition + TME hosting
  const speechMins = spList.reduce((s, sp) => s + parseDurationMax(sp.duration), 0) + 4 + durationSettings.tmeMins;
  const photoStart = get('photoStart', addMins(preparedSpeechStart, speechMins));

  // eval: 3' per evaluator + timer(1) + ah(1) + LE(5) + GE(5) + GE hosting
  const evalMins = evaluators.length * 3 + 12 + durationSettings.geMins;

  const ovIM = parseInt(timeOverrides.intermissionMins, 10);
  const hasManualIM = !isNaN(ovIM) && String(timeOverrides.intermissionMins).trim() !== '';

  const minIM   = hasManualIM ? ovIM : 5;
  const fixedMins = 10 + varietyMins + speechMins + 4 + evalMins + 6 + 10 + minIM;
  let   slack     = timeToMins(endTime) - timeToMins(openingStart) - fixedMins;

  let topicsMins, intermissionMins;
  if (hasManualIM) {
    intermissionMins = ovIM;
    topicsMins = 10 + Math.min(10, Math.max(0, slack));
  } else {
    const topicsExtra       = Math.min(10, Math.max(0, slack));
    slack -= topicsExtra;
    const intermissionExtra = Math.min(10, Math.max(0, slack));
    topicsMins       = 10 + topicsExtra;
    intermissionMins =  5 + intermissionExtra;
  }

  const topicsStart  = get('topicsStart',  addMins(photoStart,  5 + intermissionMins));
  const evalStart    = get('evalStart',    addMins(topicsStart, topicsMins));
  const closingStart = get('closingStart', addMins(evalStart,   evalMins));
  // closing: TME(3') + awards(3') = 6 min
  const sharingStart = get('sharingStart', addMins(closingStart, 6));

  return { openingStart, endTime, speechStart, varietyMins, preparedSpeechStart, speechMins, photoStart, topicsStart, evalStart, evalMins, closingStart, sharingStart, intermissionMins, topicsMins };
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

function refreshAutoHints() {
  const times = calcTimes(speeches);
  [
    ['endTime',      times.endTime],
    ['openingStart', times.openingStart],
    ['speechStart',  times.speechStart],
    ['photoStart',   times.photoStart],
    ['topicsStart',  times.topicsStart],
    ['evalStart',    times.evalStart],
    ['closingStart', times.closingStart],
    ['sharingStart', times.sharingStart],
  ].forEach(([key, val]) => {
    const el = document.getElementById(`auto_${key}`);
    if (el) el.textContent = `自動: ${val}`;
    const input = document.getElementById(`to_${key}`);
    if (input) input.classList.toggle('is-overridden', !!timeOverrides[key].trim());
  });

  const imEl = document.getElementById('auto_intermissionMins');
  if (imEl) imEl.textContent = `自動: ${times.intermissionMins} 分鐘`;
  const imInput = document.getElementById('to_intermissionMins');
  if (imInput) imInput.classList.toggle('is-overridden', !!String(timeOverrides.intermissionMins).trim());
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
  if (sp.pathwayCode)    parts.push(sp.pathwayCode);
  if (sp.pathwayLevel)   parts.push(sp.pathwayLevel);
  if (sp.pathwayProject) parts.push(sp.pathwayProject);
  if (parts.length) line += `\n [${parts.join(' - ')}]`;
  return line;
}

// ================================================================
// RIGHT PANEL BUILDER
// ================================================================
function buildRightPanel() {
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

  return `<div class="rp-wrap">
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
}

// ================================================================
// HEADER BUILDER
// ================================================================
function buildHeader(data) {
  const dateDisplay = data.meetingDate ? formatDate(data.meetingDate) : '____.__.__';

  const logoHtml = images.logo
    ? `<img src="${images.logo}" class="hg-logo-img" alt="TM Logo">`
    : `<div class="hg-logo-ph"><div class="logo-ring"><span>TM</span></div></div>`;

  const themeImgHtml = images.themeImg
    ? `<img src="${images.themeImg}" class="hg-theme-img" alt="Theme">`
    : `<div class="hg-theme-ph"><span>Theme<br>Image</span></div>`;

  return `<div class="doc-header">
  <div class="hg-logo">${logoHtml}</div>
  <div class="hg-names">
    <div class="club-name-zh">企業家國際演講會</div>
    <div class="club-name-en">Entrepreneur Toastmasters Club</div>
  </div>
  <div class="hg-img">${themeImgHtml}</div>
  <div class="hg-meta-left">
    <div>No. 4069930</div>
    <div>${t('foundedSince')}:</div>
    <div>2014.06.29</div>
    <div>&nbsp;</div>
    <div>${t('fee')} : NTD150</div>
  </div>
  <div class="hg-meta-right">
    <div class="hmr-text" style="grid-column:span 2"><strong>${t('thTime')} : ${dateDisplay} ｜ ${esc(data.timeRange)}</strong></div>
    <div class="hmr-text" style="grid-column:span 2">${t('meetingSchedule')}</div>
    <div class="hmr-text" style="grid-column:span 2">${esc(data.venueInfo).replace(/\n/g, '<br>')}</div>
  </div>
</div>`;
}

// ================================================================
// AGENDA HTML GENERATOR
// ================================================================
function generateAgendaHTML(data) {
  const speechCount = data.speeches.length;
  const evalCount   = data.evaluators.length;
  const times = calcTimes(data.speeches);

  // rows: reception(1) + opening(5) + speech_header(1) + speeches(N)
  //       + photo(1) + intermission(1) + topics(1) + spacer(1)
  //       + eval_header(1) + evaluators(M) + timer(1) + ah(1) + LE(1) + GE(1)
  //       + closing(2) + sharing(1)  = 19 + N + M
  const totalRows = 19 + speechCount + evalCount;

  const rightPanelHtml = buildRightPanel();
  const headerHtml = buildHeader(data);

  let tbody = '';

  // Reception — right panel cell starts here with rowspan
  tbody += `
  <tr>
    <td class="time-cell">18:50</td>
    <td class="dur-cell">20'</td>
    <td class="agenda-cell">${t('reception')}</td>
    <td class="taker-cell">${esc(displayMember(data.receptionHost))}</td>
    <td class="rp-cell" rowspan="${totalRows}">${rightPanelHtml}</td>
  </tr>`;

  // Opening block — time & dur rowspan 5
  tbody += `
  <tr>
    <td class="time-cell" rowspan="5">${times.openingStart}</td>
    <td class="dur-cell" rowspan="5">10'</td>
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
    <td class="dur-cell">${times.varietyMins}'</td>
    <td class="agenda-cell"><strong>${t('varietySession')}</strong></td>
    <td class="taker-cell">${esc(displayMember(varietySession.host))}</td>
  </tr>`;
  }

  // Prepared Speech block — time rowspan = 1 + speechCount
  const speechBlockSpan = 1 + speechCount;
  tbody += `
  <tr class="row-section">
    <td class="time-cell" rowspan="${speechBlockSpan}">${times.preparedSpeechStart}</td>
    <td class="dur-cell">${times.speechMins}'</td>
    <td class="agenda-cell"><strong>${t('preparedSpeech')}</strong></td>
    <td class="taker-cell">${esc(displayMember(data.tme))}</td>
  </tr>`;

  data.speeches.forEach(sp => {
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
    <td class="dur-cell">5'</td>
    <td class="agenda-cell">${t('groupPhoto')}</td>
    <td class="taker-cell">${t('allParticipants')}</td>
  </tr>`;

  // Intermission
  tbody += `
  <tr class="row-intermission">
    <td colspan="4">${t('intermission', times.intermissionMins)}</td>
  </tr>`;

  // Table Topics
  tbody += `
  <tr class="row-section">
    <td class="time-cell">${times.topicsStart}</td>
    <td class="dur-cell">${times.topicsMins}'</td>
    <td class="agenda-cell"><strong>${t('tableTopics')}</strong></td>
    <td class="taker-cell">${esc(displayMember(data.tableTopicsMaster))}</td>
  </tr>`;

  // Spacer
  tbody += `<tr class="row-spacer"><td colspan="4"></td></tr>`;

  // Evaluation block — rowspan = 1 (header) + M (evaluators) + 4 (timer, ah, LE, GE)
  const evalRowSpan = evalCount + 5;
  tbody += `
  <tr class="row-section">
    <td class="time-cell" rowspan="${evalRowSpan}">${times.evalStart}</td>
    <td class="dur-cell">${times.evalMins}'</td>
    <td class="agenda-cell"><strong>${t('evaluation')}</strong></td>
    <td class="taker-cell">${esc(displayMember(data.generalEvaluator))}</td>
  </tr>`;

  data.evaluators.forEach((ev, i) => {
    tbody += `
  <tr>
    <td class="dur-cell">2'~3'</td>
    <td class="agenda-cell">${t('evaluatorFor', i + 1)}</td>
    <td class="taker-cell">${esc(displayMember(ev))}</td>
  </tr>`;
  });

  tbody += `
  <tr>
    <td class="dur-cell">1'</td>
    <td class="agenda-cell">${t('timerReport')}</td>
    <td class="taker-cell">${esc(displayMember(data.timer))}</td>
  </tr>
  <tr>
    <td class="dur-cell">1'</td>
    <td class="agenda-cell">${t('ahReport')}</td>
    <td class="taker-cell">${esc(displayMember(data.ahCounter))}</td>
  </tr>
  <tr>
    <td class="dur-cell">3'~5'</td>
    <td class="agenda-cell">${t('langEval')}</td>
    <td class="taker-cell">${esc(displayMember(data.langEvaluator))}</td>
  </tr>
  <tr>
    <td class="dur-cell">3'~5'</td>
    <td class="agenda-cell">${t('generalEval')}</td>
    <td class="taker-cell">${esc(displayMember(data.generalEvaluator))}</td>
  </tr>`;

  // Closing — time rowspan 2
  tbody += `
  <tr>
    <td class="time-cell" rowspan="2">${times.closingStart}</td>
    <td class="dur-cell">3'</td>
    <td class="agenda-cell">${t('tmeClosing')}</td>
    <td class="taker-cell">${esc(displayMember(data.tme))}</td>
  </tr>
  <tr>
    <td class="dur-cell">3'</td>
    <td class="agenda-cell">${t('awards')}</td>
    <td class="taker-cell">${esc(displayMember(data.awardsPresenter))}</td>
  </tr>`;

  // Sharing & Feedback
  tbody += `
  <tr>
    <td class="time-cell">${times.sharingStart}</td>
    <td class="dur-cell">5'</td>
    <td class="agenda-cell">${t('sharing')}</td>
    <td class="taker-cell">${esc(displayMember(data.sharingFeedback))}</td>
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
    <col class="col-dur">
    <col class="col-agenda">
    <col class="col-taker">
    <col class="col-rp">
  </colgroup>
  <thead>
    <tr>
      <th>${t('thTime')}</th>
      <th></th>
      <th>${t('thAgenda')}</th>
      <th>${t('thTaker')}</th>
      <th>${t('thPathways')}</th>
    </tr>
  </thead>
  <tbody>${tbody}</tbody>
</table>

<div class="agenda-footer">${t('adjournment')}</div>
`;
}

// ================================================================
// PREVIEW
// ================================================================
function collectData() {
  return {
    meetingDate:       val('meetingDate'),
    meetingNo:         val('meetingNo'),
    meetingTheme:      val('meetingTheme'),
    timeRange:         val('timeRange'),
    venueInfo:         val('venueInfo'),
    receptionHost:     val('receptionHost'),
    callingToOrder:    val('callingToOrder'),
    welcomeTME:        val('welcomeTME'),
    tme:               val('tme'),
    timer:             val('timer'),
    ahCounter:         val('ahCounter'),
    speeches:          speeches,
    evaluators:        evaluators.slice(),
    tableTopicsMaster: val('tableTopicsMaster'),
    generalEvaluator:  val('generalEvaluator'),
    langEvaluator:     val('langEvaluator'),
    awardsPresenter:   val('awardsPresenter'),
    sharingFeedback:   val('sharingFeedback'),
  };
}

function equalizeRowHeights() {
  const table = document.querySelector('#agendaPreview .agenda-table');
  if (!table) return;
  const rows = [...table.querySelectorAll('tbody tr')];
  if (!rows.length) return;

  const extra = table.offsetHeight - rows.reduce((sum, tr) => sum + tr.offsetHeight, 0);
  if (extra <= 0) return;

  const addPerRow = extra / rows.length;
  rows.forEach(tr => { tr.style.height = (tr.offsetHeight + addPerRow) + 'px'; });
}

const MM_TO_PX = 96 / 25.4;
const PAGE_W_PX = 194 * MM_TO_PX;
const PAGE_H_PX = 277 * MM_TO_PX;

function applyPreviewScale() {
  const scroll = document.querySelector('.preview-scroll');
  const page   = document.getElementById('agendaPreview');
  if (!scroll || !page) return;
  const scale = Math.min(1, (scroll.clientWidth - 20) / PAGE_W_PX);
  page.style.transformOrigin = 'top center';
  page.style.transform       = scale < 1 ? `scale(${scale})` : '';
  page.style.marginBottom    = scale < 1 ? `${PAGE_H_PX * (scale - 1)}px` : '';
}

function updatePreview() {
  const data = collectData();
  const preview = document.getElementById('agendaPreview');
  preview.innerHTML = generateAgendaHTML(data);
  preview.classList.toggle('lang-zh', lang === 'zh');
  preview.classList.toggle('lang-en', lang === 'en');
  requestAnimationFrame(() => { equalizeRowHeights(); applyPreviewScale(); });
  refreshAutoHints();
  setSaveStatus('unsaved');
}

// ================================================================
// SAVE / LOAD
// ================================================================
let currentAgendaId = null;
let selectedClubId  = null;   // system_admin: which club this agenda belongs to
let allClubs        = [];

function collectSaveData() {
  return { ...collectData(), timeOverrides: { ...timeOverrides }, lang, themeImgUrl: images.themeImg || null };
}

function applyAgendaData(d) {
  const fields = [
    'meetingDate', 'meetingNo', 'meetingTheme',
    'timeRange', 'venueInfo',
    'receptionHost', 'callingToOrder', 'welcomeTME', 'tme', 'timer', 'ahCounter',
    'tableTopicsMaster', 'generalEvaluator', 'langEvaluator',
    'awardsPresenter', 'sharingFeedback',
  ];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = d[id] || '';
  });

  speeches   = d.speeches   || [];
  evaluators = d.evaluators || [];

  if (d.timeOverrides) {
    Object.assign(timeOverrides, d.timeOverrides);
    Object.entries(timeOverrides).forEach(([key, val]) => {
      const el = document.getElementById(`to_${key}`);
      if (el) el.value = val || '';
    });
  }

  if (d.lang === 'zh' || d.lang === 'en') {
    lang = d.lang;
    const btn = document.getElementById('langToggle');
    if (btn) btn.textContent = lang === 'en' ? '切換中文' : 'Switch to EN';
  }

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

  renderSpeechForms();
  renderEvaluatorForms();
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
    const body    = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    };
    let res;
    if (currentAgendaId) {
      res = await fetch(`${API_BASE}/api/agendas/${currentAgendaId}`, { method: 'PUT', headers, body });
    } else {
      res = await fetch(`${API_BASE}/api/agendas`, { method: 'POST', headers, body });
      if (res.ok) {
        const json = await res.json();
        currentAgendaId = json.id;
      }
    }
    if (!res.ok) throw new Error((await res.json()).detail || '儲存失敗');
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
let calYear     = new Date().getFullYear();
let calMonth    = new Date().getMonth(); // 0-based
let calSelected = '';
let calDates    = new Set(); // 'YYYY-MM-DD' strings with at least one agenda

async function fetchCalDates() {
  try {
    const res = await fetch(`${API_BASE}/api/agendas?limit=500`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) return;
    const { items } = await res.json();
    calDates = new Set(items.map(i => i.meetingDate).filter(d => d && d.includes('-')));
    renderCalendar();
  } catch { /* ignore */ }
}

function renderCalendar() {
  const label = document.getElementById('calMonthLabel');
  const grid  = document.getElementById('calendarGrid');
  if (!label || !grid) return;

  label.textContent = `${calYear} 年 ${calMonth + 1} 月`;

  const today       = new Date().toISOString().slice(0, 10);
  const firstDow    = new Date(calYear, calMonth, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  let html = '';
  for (let i = 0; i < firstDow; i++) html += '<div class="cal-day cal-empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const ds  = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dot = calDates.has(ds) ? '<span class="cal-dot"></span>' : '';
    let cls   = 'cal-day';
    if (ds === calSelected)   cls += ' cal-sel';
    else if (ds === today)    cls += ' cal-today';
    html += `<div class="${cls}" onclick="calSelectDate('${ds}')"><span>${d}</span>${dot}</div>`;
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

async function fetchAgendaListByMonth(year, month) {
  const list = document.getElementById('agendaListBody');
  list.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  try {
    const res = await fetch(`${API_BASE}/api/agendas?limit=500`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error('無法取得列表');
    const { items } = await res.json();
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    const filtered = items.filter(i => (i.meetingDate || '').startsWith(prefix));
    if (!filtered.length) {
      list.innerHTML = '<p class="agenda-list-empty">本月尚無議程</p>';
      return;
    }
    list.innerHTML = filtered.map(item => {
      const label = [
        item.meetingDate || '—',
        item.meetingNo   ? `No.${item.meetingNo}` : '',
        item.meetingTheme || '',
      ].filter(Boolean).join('  ·  ');
      const ts = item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-TW') : '';
      return `
        <div class="agenda-list-item" onclick="loadAgenda(${item.id})">
          <div class="ali-main">${label}</div>
          <div class="ali-meta">${ts}</div>
          <button class="ali-del" onclick="event.stopPropagation(); deleteAgenda(${item.id}, this)" title="刪除"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
        </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<p class="agenda-list-empty">${e.message}</p>`;
  }
}

async function openLoadModal() {
  const now = new Date();
  calYear    = now.getFullYear();
  calMonth   = now.getMonth();
  calSelected = '';
  document.getElementById('loadModal').style.display = 'flex';
  renderCalendar();
  fetchCalDates(); // async, dots appear once loaded
  await fetchAgendaListByMonth(calYear, calMonth);
}

async function fetchAgendaList(date) {
  const list = document.getElementById('agendaListBody');
  list.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  try {
    const url = date ? `${API_BASE}/api/agendas?date=${date}&limit=100` : `${API_BASE}/api/agendas?limit=100`;
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error('無法取得列表');
    const { items } = await res.json();
    if (!items.length) {
      list.innerHTML = '<p class="agenda-list-empty">找不到符合的議程</p>';
      return;
    }
    list.innerHTML = items.map(item => {
      const label = [
        item.meetingDate || '—',
        item.meetingNo   ? `No.${item.meetingNo}` : '',
        item.meetingTheme || '',
      ].filter(Boolean).join('  ·  ');
      const ts = item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-TW') : '';
      return `
        <div class="agenda-list-item" onclick="loadAgenda(${item.id})">
          <div class="ali-main">${label}</div>
          <div class="ali-meta">${ts}</div>
          <button class="ali-del" onclick="event.stopPropagation(); deleteAgenda(${item.id}, this)" title="刪除"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
        </div>`;
    }).join('');
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
    const res = await fetch(`${API_BASE}/api/agendas/${id}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error('載入失敗');
    const data = await res.json();

    // Restore club picker for system_admin (API injects _clubId)
    if (isSystemAdmin()) {
      const clubId = data._clubId ?? null;
      const clubChanged = clubId !== selectedClubId;
      selectedClubId = clubId;
      const sel = document.getElementById('agendaClubSelect');
      if (sel) sel.value = clubId ?? '';
      _updateClubPickerHint();
      // Reload member roster if club changed
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
    const res = await fetch(`${API_BASE}/api/agendas/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error('刪除失敗');
    if (currentAgendaId === id) { currentAgendaId = null; setSaveStatus('unsaved'); }
    btn.closest('.agenda-list-item').remove();
  } catch (e) {
    alert(e.message);
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
// PDF DOWNLOAD
// ================================================================
async function downloadPDF() {
  const data = collectData();
  const dateStr = formatDate(data.meetingDate) || 'agenda';
  const element = document.getElementById('agendaPreview');

  // Remove transform first so container dimensions reflect full A4 size
  const savedTransform       = element.style.transform;
  const savedMarginBottom    = element.style.marginBottom;
  const savedTransformOrigin = element.style.transformOrigin;
  element.style.transform       = '';
  element.style.marginBottom    = '';
  element.style.transformOrigin = '';

  const restoreTheme = await swapThemeImgForCapture(element);

  const opt = {
    margin:      [8, 8, 8, 8],
    filename:    `Agenda_${dateStr}_No${data.meetingNo || ''}.pdf`,
    image:       { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, logging: false, scrollX: 0, scrollY: 0 },
    jsPDF:       { unit: 'mm', format: 'a4', orientation: 'portrait' },
  };

  html2pdf().set(opt).from(element).save().then(() => {
    element.style.transform       = savedTransform;
    element.style.marginBottom    = savedMarginBottom;
    element.style.transformOrigin = savedTransformOrigin;
    restoreTheme();
  });
}

async function getThemeImgBase64() {
  if (images.themeImgBase64) return images.themeImgBase64;
  if (!images.themeImg) return null;
  // Fetch via backend proxy to bypass R2 CORS restriction
  const proxyUrl = `${API_BASE}/api/image-proxy?url=${encodeURIComponent(images.themeImg)}`;
  const res = await fetch(proxyUrl, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) return null;
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// html2canvas does not support object-fit:cover, so we manually crop the image
// to exactly fill the container (cover behaviour) before passing to html2canvas.
async function getThemeImgCovered(containerEl) {
  const b64 = await getThemeImgBase64();
  if (!b64) return null;

  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = b64; });

  const w = containerEl.offsetWidth;
  const h = containerEl.offsetHeight;
  if (!w || !h) return b64;

  const canvas = document.createElement('canvas');
  canvas.width  = w * 2;  // match html2canvas scale:2
  canvas.height = h * 2;
  const ctx = canvas.getContext('2d');

  // Replicate object-fit:cover: crop source so it fills the box without stretching
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

// Swap theme image src to a cover-cropped data URL, return a restore function
async function swapThemeImgForCapture(element) {
  const themeImgEl = element.querySelector('.hg-theme-img');
  const hgImgEl    = element.querySelector('.hg-img');
  if (!themeImgEl || !hgImgEl) return () => {};

  try {
    const covered = await getThemeImgCovered(hgImgEl);
    if (!covered) return () => {};
    const savedSrc       = themeImgEl.src;
    const savedObjectFit = themeImgEl.style.objectFit;
    themeImgEl.src = covered;
    themeImgEl.style.objectFit = 'fill'; // already cropped, fill the box
    await new Promise(r => { themeImgEl.onload = r; themeImgEl.onerror = r; });
    return () => {
      themeImgEl.src = savedSrc;
      themeImgEl.style.objectFit = savedObjectFit;
    };
  } catch (e) {
    console.warn('主題圖片處理失敗，略過:', e);
    return () => {};
  }
}

async function downloadJPG() {
  const data = collectData();
  const dateStr = formatDate(data.meetingDate) || 'agenda';
  const element = document.getElementById('agendaPreview');

  // Remove transform first so container dimensions reflect full A4 size
  const savedTransform       = element.style.transform;
  const savedMarginBottom    = element.style.marginBottom;
  const savedTransformOrigin = element.style.transformOrigin;
  element.style.transform       = '';
  element.style.marginBottom    = '';
  element.style.transformOrigin = '';

  const restoreTheme = await swapThemeImgForCapture(element);

  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    logging: false,
    scrollX: 0,
    scrollY: 0,
  });

  element.style.transform       = savedTransform;
  element.style.marginBottom    = savedMarginBottom;
  element.style.transformOrigin = savedTransformOrigin;
  restoreTheme();

  const link = document.createElement('a');
  link.download = `Agenda_${dateStr}_No${data.meetingNo || ''}.jpg`;
  link.href = canvas.toDataURL('image/jpeg', 0.95);
  link.click();
}

// ================================================================
// RESET & INIT
// ================================================================
function applyDefaultState() {
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fields = [
    'meetingNo', 'meetingTheme',
    'receptionHost', 'callingToOrder', 'welcomeTME', 'tme', 'timer', 'ahCounter',
    'tableTopicsMaster', 'generalEvaluator', 'langEvaluator',
    'awardsPresenter', 'sharingFeedback',
  ];
  fields.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('meetingDate').value     = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  document.getElementById('timeRange').value       = '19:10 ~ 21:00';
  document.getElementById('venueInfo').value       = 'Venue: 鑫喜文創｜台北市信義區忠孝東路五段71巷11弄25號1樓\n（捷運板南線：市政府站4號出口，走路3分鐘）';
  speeches = [
    { title: 'TBD', speaker: '', duration: "5'-7'", pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
    { title: '', speaker: '', duration: "5'-7'", pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
    { title: '', speaker: '', duration: "5'-7'", pathwayCode: '', pathwayLevel: '', pathwayProject: '' },
  ];
  evaluators = ['', '', ''];
  Object.keys(timeOverrides).forEach(k => { timeOverrides[k] = ''; });
  Object.keys(images).forEach(k => { if (k !== 'logo' && k !== 'fbQr' && k !== 'lineQr') images[k] = null; });
  const themeStatusEl = document.getElementById('themeImgStatus');
  if (themeStatusEl) themeStatusEl.textContent = '';
  const themeFileInput = document.getElementById('img_themeImg');
  if (themeFileInput) themeFileInput.value = '';
  renderSpeechForms();
  renderEvaluatorForms();
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
    // system_admin: filter by the agenda's club; if no club selected yet, skip
    if (isSystemAdmin()) {
      if (!selectedClubId) return;
      params.set('club_id', selectedClubId);
    }
    const qs = params.toString();
    const res = await fetch(`${API_BASE}/api/users${qs ? '?' + qs : ''}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) return;
    memberRoster = await res.json();
    rebuildDatalist();
  } catch { /* silently ignore */ }
}

function rebuildDatalist() { /* no-op: replaced by custom autocomplete */ }

function displayMember(val) {
  if (!val) return val;
  const m = memberRoster.find(m =>
    `${m.nameZh} ${m.nameEn}` === val ||
    (m.level ? `${m.nameZh}, ${m.level}` : m.nameZh) === val ||
    (m.level ? `${m.nameEn}, ${m.level}` : m.nameEn) === val
  );
  if (!m) return val;
  const name = lang === 'zh' ? m.nameZh : m.nameEn;
  return m.level ? `${name}, ${m.level}` : name;
}

// ================================================================
// MEMBER AUTOCOMPLETE
// ================================================================
let acActiveInput = null;
let acHighlight   = -1;

function acFilteredItems() {
  const q = (acActiveInput?.value || '').trim().toLowerCase();
  if (!q) return memberRoster;
  return memberRoster.filter(m => {
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
  dd.style.display  = 'block';
  dd.style.left     = rect.left + 'px';
  dd.style.minWidth = rect.width + 'px';

  // Decide whether to open upward or downward
  const ddHeight = Math.min(dd.scrollHeight, 220); // max-height capped at 220
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  if (spaceBelow >= ddHeight || spaceBelow >= spaceAbove) {
    dd.style.top    = (rect.bottom + 4) + 'px';
    dd.style.bottom = 'auto';
  } else {
    dd.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    dd.style.top    = 'auto';
  }

  // scroll highlighted item into view
  if (acHighlight >= 0) {
    const el = dd.querySelectorAll('.member-dd-item')[acHighlight];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}

function acHide() {
  const dd = document.getElementById('memberDropdown');
  if (dd) dd.style.display = 'none';
  acActiveInput = null;
  acHighlight   = -1;
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
  document.addEventListener('focusin', e => {
    if (!e.target.classList.contains('member-ac')) { acHide(); return; }
    e.target.setAttribute('autocomplete', 'off');
    acActiveInput = e.target;
    acHighlight   = -1;
    acRender();
  });

  document.addEventListener('input', e => {
    if (!e.target.classList.contains('member-ac')) return;
    acActiveInput = e.target;
    acHighlight   = -1;
    acRender();
  });

  document.addEventListener('keydown', e => {
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
  });

  document.getElementById('memberDropdown').addEventListener('mousedown', e => {
    e.preventDefault(); // keep focus on input
    const item = e.target.closest('.member-dd-item');
    if (!item) return;
    const items = acFilteredItems();
    const m = items[parseInt(item.dataset.idx, 10)];
    if (m) acSelectItem(m);
  });

  document.addEventListener('focusout', e => {
    if (!e.target.classList.contains('member-ac')) return;
    setTimeout(() => {
      const dd = document.getElementById('memberDropdown');
      if (dd && !dd.contains(document.activeElement)) acHide();
    }, 100);
  });

  // Disable browser autocomplete on all member inputs
  document.querySelectorAll('.member-ac').forEach(el => {
    el.setAttribute('autocomplete', 'off');
  });

  // Reposition dropdown when form scrolls; hide only if input is out of view
  const formScrollBody = document.querySelector('.form-scroll-body');
  if (formScrollBody) {
    formScrollBody.addEventListener('scroll', () => {
      if (!acActiveInput) return;
      const rect = acActiveInput.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        acHide();
      } else {
        acRender();
      }
    });
  }
}

async function loadAgendaClubs() {
  try {
    const res = await fetch(`${API_BASE}/api/clubs`);
    if (!res.ok) return;
    allClubs = await res.json();
    const sel = document.getElementById('agendaClubSelect');
    if (!sel) return;
    allClubs.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    });
    document.getElementById('agendaClubPickerRow').style.display = '';
  } catch { /* ignore */ }
}

function onAgendaClubChange(val) {
  selectedClubId = val ? parseInt(val) : null;
  _updateClubPickerHint();
  setSaveStatus('unsaved');
  // Reload member roster filtered to the newly selected club
  memberRoster = [];
  fetchMemberDatalist();
}

function _updateClubPickerHint() {
  const hint = document.getElementById('agendaClubHint');
  if (!hint) return;
  if (!selectedClubId) {
    hint.textContent = '⚠ 請選擇分會，否則無法儲存';
    hint.style.color = '#b45309';
  } else {
    const club = allClubs.find(c => c.id === selectedClubId);
    hint.textContent = club ? `此議程將歸屬於「${club.name}」` : '';
    hint.style.color = '#64748b';
  }
}

async function init() {
  showLoading();
  try {
    await checkAuth();
    applyRoleUI();
    if (isSystemAdmin()) {
      await loadAgendaClubs();
      _updateClubPickerHint();
    }
    initAutocomplete();
    fetchMemberDatalist();

    const urlId = new URLSearchParams(window.location.search).get('id');
    if (urlId) {
      await loadAgenda(parseInt(urlId), { ownLoading: false });
    } else {
      applyDefaultState();
    }

    document.querySelector('.form-panel').addEventListener('input', updatePreview);
    document.querySelector('.form-panel').addEventListener('change', updatePreview);

    updatePreview();
    window.addEventListener('resize', applyPreviewScale);
  } finally {
    hideLoading();
  }
}

document.addEventListener('DOMContentLoaded', init);

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
    panel.style.top  = (rect.bottom + 6) + 'px';
    panel.style.left = left + 'px';
    panel.style.right = '';
  }
}

document.addEventListener('click', e => {
  const dd = document.getElementById('settingsDropdown');
  if (dd && !dd.contains(e.target)) dd.classList.remove('open');
});

function toggleFormPanel() {
  const panel = document.querySelector('.form-panel');
  const backdrop = document.getElementById('panelBackdrop');
  const isOpen = panel.classList.toggle('panel-open');
  if (backdrop) backdrop.classList.toggle('open', isOpen);
  setTimeout(applyPreviewScale, 380);
}
