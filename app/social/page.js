'use client';

import { useEffect, useState } from 'react';
import { apiJson, apiFetch } from '@/lib/api';
import { setAuth, clearAuth, applyRoleUI, isSystemAdmin, canWrite, getClubId } from '@/lib/auth';
import { SOCIAL_PLATFORMS, PLATFORM_KEYS, platformSpec, platformWarnings,
         mediaKind, mediaLabel } from '@/lib/socialPlatforms';
import { POST_KINDS, KIND_KEYS, KIND_REQUIRED, kindSpec, kindLabel,
         templatesFor, templateValues, drawTemplate, canvasToBlob, LOGO_URL }
  from '@/lib/postTemplates';
import Sidebar from '@/components/Sidebar';
import './social.css';
import { withBase } from '@/lib/basePath';
import SearchableSelect from '@/components/SearchableSelect';

// ================================================================
// 社群發文 — composer, draft box, and publishing
// ================================================================
// Same imperative-DOM style as the other pages (see app/roles/page.js for the
// rationale). Module-level `let` mirrors what used to be inline <script>
// globals.
//
// Writes the copy, attaches the images, checks each platform's rules, and
// publishes to Facebook / Instagram / Threads. Publishing needs the club to
// have connected an account first (分會管理 → 社群); an unconnected platform
// shows as 未連接帳號 in the publish dialog rather than failing at post time.
// It runs as an ai_jobs job, not a request — see runPublish().
//
// AI keys belong to the *user*, not the server: the browser never sees a key
// once saved (the API returns a masked hint only), and every generate call
// runs on the caller's own account.

let posts          = [];      // list rows for the active club
let current        = null;    // the post open in the editor (a working copy)
let baseline       = '';      // JSON snapshot of `current` as last saved
let allClubs       = [];
let selectedClubId = null;
let agendas        = [];      // meetings offered by the 綁定例會 select
let activeTab      = PLATFORM_KEYS[0];
let creds          = [];      // [{ provider, hint, updatedAt }] — never the keys
let pendingImages  = [];      // in-flight generate jobs, see runGenerateImage()
let elapsedTimer   = null;    // ticks the "已等 Ns" label on those tiles
let socialAccounts = [];      // which platforms this club has authorised
let postFacts      = null;    // the bound meeting's theme / host / roles, for the governed options
let posterTemplates = [];     // PPTX poster templates this club can use (built-in + uploaded)
let postPrefs      = null;    // GET /clubs/{id}/post-prefs, while the settings dialog is open

let setSaveDisabled = null;   // React bridges (see the note in app/roles/page.js)
let setSaveLabel    = null;

const activeClubId = () => (isSystemAdmin() ? selectedClubId : getClubId());

// A new post starts as a promo: it is what a club writes most, and it is the
// kind whose guard rails (the required date, address and fee, and the poster
// layout) are worth the most. 'other' remains the default for a row that
// arrives without a kind — that is a row written before the distinction
// existed, where 'promo' would be a guess rather than a sensible start.
const blankPost = () => ({
  id: null, clubId: activeClubId(), agendaId: null, kind: 'promo',
  title: '', status: 'draft', body: '',
  variants: Object.fromEntries(PLATFORM_KEYS.map((k) => [k, { text: '', enabled: true }])),
  images: [], reviewState: 'none', governance: {},
});

/** Variants can arrive missing a platform (older row, or a partial generate). */
function normalisePost(p) {
  const variants = {};
  PLATFORM_KEYS.forEach((k) => {
    const v = (p.variants || {})[k] || {};
    variants[k] = { text: v.text || '', enabled: v.enabled !== false };
  });
  return { ...p, variants,
           kind: KIND_KEYS.includes(p.kind) ? p.kind : 'other',
           images: Array.isArray(p.images) ? p.images : [],
           published: p.published || {},
           reviewState: p.reviewState || 'none',
           governance: p.governance || {} };
}

const isDirty = () => !!current && JSON.stringify(current) !== baseline;
const snapshot = () => { baseline = JSON.stringify(current); };

const STATUS_LABELS = { draft: '草稿', ready: '待發布', posted: '已發布' };

// ================================================================
// AUTH / LOAD
// ================================================================
async function checkSocialAuth() {
  try {
    const data = await apiJson('/auth/verify');
    setAuth(data.username, data.role, data.club_id, data.must_change_pw, data.memberships);
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

// The catalogue of pickable models, from the server so the browser cannot
// offer something the API would reject. Cheapest first; [0] is the default.
let aiModels = { copy: { anthropic: [], openai: [] }, image: [], imageQualities: [] };

async function loadAiModels() {
  try {
    aiModels = await apiJson('/ai-models');
  } catch {
    /* leave the empty catalogue — the selects render empty and the server
       still falls back to its own cheapest default. */
  }
}

// Listed cheapest first, but the preselected one is whichever the server
// marked `default` — the two are separate decisions.
const modelOptions = (list, chosen) => {
  const arr = list || [];
  const fallback = (arr.find((m) => m.default) || arr[0] || {}).id;
  return arr.map((m) =>
    `<option value="${esc(m.id)}" ${m.id === (chosen || fallback) ? 'selected' : ''}>`
    + `${esc(m.label)}（${esc(m.note)}・${esc(m.price)}）</option>`).join('');
};

/** Connection status only — the API never returns the keys themselves. */
async function loadCreds() {
  try {
    creds = await apiJson('/me/ai-credentials');
  } catch {
    creds = [];
  }
}

const credConnected = (provider) => !!creds.find((c) => c.provider === provider && c.hint);
const credOf        = (provider) => creds.find((c) => c.provider === provider) || {};
/** Works right now — your own key, or a server key standing behind it. */
const credUsable    = (provider) => {
  const c = credOf(provider);
  return !!(c.hint || c.serverFallback);
};

/** Which platforms the active club has authorised. Absent = not connected. */
async function loadSocialAccounts() {
  const cid = activeClubId();
  socialAccounts = [];
  if (cid == null) return;
  try {
    const cfg = await apiJson(`/clubs/${cid}/social-config`);
    socialAccounts = (cfg.accounts || []).filter((a) => a.accountName);
  } catch {
    socialAccounts = [];      // not configured yet, or no permission — same UI
  }
}

const platformConnected = (key) => !!socialAccounts.find((a) => a.platform === key);

async function loadClubs() {
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
  }
}

async function onClubChange() {
  if (isDirty() && !confirm('有未儲存的變更，切換分會將會捨棄。要繼續嗎？')) {
    document.getElementById('clubPickerSelect').value = selectedClubId ?? '';
    return;
  }
  const v = document.getElementById('clubPickerSelect').value;
  selectedClubId = v ? parseInt(v, 10) : null;
  current = null;
  posterTemplates = [];       // another club's templates
  await Promise.all([loadPosts(), loadAgendas(), loadSocialAccounts()]);
  renderEditor();
}

async function loadPosts() {
  const wrap = document.getElementById('postList');
  wrap.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  const cid = activeClubId();
  if (cid == null) {
    posts = [];
    wrap.innerHTML = '<div class="list-empty">請先於上方選擇分會</div>';
    return;
  }
  try {
    posts = await apiJson(`/social-posts?club_id=${cid}`);
    renderList();
  } catch {
    wrap.innerHTML = '<div class="list-empty">載入失敗</div>';
  }
}

/** Meetings offered by the 綁定例會 select — the AI copy reads from whichever is picked. */
async function loadAgendas() {
  const cid = activeClubId();
  if (cid == null) { agendas = []; return; }
  try {
    const params = new URLSearchParams({ order: 'date', limit: '30', page: '1' });
    if (isSystemAdmin()) params.set('club_id', cid);
    const json = await apiJson(`/agendas?${params}`);
    agendas = json.items || [];
  } catch {
    agendas = [];
  }
}

// ================================================================
// LIST
// ================================================================
function renderList() {
  const wrap = document.getElementById('postList');
  document.getElementById('postCount').textContent = `${posts.length} 則`;

  if (!posts.length) {
    wrap.innerHTML = '<div class="list-empty">還沒有貼文草稿</div>';
    return;
  }
  wrap.innerHTML = posts.map((p) => {
    const on = current && current.id === p.id;
    const when = (p.updatedAt || '').slice(0, 10);
    return `<button class="post-row${on ? ' active' : ''}" onclick="window.__socialOpen(${p.id})">
      <div class="post-row-top">
        <span class="post-row-title">${esc(p.title || '（未命名）')}</span>
        <span class="status-chip status-${esc(p.status)}">${esc(STATUS_LABELS[p.status] || p.status)}</span>
      </div>
      <div class="post-row-sub"><span class="post-kind k-${esc(p.kind || 'other')}">${esc(kindLabel(p.kind))}</span>${esc(when)}${p.images?.length ? ` · ${mediaLabel(p.images)}` : ''}</div>
    </button>`;
  }).join('');
}

async function openPost(id) {
  if (isDirty() && !confirm('有未儲存的變更，切換貼文將會捨棄。要繼續嗎？')) return;
  try {
    current = normalisePost(await apiJson(`/social-posts/${id}`));
    if (current.reviewState !== 'none' && !posterTemplates.length) await loadPosterTemplates();
    snapshot();
    activeTab = PLATFORM_KEYS[0];
    renderList();
    renderEditor();
  } catch {
    toast('載入貼文失敗', true);
  }
}

function newPost() {
  if (activeClubId() == null) { toast('請先選擇分會', true); return; }
  if (isDirty() && !confirm('有未儲存的變更，開新貼文將會捨棄。要繼續嗎？')) return;
  current = blankPost();
  snapshot();
  activeTab = PLATFORM_KEYS[0];
  renderList();
  renderEditor();
  document.getElementById('fTitle')?.focus();
}

// ================================================================
// EDITOR
// ================================================================
function renderEditor() {
  const wrap = document.getElementById('editorWrap');
  if (!current) {
    wrap.innerHTML = `<div class="editor-empty">
      <div>從左側挑一則貼文，或建立新的。</div>
      ${canWrite() ? '<button class="btn-add" onclick="window.__socialNew()">＋ 新增貼文</button>' : ''}
    </div>`;
    updateSaveBar();
    return;
  }

  const ro = !canWrite() ? 'disabled' : '';
  const agendaOpts = ['<option value="">— 不綁定例會 —</option>'].concat(
    agendas.map((a) => {
      const label = `${a.meetingDate || '未定日期'}${a.meetingNo ? ` 第${a.meetingNo}次` : ''}` +
                    `${a.meetingTheme ? ` · ${a.meetingTheme}` : ''}`;
      return `<option value="${a.id}" ${current.agendaId === a.id ? 'selected' : ''}>${esc(label)}</option>`;
    })
  ).join('');

  const statusOpts = Object.entries(STATUS_LABELS).map(([k, v]) =>
    `<option value="${k}" ${current.status === k ? 'selected' : ''}>${esc(v)}</option>`).join('');

  const kindOpts = POST_KINDS.map((k) =>
    `<option value="${k.key}" ${current.kind === k.key ? 'selected' : ''}>${esc(k.label)}</option>`).join('');

  const tabs = SOCIAL_PLATFORMS.map((p) => {
    const v = current.variants[p.key];
    return `<button class="pf-tab${p.key === activeTab ? ' active' : ''}${v.enabled ? '' : ' off'}"
              onclick="window.__socialTab('${p.key}')">${esc(p.label)}</button>`;
  }).join('');

  wrap.innerHTML = `
    <div class="editor-head">
      <input type="text" id="fTitle" class="ed-title" placeholder="貼文標題（只給自己辨識）"
             value="${esc(current.title)}" ${ro} oninput="window.__socialField('title', this.value)">
      <select id="fStatus" class="ed-select" ${ro} onchange="window.__socialField('status', this.value)">${statusOpts}</select>
    </div>

    <div class="ed-row">
      <label class="ed-label">貼文用途</label>
      <select id="fKind" class="ed-select ed-select-wide" ${ro}
              onchange="window.__socialKind(this.value)">${kindOpts}</select>
    </div>
    <div class="ed-kind-hint">${esc(kindSpec(current.kind).hint)}</div>

    <div class="ed-row">
      <label class="ed-label">綁定例會</label>
      <select id="fAgenda" class="ed-select ed-select-wide" ${ro}
              onchange="window.__socialField('agendaId', this.value ? parseInt(this.value,10) : null)">${agendaOpts}</select>
    </div>

    ${canWrite() ? `
    <div class="ai-bar">
      <button class="btn-ai" id="btnGenCopy" onclick="window.__socialOpenGen()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 10l-5.1 2.4L13 19l-2.1-6.6L6 10l6-1.2z"/></svg>
        AI 產生文案
      </button>
      <span class="ai-bar-hint">${isGovernedKind() && current.agendaId
        ? '受控生成：日期、地點、人名由系統從議程帶入，產出後要經幹部核可才能發布。'
        : '會讀取上面綁定的例會資料，用你自己的 AI 帳號產生。'}</span>
      <button class="btn-mini" onclick="window.__socialOpenPrefs()">貼文品牌設定・海報模板</button>
    </div>` : ''}

    ${renderGovernance()}

    <div class="ed-block">
      <label class="ed-label">主文案（各平台共用的底稿）</label>
      <textarea id="fBody" class="ed-textarea" rows="6" ${ro}
                placeholder="先寫一段主文案，再依平台微調" oninput="window.__socialField('body', this.value)">${esc(current.body)}</textarea>
      ${canWrite() ? `<button class="btn-mini" onclick="window.__socialFillAll()">把主文案套用到所有平台</button>` : ''}
    </div>

    <div class="ed-block">
      <label class="ed-label">各平台版本</label>
      <div class="pf-tabs">${tabs}</div>
      <div id="pfPane"></div>
    </div>

    <div class="ed-block">
      <label class="ed-label">圖片／影片</label>
      <div class="ed-media-hint">第一個是輪播封面，也是各平台的發布順序——用 ◀ ▶ 調整。</div>
      <div id="imgStrip" class="img-strip"></div>
      ${canWrite() ? `
      <div class="img-actions">
        <label class="btn-mini btn-file">
          上傳圖片／影片
          <input type="file" accept="image/*,video/*" multiple onchange="window.__socialUpload(this)">
        </label>
        <button class="btn-mini" onclick="window.__socialOpenImg()">AI 生圖</button>
        <button class="btn-mini" onclick="window.__socialOpenTmpl()">套用版型</button>
        <span class="ai-bar-hint">${templatesFor(current.kind).length
          ? 'AI 生圖使用你自己的 OpenAI 帳號。版型會把日期、地址、入場費疊成真實文字。'
          : `AI 生圖使用你自己的 OpenAI 帳號。版型只有「例會宣傳」和「例會回顧」有——目前是「${esc(kindLabel(current.kind))}」。`}</span>
      </div>` : ''}
    </div>

    ${canWrite() ? `
    <div class="ed-publish">
      <button class="btn-publish" onclick="window.__socialOpenPublish()"
              ${needsReview() ? 'disabled title="尚未通過核可"' : ''}>發布到社群平台</button>
      <span class="ai-bar-hint">${
        needsReview() ? '這則是受控生成的貼文，核可之後才能發布。'
        : socialAccounts.length
          ? `已連接：${socialAccounts.map((a) => esc(a.accountName)).join('、')}`
          : '這個分會還沒有連接任何平台，請到「分會管理 → 社群」完成授權。'}</span>
    </div>
    ${renderPublished()}` : ''}

    ${canWrite() && current.id ? `
    <div class="ed-danger">
      <button class="btn-del" onclick="window.__socialDelete()">刪除這則貼文</button>
    </div>` : ''}
  `;

  renderPane();
  renderImages();
  updateSaveBar();
}

/** Only the active platform's pane — keeps focus while typing elsewhere. */
function renderPane() {
  const pane = document.getElementById('pfPane');
  if (!pane || !current) return;
  const spec = platformSpec(activeTab);
  const v    = current.variants[activeTab];
  const ro   = !canWrite() ? 'disabled' : '';

  pane.innerHTML = `
    <div class="pf-pane">
      <div class="pf-pane-head">
        <label class="pf-toggle">
          <input type="checkbox" ${v.enabled ? 'checked' : ''} ${ro}
                 onchange="window.__socialVariant('enabled', this.checked)">
          發布到 ${esc(spec.label)}
        </label>
        <span class="pf-count" id="pfCount"></span>
      </div>
      <textarea id="pfText" class="ed-textarea" rows="8" ${ro}
                placeholder="${esc(spec.hint)}"
                oninput="window.__socialVariant('text', this.value)">${esc(v.text)}</textarea>
      <div class="pf-foot">
        <div id="pfWarn" class="pf-warn"></div>
        <button class="btn-mini" onclick="window.__socialCopy()">複製這則文案</button>
      </div>
    </div>`;
  refreshPaneMeta();
}

/** Counter + warnings only — safe to call on every keystroke. */
function refreshPaneMeta() {
  if (!current) return;
  const spec = platformSpec(activeTab);
  const text = current.variants[activeTab].text;
  const n    = text.length;

  const count = document.getElementById('pfCount');
  if (count) {
    count.textContent = `${n} / ${spec.max}`;
    count.className = 'pf-count' + (n > spec.max ? ' over' : n > spec.soft ? ' near' : '');
  }

  const warn = document.getElementById('pfWarn');
  if (warn) {
    const items = platformWarnings(activeTab, text, current.images);
    warn.innerHTML = items.map((w) =>
      `<div class="pf-warn-item ${w.level}">${esc(w.text)}</div>`).join('');
  }
}

function renderImages() {
  const strip = document.getElementById('imgStrip');
  if (!strip || !current) return;

  // Jobs still running for *this* post get a placeholder tile, so the wait is
  // visible without blocking the rest of the editor.
  const mine = pendingImages.filter((j) => j.owner === current);
  if (!current.images.length && !mine.length) {
    strip.innerHTML = '<div class="img-empty">還沒有圖片或影片。Instagram 貼文一定要有一個。</div>';
    return;
  }

  strip.innerHTML = current.images.map((img, i) => `
    <div class="img-thumb img-open" onclick="window.__socialPreview(${i})"
         title="點開看原圖">
      ${mediaKind(img) === 'video'
        // preload=metadata so the tile shows a real frame without pulling the
        // whole file; these are meeting clips, not thumbnails.
        ? `<video src="${esc(img.url)}" muted playsinline preload="metadata"></video>
           <span class="img-badge">影片</span>`
        : `<img src="${esc(img.url)}" alt="${esc(img.name || '')}">`}
      ${i === 0 ? '<span class="img-cover">封面</span>' : ''}
      ${canWrite() ? `<button class="img-del" title="移除"
           onclick="event.stopPropagation(); window.__socialRemoveImage(${i})">✕</button>
        <div class="img-move">
          ${i > 0 ? `<button title="往前" onclick="event.stopPropagation(); window.__socialMoveImage(${i}, -1)">◀</button>` : ''}
          ${i < current.images.length - 1 ? `<button title="往後" onclick="event.stopPropagation(); window.__socialMoveImage(${i}, 1)">▶</button>` : ''}
        </div>` : ''}
    </div>`).join('') + mine.map((j) => `
    <div class="img-thumb pending" title="${esc(j.prompt)}">
      <div class="spinner"></div>
      <div class="img-pending-t" id="elapsed_${j.jobId}">0 秒</div>
    </div>`).join('');
  tickElapsed();
}

/** One shared ticker for every in-flight tile; stops when none are left. */
function tickElapsed() {
  pendingImages.forEach((j) => {
    const el = document.getElementById(`elapsed_${j.jobId}`);
    if (el) el.textContent = `${Math.round((Date.now() - j.startedAt) / 1000)} 秒`;
  });
  if (pendingImages.length && !elapsedTimer) {
    elapsedTimer = setInterval(tickElapsed, 1000);
  } else if (!pendingImages.length && elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

// ================================================================
// MEDIA PREVIEW
// ================================================================
// A 96px tile is enough to tell two pictures apart and not enough to judge
// one. Generated images in particular are only worth keeping or regenerating
// once you have actually looked at them, so the strip opens.

let previewEsc = null;

function openPreview(i) {
  const item = current?.images?.[i];
  if (!item) return;
  const box = document.getElementById('previewBody');
  const isVideo = mediaKind(item) === 'video';
  box.innerHTML = isVideo
    ? `<video src="${esc(item.url)}" controls autoplay playsinline></video>`
    : `<img src="${esc(item.url)}" alt="${esc(item.name || '')}">`;
  document.getElementById('previewName').textContent =
    item.name || (isVideo ? '影片' : '圖片');
  document.getElementById('previewModal').style.display = 'flex';

  previewEsc = (e) => { if (e.key === 'Escape') closePreview(); };
  document.addEventListener('keydown', previewEsc);
}

function closePreview() {
  document.getElementById('previewModal').style.display = 'none';
  // Stop playback rather than leaving a video running behind the overlay.
  document.getElementById('previewBody').innerHTML = '';
  if (previewEsc) {
    document.removeEventListener('keydown', previewEsc);
    previewEsc = null;
  }
}


/** Links to whatever has already gone out, so a retry is an informed choice. */
function renderPublished() {
  const pub = current.published || {};
  const rows = Object.entries(pub).filter(([, v]) => v && v.id);
  if (!rows.length) return '';
  return `<div class="ed-published">
    ${rows.map(([k, v]) => `
      <div class="pub-row">
        <span class="pub-plat">${esc(platformSpec(k).label)}</span>
        <span class="pub-at">${esc((v.at || '').slice(0, 16).replace('T', ' '))}</span>
        ${v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noreferrer">查看貼文 ↗</a>` : ''}
      </div>`).join('')}
  </div>`;
}

// ---- field writers (never re-render the whole editor) ----
function setField(key, value) {
  if (!current) return;
  current[key] = value;
  updateSaveBar();
}

function setVariant(key, value) {
  if (!current) return;
  current.variants[activeTab][key] = value;
  if (key === 'text') refreshPaneMeta();
  else renderEditor();          // toggling changes the tab's styling
  updateSaveBar();
}

function switchTab(key) {
  activeTab = key;
  document.querySelectorAll('.pf-tab').forEach((el, i) => {
    el.classList.toggle('active', PLATFORM_KEYS[i] === key);
  });
  renderPane();
}

function fillAllFromBody() {
  if (!current) return;
  if (PLATFORM_KEYS.some((k) => current.variants[k].text.trim()) &&
      !confirm('這會覆蓋各平台已經寫好的文案，要繼續嗎？')) return;
  PLATFORM_KEYS.forEach((k) => { current.variants[k].text = current.body; });
  renderPane();
  updateSaveBar();
}

async function copyActive() {
  try {
    await navigator.clipboard.writeText(current.variants[activeTab].text);
    toast(`已複製 ${platformSpec(activeTab).label} 文案`);
  } catch {
    toast('複製失敗，請手動選取', true);
  }
}

// ================================================================
// IMAGES
// ================================================================
async function uploadImages(input) {
  const files = [...(input.files || [])];
  input.value = '';
  if (!files.length || !current) return;

  const restore = busyButton(input.closest('.btn-file'), '上傳中…');
  try {
    for (const file of files) {
      const { uploadUrl, publicUrl } = await apiJson('/upload/presign', {
        method: 'POST',
        body: { filename: file.name, content_type: file.type, club_id: activeClubId() },
      });
      const res = await fetch(uploadUrl, {
        method: 'PUT', headers: { 'Content-Type': file.type }, body: file,
      });
      if (!res.ok) throw new Error('上傳至雲端失敗');
      current.images.push({
        url: publicUrl, name: file.name,
        // Recorded at upload time rather than sniffed later: the browser knows
        // exactly what it just sent, and R2 keys do not always keep a suffix.
        type: file.type.startsWith('video/') ? 'video' : 'image',
      });
    }
    renderImages();
    refreshPaneMeta();          // an image can clear Instagram's "需要圖片" error
    updateSaveBar();
  } catch (e) {
    toast(e.message || '圖片上傳失敗', true);
  } finally {
    restore();
  }
}

/**
 * Move one attachment along the strip.
 *
 * The order is not cosmetic: it is the order the platforms publish in, and the
 * first one is the carousel's cover — the only one most people see.
 */
function moveImage(i, dir) {
  if (!current || !canWrite()) return;
  const j = i + dir;
  const arr = current.images;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderImages();
  updateSaveBar();
}

function removeImage(i) {
  if (!current) return;
  current.images.splice(i, 1);
  renderImages();
  refreshPaneMeta();
  updateSaveBar();
}

// ================================================================
// SAVE / DELETE
// ================================================================
function updateSaveBar() {
  const dirty = isDirty();
  setSaveDisabled?.(!current || !dirty || !canWrite());
  const label = document.getElementById('saveState');
  if (label) {
    label.textContent = !current ? '' : dirty ? '有未儲存的變更' : '已儲存';
    label.className = 'save-state' + (dirty ? ' unsaved' : '');
  }
}

async function savePost() {
  if (!current || !canWrite()) return;
  setSaveDisabled?.(true);
  setSaveLabel?.('儲存中…');
  const body = {
    club_id: current.clubId ?? activeClubId(),
    agenda_id: current.agendaId,
    kind: current.kind || 'other',
    title: current.title,
    status: current.status,
    body: current.body,
    variants: current.variants,
    images: current.images,
  };
  try {
    if (current.id) {
      const out = await apiJson(`/social-posts/${current.id}`, { method: 'PUT', body });
      // Changing approved text sends the post back to review; the server
      // decides, the page just shows it.
      if (out?.reviewState && out.reviewState !== current.reviewState) {
        current.reviewState = out.reviewState;
        if (out.reviewState === 'pending') toast('文字改過了，這則貼文需要重新核可');
        renderEditor();
      }
    } else {
      const { id } = await apiJson('/social-posts', { method: 'POST', body });
      current.id = id;
    }
    snapshot();
    await loadPosts();
    renderList();
    toast('已儲存');
  } catch (e) {
    toast(e.message || '儲存失敗', true);
  } finally {
    setSaveLabel?.('儲存');
    updateSaveBar();
  }
}

async function deletePost() {
  if (!current?.id) return;
  if (!confirm('確定要刪除這則貼文嗎？此動作無法復原。')) return;
  try {
    await apiJson(`/social-posts/${current.id}`, { method: 'DELETE' });
    current = null;
    await loadPosts();
    renderList();
    renderEditor();
    toast('已刪除');
  } catch {
    toast('刪除失敗', true);
  }
}

// ================================================================
// AI: COPY
// ================================================================
// ================================================================
// GOVERNED POSTS (PostGenerator engine)
// ================================================================
// Promo and recap posts about a meeting are written by the governed engine:
// facts come from the agenda and club settings, the Quality Checker can block
// a draft, and an officer approves it before it can be published or its
// poster downloaded. The server owns the verdict — this only displays it and
// asks for it.

const GOVERNED_KINDS = ['promo', 'recap'];
const isGovernedKind = () => !!current && GOVERNED_KINDS.includes(current.kind);
const needsReview = () => !!current && ['pending', 'rejected'].includes(current.reviewState);
const REVIEW_LABELS = { pending: '待核可', approved: '已核可', rejected: '已退回' };
const NOTE_ORDER = { crit: 0, warn: 1, info: 2 };
const LENGTH_LABELS = { short: '短（200–300 字）', medium: '中（350–500 字）', long: '長（600–800 字）' };
const EMOJI_LABELS = { none: '不用', light: '少量', moderate: '適中', rich: '活潑' };

function renderGovernance() {
  if (!current || !current.reviewState || current.reviewState === 'none') return '';
  const g = current.governance || {};
  const state = current.reviewState;
  const notes = [...(g.complianceNotes || [])]
    .sort((a, b) => NOTE_ORDER[a.severity] - NOTE_ORDER[b.severity]);
  const loud = notes.filter((n) => n.severity !== 'info');
  const quiet = notes.filter((n) => n.severity === 'info');
  const aiNames = g.aiWrittenHighlights || [];
  const officer = canWrite();
  const stamp = (iso) => (iso || '').slice(0, 16).replace('T', ' ');
  const reviewed = current.reviewedBy
    ? `${state === 'approved' ? '核可' : '處理'}：${esc(current.reviewedBy)} ${esc(stamp(current.reviewedAt))}`
    : '';
  const plan = g.posterPlan;
  const tplOpts = plan
    ? posterTemplates.filter((t) => t.use === plan.use && t.enabled !== false)
      .map((t) => `<option value="${esc(t.id)}" ${t.id === plan.template_id ? 'selected' : ''}>${
        esc(t.name)}${t.source === 'upload' ? '（分會上傳）' : ''}</option>`).join('')
    : '';

  return `<div class="gov-panel gov-${state}">
    <div class="gov-head">
      <span class="gov-badge">受控生成 · ${esc(REVIEW_LABELS[state] || state)}</span>
      <span class="gov-meta">${esc(g.usedModel || '')}${g.generatedAt ? ` · ${esc(stamp(g.generatedAt))}` : ''}${
        reviewed ? ` · ${reviewed}` : ''}</span>
    </div>
    ${g.blocked ? `<div class="gov-blocked">品質檢查有紅線未過，這一版不能核可。
      請依下方紅字補上資料（議程或貼文品牌設定）後重新產生。</div>` : ''}
    <div class="gov-qc">${(g.qc || []).map((c) =>
      `<span class="qc qc-${esc(c.state)}" title="${esc(c.detail)}">${
        c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '✕'} ${esc(c.title)}</span>`).join('')}</div>
    ${loud.length ? `<ul class="gov-notes">${loud.map((n) =>
      `<li class="note-${n.severity}">${esc(n.text)}</li>`).join('')}</ul>` : ''}
    ${quiet.length ? `<details class="gov-info"><summary>系統帶入與補值紀錄（${quiet.length}）</summary>
      <ul class="gov-notes">${quiet.map((n) => `<li class="note-info">${esc(n.text)}</li>`).join('')}</ul>
    </details>` : ''}
    ${aiNames.length && state !== 'approved' ? `<div class="gov-ai">
      <div class="gov-ai-t">這些角色沒有亮點筆記，描述是 AI 依角色職責補寫的（不是本人實際表現）。請逐一看過，再勾選確認：</div>
      ${aiNames.map((n) => `<label class="gov-ai-item"><input type="checkbox" class="gov-ai-cb" value="${esc(n)}"> ${esc(n)}</label>`).join('')}
    </div>` : ''}
    ${officer ? `<div class="gov-actions">
      ${state !== 'approved' ? `<button class="btn-approve" onclick="window.__socialReview('approve')" ${g.blocked ? 'disabled' : ''}>核可</button>` : ''}
      ${state === 'pending' ? `<button class="btn-mini" onclick="window.__socialReview('reject')">退回</button>` : ''}
      ${state !== 'pending' ? `<button class="btn-mini" onclick="window.__socialReview('reopen')">改回待核可</button>` : ''}
    </div>` : ''}
    ${plan && officer ? `<div class="gov-poster">
      <label class="ed-label">PPTX 海報</label>
      <select id="posterTpl" class="ed-select">${tplOpts}</select>
      <button class="btn-mini" onclick="window.__socialPoster()" ${state === 'approved' ? '' : 'disabled'}>產生並下載</button>
      <span class="ai-bar-hint">${state === 'approved'
        ? '可在 PowerPoint 裡再編輯；照片框會保留佔位。' : '核可後才能產生海報。'}</span>
    </div>` : ''}
  </div>`;
}

async function loadPosterTemplates() {
  const cid = activeClubId();
  if (cid == null) { posterTemplates = []; return; }
  try {
    posterTemplates = await apiJson(`/post-templates?club_id=${cid}`);
  } catch {
    posterTemplates = [];
  }
}

async function reviewPost(action) {
  if (!current?.id) return;
  if (isDirty()) { toast('請先儲存——核可的是存好的那一版文字', true); return; }
  const confirmed = [...document.querySelectorAll('.gov-ai-cb')]
    .filter((el) => el.checked).map((el) => el.value);
  try {
    const post = await apiJson(`/social-posts/${current.id}/review`, {
      method: 'POST', body: { action, confirmed },
    });
    current = normalisePost(post);
    snapshot();
    await loadPosts();
    renderList();
    renderEditor();
    toast({ approve: '已核可，可以發布了', reject: '已退回', reopen: '已改回待核可' }[action]);
  } catch (e) {
    toast(e.message || '操作失敗', true);
  }
}

async function makePoster() {
  if (!current?.id) return;
  const template_id = document.getElementById('posterTpl')?.value || '';
  // Open the tab inside the click: one opened after the await is a popup to
  // the browser and gets blocked.
  const tab = window.open('', '_blank');
  toast('正在產生海報…');
  try {
    const out = await apiJson(`/social-posts/${current.id}/poster`, {
      method: 'POST', body: { template_id },
    });
    if (tab) tab.location.href = out.url;
    else window.location.href = out.url;
    toast(`已產生「${out.templateName}」海報`);
  } catch (e) {
    tab?.close();
    toast(e.message || '產生海報失敗', true);
  }
}

// ---- 貼文品牌設定 + PPTX poster templates ----
// Three tabs over one draft. Text and list settings are saved together with
// 儲存; template uploads, switches and deletes take effect at once (they are
// files, not form fields), which the templates tab says.

const PP_TABS = [
  { key: 'basic',     label: '基本資料' },
  { key: 'tone',      label: '語氣與規則' },
  { key: 'templates', label: '海報模板' },
];
const PP_TEXT_KEYS = ['register_url', 'brand_signature', 'post_persona', 'post_notes_pre',
  'post_notes_review', 'post_default_emotion', 'post_default_length', 'post_default_emoji'];
const PP_LIST_KEYS = ['fixed_hashtags', 'banned_words'];
const PP_KNOBS = [
  { key: 'post_default_emotion', knob: 'emotion', label: '情緒方向', labels: {} },
  { key: 'post_default_length', knob: 'length', label: '貼文長度', labels: { short: '短', medium: '中', long: '長' } },
  { key: 'post_default_emoji', knob: 'use_emoji', label: 'emoji 用量', labels: EMOJI_LABELS },
];
const USE_LABELS = { PRE_EVENT: '宣傳', POST_REVIEW: '回顧' };

let prefsDraft = null;      // the form's working copy; a list of null = "use the default"
let prefsInitial = '';      // JSON of the draft as loaded, for the unsaved-changes check
let prefsTab = 'basic';
let tplUpload = null;       // { file, use, name, style, error, busy }

const ppEditable = () => canWrite();
const ppDirty = () => !!prefsDraft && JSON.stringify(prefsDraft) !== prefsInitial;

async function openPrefsModal() {
  const cid = activeClubId();
  if (cid == null) { toast('請先選擇分會', true); return; }
  try {
    [postPrefs] = await Promise.all([apiJson(`/clubs/${cid}/post-prefs`), loadPosterTemplates()]);
  } catch (e) {
    toast(e.message || '讀取設定失敗', true);
    return;
  }
  const p = postPrefs.prefs || {};
  prefsDraft = Object.fromEntries(PP_TEXT_KEYS.map((k) => [k, p[k] || '']));
  PP_LIST_KEYS.forEach((k) => { prefsDraft[k] = Array.isArray(p[k]) ? [...p[k]] : null; });
  prefsInitial = JSON.stringify(prefsDraft);
  prefsTab = 'basic';
  tplUpload = { file: null, use: 'PRE_EVENT', name: '', style: [], error: '', busy: false };
  renderPrefs();
  document.getElementById('prefsModal').style.display = 'flex';
}

function closePrefsModal() {
  if (ppDirty() && !confirm('有未儲存的設定變更，關閉後會捨棄。要繼續嗎？')) return;
  document.getElementById('prefsModal').style.display = 'none';
  postPrefs = null;
  prefsDraft = null;
}

function renderPrefs() {
  document.getElementById('prefsTabs').innerHTML = PP_TABS.map((t) =>
    `<button type="button" role="tab" class="pp-tab${t.key === prefsTab ? ' active' : ''}"
       aria-selected="${t.key === prefsTab}" onclick="window.__pp.tab('${t.key}')">${esc(t.label)}${
       t.key === 'templates' ? `<span class="pp-tab-n">${posterTemplates.length}</span>` : ''}</button>`).join('');
  const body = document.getElementById('prefsBody');
  body.innerHTML = `
    ${ppEditable() ? '' : '<div class="pp-readonly">只有分會幹部可以修改這些設定，你可以看但不能改。</div>'}
    <section class="pp-panel" ${prefsTab === 'basic' ? '' : 'hidden'}>${ppBasicPanel()}</section>
    <section class="pp-panel" ${prefsTab === 'tone' ? '' : 'hidden'}>${ppTonePanel()}</section>
    <section class="pp-panel" ${prefsTab === 'templates' ? '' : 'hidden'}>${ppTemplatesPanel()}</section>`;
  ppSignaturePreview();
  ppSyncFooter();
}

function ppSyncFooter() {
  const onTemplates = prefsTab === 'templates';
  const state = document.getElementById('prefsState');
  if (state) {
    state.textContent = onTemplates ? '模板的上傳、啟用與刪除會立即生效'
      : ppDirty() ? '有未儲存的變更' : '';
    state.className = 'pp-state' + (ppDirty() && !onTemplates ? ' unsaved' : '');
  }
  const save = document.getElementById('prefsSaveBtn');
  if (save) save.disabled = !ppEditable() || !ppDirty();
}

// ---- tab: 基本資料 ----

function ppField({ label, badge, hint, control, extra = '' }) {
  return `<div class="pp-field">
    <div class="pp-label">${esc(label)}${badge ? `<span class="pp-badge">${esc(badge)}</span>` : ''}</div>
    ${control}
    ${hint ? `<div class="pp-hint">${hint}</div>` : ''}
    ${extra}
  </div>`;
}

function ppBasicPanel() {
  const d = postPrefs.defaults || {};
  const ro = ppEditable() ? '' : 'disabled';
  return `
    ${ppField({
      label: '報名連結', badge: '選填',
      control: `<input type="url" class="pp-input" ${ro} value="${esc(prefsDraft.register_url)}"
        placeholder="https://…" oninput="window.__pp.text('register_url', this.value)">`,
      hint: '有填才會出現在貼文最後的資訊欄與海報上；歡迎直接來的分會可以留空。',
      extra: '<div class="pp-warn" id="ppUrlWarn" hidden>看起來不是網址，請以 https:// 開頭。</div>',
    })}
    ${ppField({
      label: '品牌定位句',
      control: `<input type="text" class="pp-input" ${ro} maxlength="200" value="${esc(prefsDraft.brand_signature)}"
        placeholder="${esc(d.brand_signature || '')}" oninput="window.__pp.text('brand_signature', this.value)">`,
      hint: '回顧貼文結尾會逐字印出這一句，AI 不會改寫。',
      extra: '<div class="pp-preview" id="ppSigPreview"></div>',
    })}
    ${ppField({ label: '固定 hashtag', hint: '每一篇都會帶上；AI 另外依主題補的 hashtag 會接在後面。',
      control: `<div id="ppList_fixed_hashtags">${ppListEditor('fixed_hashtags')}</div>` })}
    ${ppField({ label: '禁用詞', hint: '出現在文案裡就會被品質檢查擋下、不能核可。',
      control: `<div id="ppList_banned_words">${ppListEditor('banned_words')}</div>` })}`;
}

function ppSignaturePreview() {
  const el = document.getElementById('ppSigPreview');
  if (!el) return;
  const own = prefsDraft.brand_signature.trim();
  const text = own || postPrefs.defaults.brand_signature || '';
  el.innerHTML = `<span class="pp-chip-src ${own ? 'own' : ''}">${own ? '已自訂' : '系統預設'}</span>
    貼文結尾會印：「${esc(text)}」`;
  const warn = document.getElementById('ppUrlWarn');
  if (warn) {
    const url = prefsDraft.register_url.trim();
    warn.hidden = !url || /^https?:\/\//i.test(url);
  }
}

function ppListEditor(key) {
  const list = prefsDraft[key];
  const defaults = postPrefs.defaults[key] || [];
  const ro = !ppEditable();
  if (list === null) {
    return `<div class="pp-chips muted">
        ${defaults.length ? defaults.map((v) => `<span class="pp-chip">${esc(v)}</span>`).join('')
          : '<span class="pp-empty">預設是沒有</span>'}
      </div>
      <div class="pp-list-foot"><span class="pp-chip-src">使用系統預設</span>
        ${ro ? '' : `<button type="button" class="pp-link" onclick="window.__pp.custom('${key}')">改成自訂</button>`}</div>`;
  }
  return `<div class="pp-chips${ro ? '' : ' editable'}" onclick="this.querySelector('input')?.focus()">
      ${list.map((v, i) => `<span class="pp-chip">${esc(v)}${ro ? '' :
        `<button type="button" aria-label="移除 ${esc(v)}" onclick="window.__pp.removeChip('${key}', ${i})">×</button>`}</span>`).join('')}
      ${ro ? '' : `<input class="pp-chip-input" placeholder="${list.length ? '' : '輸入後按 Enter'}"
        onkeydown="window.__pp.chipKey(event, '${key}')" onblur="window.__pp.chipCommit(this, '${key}')"
        onpaste="setTimeout(() => window.__pp.chipCommit(this, '${key}'))">`}
    </div>
    <div class="pp-list-foot"><span class="pp-chip-src own">自訂</span>
      ${ro ? '' : `<button type="button" class="pp-link" onclick="window.__pp.useDefault('${key}')">改回系統預設</button>`}</div>`;
}

function ppAddChips(key, raw) {
  const items = String(raw || '').split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean)
    .map((x) => (key === 'fixed_hashtags' && !x.startsWith('#') ? `#${x}` : x));
  const list = prefsDraft[key];
  items.forEach((x) => { if (!list.includes(x)) list.push(x); });
  return items.length;
}

function ppRerenderList(key, focus) {
  document.getElementById(`ppList_${key}`).innerHTML = ppListEditor(key);
  if (focus) document.querySelector(`#ppList_${key} .pp-chip-input`)?.focus();
  ppSyncFooter();
}

// ---- tab: 語氣與規則 ----

function ppTextarea(key, label, rows, placeholder, hint) {
  const ro = ppEditable() ? '' : 'disabled';
  const max = postPrefs.maxLength || 1000;
  return ppField({
    label,
    control: `<textarea class="pp-textarea" rows="${rows}" ${ro} maxlength="${max}"
      placeholder="${esc(placeholder)}" oninput="window.__pp.text('${key}', this.value)">${esc(prefsDraft[key])}</textarea>`,
    extra: `<div class="pp-count" id="ppCount_${key}">${prefsDraft[key].length} / ${max}</div>`,
    hint,
  });
}

function ppTonePanel() {
  const d = postPrefs.defaults || {};
  return `
    ${ppTextarea('post_persona', '品牌語氣', 4, d.post_persona || '',
      '留空就用上面灰字的預設語氣。這一段只調語氣，不能推翻「事實不經 AI」等紅線。')}
    <div class="pp-two">
      ${ppTextarea('post_notes_pre', '宣傳貼文的補充規則', 3, '例如：這一季想強調新人友善', '')}
      ${ppTextarea('post_notes_review', '回顧貼文的補充規則', 3, '例如：每位角色都要提到一個具體細節', '')}
    </div>
    <div class="pp-label pp-section-label">預設語氣旋鈕
      <span class="pp-hint-inline">產生文案時沒特別指定，就用這裡選的</span></div>
    ${PP_KNOBS.map((k) => ppKnob(k)).join('')}`;
}

function ppKnob({ key, knob, label, labels }) {
  const opts = postPrefs.tuningChoices[knob] || [];
  const chosen = prefsDraft[key];
  const hint = (opts.find((o) => o.value === chosen) || {}).hint;
  const ro = ppEditable() ? '' : 'disabled';
  const btn = (value, text) => `<button type="button" class="pp-seg${chosen === value ? ' on' : ''}" ${ro}
    aria-pressed="${chosen === value}" onclick="window.__pp.knob('${key}', '${esc(value)}')">${esc(text)}</button>`;
  return `<div class="pp-knob">
    <div class="pp-knob-label">${esc(label)}</div>
    <div class="pp-segs" role="group" aria-label="${esc(label)}">
      ${btn('', '不指定')}${opts.map((o) => btn(o.value, labels[o.value] || o.value)).join('')}
    </div>
    <div class="pp-knob-hint">${hint ? esc(hint.replace(/\*\*/g, '')) : '不特別要求，交給 AI 依主題判斷。'}</div>
  </div>`;
}

// ---- tab: 海報模板 ----

function ppTemplatesPanel() {
  const group = (use, title, note) => {
    const list = posterTemplates.filter((t) => t.use === use);
    return `<div class="pp-tpl-group">
      <div class="pp-label pp-section-label">${esc(title)}<span class="pp-hint-inline">${esc(note)}</span></div>
      <div class="pp-tpl-grid">${list.length ? list.map(ppTemplateCard).join('')
        : '<div class="pp-empty">還沒有這一類的模板。</div>'}</div>
    </div>`;
  };
  return `
    ${ppEditable() ? ppUploadCard() : ''}
    ${group('PRE_EVENT', '宣傳海報', '單頁')}
    ${group('POST_REVIEW', '回顧海報', '封面＋角色頁＋封底')}`;
}

function ppTemplateCard(t) {
  const officer = ppEditable() && t.source === 'upload';
  const pages = t.use === 'POST_REVIEW' && t.rolePages
    ? `<div class="pp-tpl-meta">角色頁 ${t.rolePages} 頁 × 每頁 ${t.roleSlotsPerPage || 4} 位</div>` : '';
  return `<div class="pp-tpl-card${t.enabled === false ? ' off' : ''}">
    <div class="pp-tpl-top">
      <span class="pp-tpl-title">${esc(t.name)}</span>
      <span class="pp-tag ${t.source === 'builtin' ? '' : 'own'}">${t.source === 'builtin' ? '內建' : '分會上傳'}</span>
    </div>
    ${(t.style || []).length ? `<div class="pp-tpl-styles">${t.style.map((s) => `<span>${esc(s)}</span>`).join('')}</div>` : ''}
    ${pages}
    <div class="pp-tpl-actions">
      <button type="button" class="pp-link" onclick="window.__pp.download('${esc(t.id)}', '${esc(t.name)}')">下載 .pptx</button>
      ${officer ? `
        <label class="pp-switch"><input type="checkbox" ${t.enabled ? 'checked' : ''}
          onchange="window.__pp.toggleTpl('${esc(t.id)}', this.checked)"><span></span>${t.enabled ? '啟用中' : '已停用'}</label>
        <button type="button" class="pp-link danger" onclick="window.__pp.deleteTpl('${esc(t.id)}', '${esc(t.name)}')">刪除</button>` : ''}
    </div>
  </div>`;
}

function ppUploadCard() {
  const u = tplUpload;
  const tokens = (postPrefs.templateTokens || {})[u.use] || { required: [], optional: [], photos: [] };
  const marks = (list) => list.map((k) => `<code>{{${esc(k)}}}</code>`).join(' ');
  return `<div class="pp-upload-card">
    <label class="pp-drop${u.file ? ' has-file' : ''}" ondragover="event.preventDefault(); this.classList.add('over')"
           ondragleave="this.classList.remove('over')" ondrop="window.__pp.drop(event)">
      <input type="file" accept=".pptx" onchange="window.__pp.pick(this.files[0])">
      <span class="pp-drop-t">${u.file ? esc(u.file.name) : '拖曳 .pptx 到這裡，或點一下選擇檔案'}</span>
      <span class="pp-drop-s">${u.file ? '換一個檔案' : '設計好的 PowerPoint 模板，文字用 {{標記}} 標出要填入的地方'}</span>
    </label>
    <div class="pp-upload-row">
      <div class="pp-segs" role="group" aria-label="用途">
        ${Object.entries(USE_LABELS).map(([k, v]) => `<button type="button" class="pp-seg${u.use === k ? ' on' : ''}"
          aria-pressed="${u.use === k}" onclick="window.__pp.uploadUse('${k}')">${v}</button>`).join('')}
      </div>
      <input class="pp-input" placeholder="模板名稱" value="${esc(u.name)}" oninput="window.__pp.uploadName(this.value)">
      <input class="pp-input" placeholder="風格（逗號分隔，例如：溫暖, 熱鬧）" value="${esc(u.style.join(', '))}"
             oninput="window.__pp.uploadStyle(this.value)">
      <button type="button" class="pp-primary" ${u.file && !u.busy ? '' : 'disabled'}
              onclick="window.__pp.upload()">${u.busy ? '檢查並上傳中…' : '上傳模板'}</button>
    </div>
    ${u.error ? `<div class="pp-error">${esc(u.error)}</div>` : ''}
    <details class="pp-marks">
      <summary>${USE_LABELS[u.use]}模板可以用的標記</summary>
      <div><b>必要</b>（少了會被拒收）：${marks(tokens.required)}</div>
      <div><b>選填</b>：${marks(tokens.optional)}</div>
      <div><b>照片框</b>（圖形名稱設成這些，會放入照片）：${marks(tokens.photos)}</div>
      <div class="pp-hint">最快的做法：先下載一個內建模板，改版面與配色，標記保留原樣。</div>
    </details>
  </div>`;
}

async function savePrefs() {
  if (!ppEditable() || !ppDirty()) return;
  const body = { ...prefsDraft };          // a list of null resets that list to the default
  const btn = document.getElementById('prefsSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }
  try {
    await apiJson(`/clubs/${activeClubId()}/post-prefs`, { method: 'PUT', body });
    prefsInitial = JSON.stringify(prefsDraft);
    closePrefsModal();
    toast('已儲存貼文品牌設定，下次產生時生效');
  } catch (e) {
    toast(e.message || '儲存失敗', true);
  } finally {
    if (btn) btn.textContent = '儲存設定';
    ppSyncFooter();
  }
}

async function ppUpload() {
  const u = tplUpload;
  if (!u.file) return;
  if (!/\.pptx$/i.test(u.file.name)) { u.error = '只能上傳 .pptx 檔'; renderPrefs(); return; }
  const cid = activeClubId();
  const type = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  u.busy = true; u.error = ''; renderPrefs();
  try {
    const { uploadUrl, publicUrl } = await apiJson('/upload/presign', {
      method: 'POST', body: { filename: u.file.name, content_type: type, club_id: cid },
    });
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: u.file });
    if (!put.ok) throw new Error('上傳至雲端失敗，請再試一次');
    const out = await apiJson('/post-templates', {
      method: 'POST',
      body: { club_id: cid, use: u.use, name: u.name.trim() || u.file.name.replace(/\.pptx$/i, ''),
              style: u.style, file_url: publicUrl },
    });
    await loadPosterTemplates();
    tplUpload = { file: null, use: u.use, name: '', style: [], error: '', busy: false };
    renderPrefs();
    toast(out.warnings?.length ? `已加入「${out.name}」，但：${out.warnings.join('；')}` : `已加入「${out.name}」`);
  } catch (e) {
    u.busy = false;
    u.error = e.message || '上傳模板失敗';
    renderPrefs();
  }
}

async function ppDownload(id, name) {
  try {
    const res = await apiFetch(`/post-templates/${encodeURIComponent(id)}/file`);
    if (!res.ok) throw new Error('下載失敗');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name || id}.pptx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    toast(e.message || '下載失敗', true);
  }
}

const ppHandlers = {
  tab(key) { prefsTab = key; renderPrefs(); },
  text(key, value) {
    prefsDraft[key] = value;
    const count = document.getElementById(`ppCount_${key}`);
    if (count) {
      const max = postPrefs.maxLength || 1000;
      count.textContent = `${value.length} / ${max}`;
      count.classList.toggle('near', value.length > max * 0.9);
    }
    ppSignaturePreview();
    ppSyncFooter();
  },
  knob(key, value) { prefsDraft[key] = value; renderPrefs(); },
  custom(key) { prefsDraft[key] = [...(postPrefs.defaults[key] || [])]; ppRerenderList(key, true); },
  useDefault(key) { prefsDraft[key] = null; ppRerenderList(key); },
  removeChip(key, i) { prefsDraft[key].splice(i, 1); ppRerenderList(key, true); },
  chipKey(e, key) {
    const input = e.target;
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      if (ppAddChips(key, input.value)) ppRerenderList(key, true);
    } else if (e.key === 'Backspace' && !input.value && prefsDraft[key].length) {
      prefsDraft[key].pop();
      ppRerenderList(key, true);
    }
  },
  chipCommit(input, key) { if (input.value.trim() && ppAddChips(key, input.value)) ppRerenderList(key); },
  pick(file) { if (file) { tplUpload.file = file; tplUpload.error = ''; renderPrefs(); } },
  drop(e) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) ppHandlers.pick(file);
  },
  uploadUse(use) { tplUpload.use = use; renderPrefs(); },
  uploadName(v) { tplUpload.name = v; },
  uploadStyle(v) { tplUpload.style = v.split(/[,，]/).map((x) => x.trim()).filter(Boolean); },
  upload: ppUpload,
  download: ppDownload,
  async toggleTpl(id, enabled) {
    try {
      await apiJson(`/post-templates/${encodeURIComponent(id)}`, { method: 'PUT', body: { enabled } });
      await loadPosterTemplates();
      renderPrefs();
    } catch (e) {
      toast(e.message || '更新失敗', true);
    }
  },
  async deleteTpl(id, name) {
    if (!confirm(`確定要刪除模板「${name}」嗎？已經產生的海報不受影響。`)) return;
    try {
      await apiJson(`/post-templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadPosterTemplates();
      renderPrefs();
      toast(`已刪除「${name}」`);
    } catch (e) {
      toast(e.message || '刪除失敗', true);
    }
  },
};

const COPY_PROVIDERS = [
  { key: 'anthropic', label: 'Claude (Anthropic)' },
  { key: 'openai',    label: 'ChatGPT (OpenAI)' },
];

const providerLabel = (key) =>
  (COPY_PROVIDERS.find((p) => p.key === key) || COPY_PROVIDERS[0]).label;

function openGenModal() {
  if (!current) return;
  const modal = document.getElementById('genModal');
  document.getElementById('genBrief').value = '';
  showGenForm();

  // Which account writes it. A provider with no key still appears — picking it
  // gives a specific "go connect it" error, which reads better than a silently
  // missing option.
  const sel = document.getElementById('genProvider');
  sel.innerHTML = COPY_PROVIDERS.map((p) => {
    const c = credOf(p.key);
    const note = c.hint ? '' : (c.serverFallback ? '（伺服器帳號）' : '（未連接）');
    return `<option value="${p.key}">${esc(p.label)}${note}</option>`;
  }).join('');
  // Default to one that will actually produce something. Picking an unusable
  // provider is still allowed — the error names it, which reads better than a
  // silently missing option.
  const usable = COPY_PROVIDERS.find((p) => credUsable(p.key));
  sel.value = (usable || COPY_PROVIDERS[0]).key;
  const hint = document.getElementById('genProviderHint');
  if (hint) {
    hint.textContent = COPY_PROVIDERS.every((p) => credUsable(p.key))
      ? '兩邊都可用，文風不同，可以都試試看。'
      : '標「未連接」的需要先到「AI 帳號」填自己的金鑰才會動。';
  }
  syncGenModels();
  PLATFORM_KEYS.forEach((k) => {
    const el = document.getElementById(`genP_${k}`);
    if (el) el.checked = current.variants[k].enabled;
  });
  const note = document.getElementById('genAgendaNote');
  const a = agendas.find((x) => x.id === current.agendaId);
  const governed = isGovernedKind() && !!current.agendaId;
  note.textContent = !a
    ? '尚未綁定例會 — 只會依你寫的補充指示產生。'
    : governed
      ? `受控生成：${a.meetingDate || ''}${a.meetingTheme ? ` · ${a.meetingTheme}` : ''}。日期、地點、人名由系統帶入，AI 只寫文案；產出會直接存成待核可的貼文。`
      : `會參考：${a.meetingDate || ''}${a.meetingTheme ? ` · ${a.meetingTheme}` : ''}`;
  const box = document.getElementById('genGoverned');
  box.style.display = governed ? '' : 'none';
  box.innerHTML = governed ? '<div class="loading-spinner"><div class="spinner"></div></div>' : '';
  modal.style.display = 'flex';
  if (governed) renderGovernedOptions(current.agendaId);
}

async function renderGovernedOptions(agendaId) {
  const box = document.getElementById('genGoverned');
  try {
    postFacts = await apiJson(`/post-facts?agenda_id=${agendaId}`);
  } catch (e) {
    box.innerHTML = `<div class="modal-field-hint">讀取例會資料失敗：${esc(e.message || '')}</div>`;
    return;
  }
  const sel = (id, opts) => `<select id="${id}" class="ed-select"><option value="">分會預設</option>${
    Object.entries(opts).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
  const emotions = Object.fromEntries(['共鳴', '懸念', '溫暖', '幽默', '激勵'].map((x) => [x, x]));
  const roles = postFacts.roles || [];
  box.innerHTML = `
    <div class="pp-row">
      <div><label class="modal-field-label">情緒方向</label>${sel('genEmotion', emotions)}</div>
      <div><label class="modal-field-label">長度</label>${sel('genLength', LENGTH_LABELS)}</div>
      <div><label class="modal-field-label">emoji</label>${sel('genEmoji', EMOJI_LABELS)}</div>
    </div>
    ${current.kind === 'promo' ? `
      <label class="modal-field-label">總主持人 ${esc(postFacts.host || '（議程未填）')} 的特色（選填，有填才會寫）</label>
      <input id="genHostHi" class="modal-input" placeholder="例如：擅長自嘲式開場">` : `
      <label class="modal-field-label">角色亮點筆記（選填）</label>
      <div class="modal-field-hint">沒填的角色，AI 只會寫中性的職責描述，核可前要逐一確認。</div>
      <div class="gen-roles">${roles.length ? roles.map((r) => `
        <div class="gen-role"><span>${esc(r.emoji || '')} ${esc(r.roleType)} · ${esc(r.name)}</span>
          <input class="modal-input gen-role-note" data-name="${esc(r.name)}" placeholder="這次的表現"></div>`).join('')
        : '<div class="modal-field-hint">這場議程還沒有排角色。</div>'}</div>`}
    <label class="modal-check" style="margin-top:10px">
      <input type="checkbox" id="genPoster" checked> 一併準備 PPTX 海報（核可後可下載）</label>`;
}

/** The model list follows the provider — they are different catalogues. */
function syncGenModels() {
  const sel = document.getElementById('genModel');
  if (!sel) return;
  const provider = document.getElementById('genProvider').value;
  sel.innerHTML = modelOptions(aiModels.copy?.[provider]);
}

function closeGenModal() {
  if (genBusy) return;      // mid-flight: closing would orphan the progress UI
  document.getElementById('genModal').style.display = 'none';
}

let genBusy = null;         // { startedAt, timer } while a generate is running

function showGenForm() {
  document.getElementById('genForm').style.display = '';
  document.getElementById('genProgress').style.display = 'none';
}

/** Swap the form for a spinner + elapsed counter; returns its undo. */
function showGenProgress(provider) {
  document.getElementById('genForm').style.display = 'none';
  const box = document.getElementById('genProgress');
  box.style.display = '';
  box.querySelector('.gen-progress-t').textContent = `${providerLabel(provider)} 產生中…`;

  const startedAt = Date.now();
  const label = box.querySelector('.gen-progress-s');
  const tick = () => { label.textContent = `已等 ${Math.round((Date.now() - startedAt) / 1000)} 秒`; };
  tick();
  genBusy = { startedAt, timer: setInterval(tick, 1000) };

  return () => {
    clearInterval(genBusy.timer);
    genBusy = null;
    showGenForm();
  };
}

async function runGenerate() {
  const platforms = PLATFORM_KEYS.filter((k) => document.getElementById(`genP_${k}`)?.checked);
  if (!platforms.length) { toast('請至少選一個平台', true); return; }
  const provider = document.getElementById('genProvider').value;
  const model = document.getElementById('genModel')?.value || '';
  const brief = document.getElementById('genBrief').value;

  // This one call can run for the better part of a minute, so the modal turns
  // into a progress panel rather than leaving a dead form on screen.
  const governed = isGovernedKind() && !!current.agendaId;
  if (governed && isDirty() && current.id &&
      !confirm('受控生成會把結果直接存進這則貼文，未儲存的文字修改會被取代。要繼續嗎？')) return;
  const options = governed ? {
    tuning: {
      emotion: document.getElementById('genEmotion')?.value || '',
      length: document.getElementById('genLength')?.value || '',
      use_emoji: document.getElementById('genEmoji')?.value || '',
    },
    host_highlight: document.getElementById('genHostHi')?.value || '',
    role_notes: Object.fromEntries([...document.querySelectorAll('.gen-role-note')]
      .filter((el) => el.value.trim()).map((el) => [el.dataset.name, el.value.trim()])),
    poster: !!document.getElementById('genPoster')?.checked,
  } : null;

  const restoreBtn  = busyButton(document.getElementById('genConfirmBtn'), '產生中…');
  const restoreForm = showGenProgress(provider);
  try {
    const out = await apiJson('/social-posts/generate', {
      method: 'POST',
      body: {
        club_id: activeClubId(),
        agenda_id: current.agendaId,
        kind: current.kind || 'other',
        brief,
        platforms,
        provider,
        model,
        post_id: current.id,
        options,
      },
    });
    if (out.post) {
      // Governed: the server already saved it, pending review. Attachments
      // uploaded this session but not saved yet are not part of what the
      // server has — keep them, left unsaved, so they are not lost.
      const unsavedImages = current.images;
      current = normalisePost(out.post);
      snapshot();
      if (JSON.stringify(unsavedImages) !== JSON.stringify(current.images) && unsavedImages.length) {
        current.images = unsavedImages;
      }
      await Promise.all([loadPosts(), loadPosterTemplates()]);
      restoreForm();
      closeGenModal();
      renderList();
      renderEditor();
      toast(current.governance?.blocked
        ? '已產生，但品質檢查有紅線未過，請看治理面板'
        : '已產生並存成待核可的貼文，請檢查後核可');
      return;
    }
    if (!current.title && out.title) current.title = out.title;
    current.body = out.body || current.body;
    Object.entries(out.variants || {}).forEach(([k, v]) => {
      if (current.variants[k]) current.variants[k] = { text: v.text || '', enabled: v.enabled !== false };
    });
    restoreForm();
    closeGenModal();
    renderEditor();
    toast(`${providerLabel(provider)} 已產生文案，請確認後再儲存`);
  } catch (e) {
    restoreForm();
    toast(e.message || '產生文案失敗', true);
  } finally {
    restoreBtn();
  }
}

// ================================================================
// AI: IMAGE
// ================================================================
function openImgModal() {
  if (!current) return;
  // Unlike copy, this has no second provider and no server account behind it:
  // Anthropic's API does not output images, and there is no server OpenAI key.
  // Saying so before the form beats letting the job fail after it is filled in.
  if (!credConnected('openai')) {
    toast('AI 生圖只能用 OpenAI，請先到「AI 帳號」填自己的金鑰', true);
    openCredModal();
    return;
  }
  document.getElementById('imgPrompt').value = '';
  const msel = document.getElementById('imgModel');
  if (msel && !msel.options.length) msel.innerHTML = modelOptions(aiModels.image);

  // The one-step poster needs both a layout and a meeting to fill it from.
  // When either is missing the option is replaced by the reason, not hidden:
  // an absent control tells you nothing about how to get it back.
  const list = templatesFor(current.kind);
  const can = list.length > 0 && !!current.agendaId;
  const wrap = document.getElementById('imgTmplWrap');
  if (wrap) {
    wrap.style.display = can ? '' : 'none';
    if (can) {
      document.getElementById('imgTmplPick').innerHTML =
        list.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join('');
      document.getElementById('imgAutoTmpl').checked = true;
    }
  }
  const noTmpl = document.getElementById('imgNoTmplNote');
  if (noTmpl) {
    noTmpl.textContent = can ? ''
      : !list.length
        ? `貼文用途是「${kindLabel(current.kind)}」，沒有對應的版型。改成「例會宣傳」或「例會回顧」就可以直接產出整張海報。`
        : '綁定例會之後，可以直接產出整張海報——日期、地址、入場費會疊在圖上。';
    noTmpl.className = 'modal-field-hint' + (can ? '' : ' hint-why');
  }
  document.getElementById('imgModal').style.display = 'flex';
}

const closeImgModal = () => { document.getElementById('imgModal').style.display = 'none'; };

/**
 * Generation is a *job*, not a request: create the row, fire the worker without
 * awaiting it, close the modal, and poll. The result lives in the job row, so a
 * slow generate no longer holds the UI hostage — and dropping the connection
 * (or the serverless invocation dying) no longer loses an image OpenAI already
 * charged for.
 */
async function runGenerateImage() {
  const prompt = document.getElementById('imgPrompt').value.trim();
  if (!prompt) { toast('請先描述想要的圖片', true); return; }
  const size = document.getElementById('imgSize').value;
  const model = document.getElementById('imgModel')?.value || '';
  const quality = document.getElementById('imgQuality')?.value || '';

  const restore = busyButton(document.getElementById('imgConfirmBtn'), '送出中…');

  // Fetch the meeting's facts before spending anything: a poster that cannot
  // be filled in should fail now, not after the picture is paid for.
  let tmpl = null;
  const auto = document.getElementById('imgAutoTmpl');
  if (auto && auto.checked && current.agendaId && templatesFor(current.kind).length) {
    try {
      tmpl = {
        kind: current.kind,
        templateKey: document.getElementById('imgTmplPick').value,
        fields: await apiJson(`/meeting-fields?agenda_id=${current.agendaId}`),
      };
    } catch (e) {
      toast(e.message || '讀取例會資料失敗，無法套用版型', true);
      restore();
      return;
    }
  }
  let job;
  try {
    job = await apiJson('/ai-jobs', {
      method: 'POST',
      body: { kind: 'image', club_id: activeClubId(),
              params: { prompt, size, model, quality } },
    });
  } catch (e) {
    toast(e.message || '無法建立生圖工作', true);
    restore();
    return;
  }
  restore();

  // Deliberately not awaited — this is the long call, and the job row is what
  // we read the outcome from. A rejection here is not fatal: the poll below
  // still reports whatever the row ends up saying.
  apiJson(`/ai-jobs/${job.id}/run`, { method: 'POST' }).catch(() => {});

  const entry = { jobId: job.id, owner: current, prompt, tmpl, startedAt: Date.now() };
  pendingImages.push(entry);
  closeImgModal();
  renderImages();
  toast('已開始生圖，可以繼續編輯文案');
  pollImageJob(entry);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finishPending(entry) {
  pendingImages = pendingImages.filter((j) => j !== entry);
  if (current === entry.owner) renderImages();
  tickElapsed();
}

async function pollImageJob(entry) {
  // Generous ceiling: the server marks its own jobs stale at 5 minutes, so
  // this is only the backstop for the poll itself never getting an answer.
  const deadline = Date.now() + 6 * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(2000);
    let job;
    try {
      job = await apiJson(`/ai-jobs/${entry.jobId}`);
    } catch {
      continue;              // transient network blip — keep waiting
    }

    if (job.status === 'done') {
      // The post object is the identity here: reloading a post replaces it, so
      // an image must never land on whatever happens to be open now.
      if (current === entry.owner) {
        let item = job.result;
        if (entry.tmpl) {
          try {
            item = await composePoster({ ...entry.tmpl, imageUrl: job.result.url });
          } catch (e) {
            // The picture is already paid for; keep it rather than lose it
            // because the wrapper failed.
            toast(`海報合成失敗，先放原圖：${e.message || ''}`, true);
          }
        }
        finishPending(entry);
        current.images.push(item);
        renderImages();
        refreshPaneMeta();
        updateSaveBar();
        toast(entry.tmpl && item !== job.result
          ? '海報已加入，記得儲存' : '圖片已加入，記得儲存');
      } else {
        finishPending(entry);
        toast('圖片已生成，但你已切換貼文，這張沒有被加入', true);
      }
      return;
    }
    if (job.status === 'error') {
      finishPending(entry);
      toast(job.error || '生圖失敗', true);
      return;
    }
  }
  finishPending(entry);
  toast('生圖等待逾時，請重新確認後再試', true);
}

// ================================================================
// PUBLISH
// ================================================================
// Publishing runs through the same ai_jobs pipeline as image generation: it is
// several sequential Graph calls per platform, so the browser polls a job row
// rather than holding one long request open.

let publishBusy = null;

function openPublishModal() {
  if (!current) return;
  if (!current.id || isDirty()) {
    toast('請先儲存這則貼文再發布', true);
    return;
  }
  const box = document.getElementById('publishBody');
  box.innerHTML = `
    <p class="modal-field-hint" style="margin:0 0 12px">
      發布會使用各平台自己的版本文案。已發布過的平台會再發一則新的，不會覆蓋原貼文。
    </p>
    ${SOCIAL_PLATFORMS.map((p) => {
      const v = current.variants[p.key];
      const on = platformConnected(p.key);
      const problems = platformWarnings(p.key, v.text, current.images)
        .filter((w) => w.level === 'error');
      const blocked = !on || !v.enabled || problems.length;
      return `<label class="pub-check${blocked ? ' blocked' : ''}">
        <input type="checkbox" id="pub_${p.key}" ${blocked ? 'disabled' : 'checked'}>
        <span class="pub-check-t">${esc(p.label)}</span>
        <span class="pub-check-s">${
          !on ? '未連接帳號'
          : !v.enabled ? '此平台已在編輯器中關閉'
          : problems.length ? esc(problems[0].text)
          : '可發布'}</span>
      </label>`;
    }).join('')}`;
  document.getElementById('publishProgress').style.display = 'none';
  box.style.display = '';
  document.getElementById('publishModal').style.display = 'flex';
}

function closePublishModal() {
  if (publishBusy) return;
  document.getElementById('publishModal').style.display = 'none';
}

async function runPublish() {
  const platforms = PLATFORM_KEYS.filter((k) => document.getElementById(`pub_${k}`)?.checked);
  if (!platforms.length) { toast('請至少選一個可發布的平台', true); return; }

  const box = document.getElementById('publishBody');
  const prog = document.getElementById('publishProgress');
  box.style.display = 'none';
  prog.style.display = '';
  const startedAt = Date.now();
  const label = prog.querySelector('.gen-progress-s');
  const tick = () => { label.textContent = `已等 ${Math.round((Date.now() - startedAt) / 1000)} 秒`; };
  tick();
  publishBusy = setInterval(tick, 1000);
  const restoreBtn = busyButton(document.getElementById('publishConfirmBtn'), '發布中…');

  const done = () => {
    clearInterval(publishBusy);
    publishBusy = null;
    restoreBtn();
    prog.style.display = 'none';
    box.style.display = '';
  };

  try {
    const job = await apiJson('/ai-jobs', {
      method: 'POST',
      body: { kind: 'publish', club_id: activeClubId(),
              params: { post_id: current.id, platforms } },
    });
    apiJson(`/ai-jobs/${job.id}/run`, { method: 'POST' }).catch(() => {});

    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      let state;
      try { state = await apiJson(`/ai-jobs/${job.id}`); } catch { continue; }

      if (state.status === 'done') {
        done();
        const results = (state.result || {}).results || {};
        const ok = Object.entries(results).filter(([, r]) => r.ok).map(([k]) => platformSpec(k).label);
        const bad = Object.entries(results).filter(([, r]) => !r.ok);
        // The job wrote `published` and possibly the status, so re-read rather
        // than guessing what the row now says.
        current = normalisePost(await apiJson(`/social-posts/${current.id}`));
        snapshot();
        await loadPosts();
        renderList();
        renderEditor();
        closePublishModal();
        if (bad.length) {
          toast(`${ok.length} 個平台成功；${bad.map(([k, r]) => `${platformSpec(k).label}：${r.error}`).join('／')}`, true);
        } else {
          toast(`已發布到 ${ok.join('、')}`);
        }
        return;
      }
      if (state.status === 'error') {
        done();
        toast(state.error || '發布失敗', true);
        return;
      }
    }
    done();
    toast('發布等待逾時，請到平台確認是否已送出', true);
  } catch (e) {
    done();
    toast(e.message || '發布失敗', true);
  }
}

// ================================================================
// IMAGE TEMPLATES
// ================================================================
// Compose the meeting's facts over a background, in the browser. The facts
// come from /meeting-fields — the same source the copywriter reads — so the
// picture and the caption cannot disagree about when or where the meeting is.

let tmplFields = null;      // the bound meeting's facts
let tmplBg     = null;      // HTMLImageElement, or null for the gradient
let tmplLogo;               // undefined = not tried, null = failed, else Image

/**
 * The Toastmasters badge, fetched once.
 *
 * Served from this app's own /media, so unlike the artwork it needs no proxy
 * and cannot taint the canvas. A failure is remembered as null rather than
 * retried on every redraw — a poster without the badge is still a poster.
 */
async function getLogo() {
  if (tmplLogo !== undefined) return tmplLogo;
  tmplLogo = await new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = LOGO_URL;
  });
  return tmplLogo;
}

/**
 * Load an R2 image as a blob URL.
 *
 * Not `img.src = publicUrl`: a cross-origin image taints the canvas and
 * `toBlob` then throws. Fetching through the authenticated proxy and handing
 * the canvas a same-origin blob: URL keeps it clean.
 */
async function loadBackground(url) {
  const res = await apiFetch(`/image-proxy?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error('讀取背景圖失敗');
  const objectUrl = URL.createObjectURL(await res.blob());
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('背景圖無法解碼'));
      img.src = objectUrl;
    });
  } finally {
    // The pixels are in the element by now; the URL itself can go.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

async function openTmplModal() {
  if (!current) return;
  const list = templatesFor(current.kind);
  if (!list.length) {
    toast('只有「例會宣傳」和「例會回顧」有版型', true);
    return;
  }
  if (!current.agendaId) {
    toast('請先綁定例會——版型的日期、地址、費用都從那場議程來', true);
    return;
  }

  document.getElementById('tmplModal').style.display = 'flex';
  const note = document.getElementById('tmplNote');
  note.textContent = '讀取例會資料中…';
  try {
    tmplFields = await apiJson(`/meeting-fields?agenda_id=${current.agendaId}`);
  } catch (e) {
    note.textContent = e.message || '讀取例會資料失敗';
    return;
  }

  // Say which fact is missing before drawing a picture with a hole in it.
  const missing = (KIND_REQUIRED[current.kind] || [])
    .filter(([k]) => !tmplFields[k]).map(([, label]) => label);
  note.innerHTML = missing.length
    ? `⚠️ 這場例會還缺「${esc(missing.join('、'))}」，版型上會留白。日期與地址在議程裡填，入場費在分會設定裡填。`
    : `會帶入：${esc([tmplFields.date, tmplFields.time, tmplFields.venue?.split('\n')[0], tmplFields.fee].filter(Boolean).join('　·　'))}`;

  const tsel = document.getElementById('tmplPick');
  tsel.innerHTML = list.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join('');

  // Artwork comes from this post — an upload, an AI image, or a slide
  // exported from PowerPoint. The agenda's theme image is not offered: it
  // belongs to the agenda sheet.
  const bsel = document.getElementById('tmplBg');
  const photos = (current.images || [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => mediaKind(m) === 'image');
  bsel.innerHTML = [
    ...photos.map(({ m, i }) =>
      `<option value="${i}">${esc(m.name || `圖片 ${i + 1}`)}</option>`),
    '<option value="">不放插圖</option>',
  ].join('');
  bsel.value = photos.length ? String(photos[0].i) : '';
  tmplBg = null;
  await onTmplBgChange(bsel);
}

const closeTmplModal = () => {
  document.getElementById('tmplModal').style.display = 'none';
  tmplBg = null;
};

async function onTmplBgChange(sel) {
  const v = sel.value;
  const url = v === '' ? '' : (current.images[parseInt(v, 10)]?.url || '');
  const state = document.getElementById('tmplBgState');
  tmplBg = null;
  if (url) {
    if (state) state.textContent = '插圖載入中…';
    try {
      tmplBg = await loadBackground(url);
    } catch (e) {
      // In the modal, not a toast: a toast for this scrolls away while you are
      // still looking at the preview, and a blank picture is the one failure
      // that is easy to approve by accident.
      toast(e.message || '插圖讀取失敗', true);
    }
  }
  if (state) {
    state.textContent = url
      ? (tmplBg ? '✅ 插圖已載入' : '⚠️ 插圖讀取失敗，這張會沒有圖像')
      : '這張不會有圖像，只有文字。';
    state.className = 'tmpl-bg-state' + (url && !tmplBg ? ' bad' : '');
  }
  await refreshTmplPreview();
}

async function refreshTmplPreview() {
  const canvas = document.getElementById('tmplCanvas');
  if (!canvas || !tmplFields) return;
  const key = document.getElementById('tmplPick').value;
  const template = templatesFor(current.kind).find((t) => t.key === key);
  if (!template) return;
  drawTemplate(canvas, {
    template,
    values: templateValues(current.kind, tmplFields),
    background: tmplBg,
    logo: await getLogo(),
    hideTitle: !!document.getElementById('tmplHideTitle')?.checked,
  });
}

/** Put a composed PNG in R2 and hand back its public URL. */
async function uploadPng(blob, stem) {
  const { uploadUrl, publicUrl } = await apiJson('/upload/presign', {
    method: 'POST',
    body: { filename: `${stem}-${Date.now()}.png`, content_type: 'image/png',
            club_id: activeClubId() },
  });
  const put = await fetch(uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob,
  });
  if (!put.ok) throw new Error('上傳至雲端失敗');
  return publicUrl;
}

/**
 * Wrap one picture in the meeting's poster and store the result.
 *
 * Used both by the template modal and, when asked, straight after an image is
 * generated — the latter is why a promo can be made without anyone having to
 * remember the second step. Runs off-screen, so it does not need the modal.
 */
async function composePoster({ kind, templateKey, fields, imageUrl }) {
  const list = templatesFor(kind);
  const template = list.find((t) => t.key === templateKey) || list[0];
  if (!template) throw new Error('這個貼文用途沒有版型');
  const art = await loadBackground(imageUrl);
  const canvas = document.createElement('canvas');
  drawTemplate(canvas, { template, values: templateValues(kind, fields),
                         background: art, logo: await getLogo() });
  return { url: await uploadPng(await canvasToBlob(canvas), 'poster'),
           name: '例會海報', type: 'image' };
}

async function runApplyTemplate() {
  const canvas = document.getElementById('tmplCanvas');
  if (!canvas || !current) return;
  const restore = busyButton(document.getElementById('tmplConfirmBtn'), '產生中…');
  try {
    const publicUrl = await uploadPng(await canvasToBlob(canvas), 'template');
    current.images.push({ url: publicUrl, name: '版型圖', type: 'image' });
    renderImages();
    refreshPaneMeta();
    updateSaveBar();
    closeTmplModal();
    toast('版型圖已加入這則貼文，記得儲存');
  } catch (e) {
    toast(e.message || '版型圖產生失敗', true);
  } finally {
    restore();
  }
}


// ================================================================
// AI ACCOUNTS
// ================================================================
const PROVIDER_LABELS = {
  // OpenAI does both; the old label said only 產生圖片, which read as "not an
  // option for copy" and kept people from connecting it for the half it shares.
  anthropic: { name: 'Anthropic (Claude)', use: '產生文案', url: 'https://console.anthropic.com/settings/keys' },
  openai:    { name: 'OpenAI (ChatGPT)',   use: '產生文案、產生圖片', url: 'https://platform.openai.com/api-keys' },
};

let clubCreds = [];      // [{ provider, hint }] — the club's shared accounts

async function openCredModal() {
  document.getElementById('credModal').style.display = 'flex';
  const body = document.getElementById('credBody');
  body.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  const cid = activeClubId();
  try {
    const [mine, club] = await Promise.all([
      apiJson('/me/ai-credentials'),
      // Only officers may see or set the shared account; for everyone else the
      // section simply does not exist.
      canWrite() && cid
        ? apiJson(`/clubs/${cid}/ai-credentials`).catch(() => [])
        : Promise.resolve([]),
    ]);
    creds = mine;
    clubCreds = club;
    renderCreds();
  } catch {
    body.innerHTML = '<div class="list-empty">載入失敗</div>';
  }
}

/** What this provider falls back to when you have no key of your own. */
function credFallbackBadge(c) {
  if (c.clubHint) return `<span class="cred-fallback">未連接，目前用分會帳號 ${esc(c.clubHint)}</span>`;
  if (c.serverFallback) return '<span class="cred-fallback">未連接，目前用伺服器帳號</span>';
  return '<span class="cred-unset">未連接</span>';
}

function credRow(c, { scope }) {
  const meta = PROVIDER_LABELS[c.provider] || { name: c.provider, use: '', url: '' };
  const set  = !!c.hint;
  const id   = `${scope}_${c.provider}`;
  const save = scope === 'club' ? '__socialSaveClubCred' : '__socialSaveCred';
  const drop = scope === 'club' ? '__socialDropClubCred' : '__socialDropCred';
  return `<div class="cred-row">
    <div class="cred-head">
      <span class="cred-name">${esc(meta.name)}</span>
      <span class="cred-use">${esc(meta.use)}</span>
      ${set ? `<span class="cred-set">已連接 ${esc(c.hint)}</span>`
            : (scope === 'club' ? '<span class="cred-unset">未設定</span>'
                                : credFallbackBadge(c))}
    </div>
    <div class="cred-actions">
      <input type="password" id="cred_${id}" class="cred-input"
             placeholder="${set ? '貼上新的金鑰以覆蓋' : '貼上 API 金鑰'}" autocomplete="off">
      <button class="btn-mini" onclick="window.${save}('${c.provider}', this)">儲存</button>
      ${set ? `<button class="btn-mini danger" onclick="window.${drop}('${c.provider}', this)">移除</button>` : ''}
    </div>
    ${scope === 'me' && meta.url
      ? `<a class="cred-link" href="${meta.url}" target="_blank" rel="noreferrer">到 ${esc(meta.name)} 取得金鑰 ↗</a>` : ''}
  </div>`;
}

const closeCredModal = () => { document.getElementById('credModal').style.display = 'none'; };

function renderCreds() {
  const body = document.getElementById('credBody');
  body.innerHTML = `
    <p class="cred-intro">金鑰加密後存放，存好之後<strong>不會再顯示出來</strong>，畫面上只看得到末四碼。<br>
       取用順序是<strong>你自己的 → 分會共用的 → 伺服器的</strong>。
       填了自己的就走自己的帳號計費，沒填就用分會那組。<br>
       <strong>產生文案</strong>兩家都可以，在產生視窗裡選。<strong>AI 生圖只有 OpenAI 能做</strong>
       ——Anthropic 的 API 不輸出圖片。</p>

    <div class="cred-section">我的帳號</div>
    ${creds.map((c) => credRow(c, { scope: 'me' })).join('')}

    ${clubCreds.length ? `
      <div class="cred-section">分會共用帳號</div>
      <p class="cred-intro">整個分會共用這一組，任何幹部產生內容都算在它頭上。
         設一組之後，新幹部第一天就能用，不必自己去辦 API 帳號——
         但也表示<strong>費用是分會在付</strong>。只有幹部看得到這一區。</p>
      ${clubCreds.map((c) => credRow(c, { scope: 'club' })).join('')}
    ` : ''}`;
}

async function saveClubCred(provider, btn) {
  const el = document.getElementById(`cred_club_${provider}`);
  const key = (el?.value || '').trim();
  if (!key) { toast('請先貼上金鑰', true); return; }
  const restore = busyButton(btn, '儲存中…');
  try {
    await apiJson(`/clubs/${activeClubId()}/ai-credentials/${provider}`,
                  { method: 'PUT', body: { api_key: key } });
    await openCredModal();
    await loadCreds();
    toast('已儲存分會共用金鑰');
  } catch (e) {
    toast(e.message || '儲存失敗', true);
  } finally {
    restore();
  }
}

async function dropClubCred(provider, btn) {
  if (!confirm('移除之後，沒有自己金鑰的幹部就無法使用這個服務，確定嗎？')) return;
  const restore = busyButton(btn, '移除中…');
  try {
    await apiJson(`/clubs/${activeClubId()}/ai-credentials/${provider}`,
                  { method: 'DELETE' });
    await openCredModal();
    await loadCreds();
    toast('已移除');
  } catch (e) {
    toast(e.message || '移除失敗', true);
  } finally {
    restore();
  }
}

async function saveCred(provider, btn) {
  const el = document.getElementById(`cred_me_${provider}`);
  const key = (el?.value || '').trim();
  if (!key) { toast('請先貼上金鑰', true); return; }
  const restore = busyButton(btn, '儲存中…');
  try {
    await apiJson(`/me/ai-credentials/${provider}`, { method: 'PUT', body: { api_key: key } });
    if (el) el.value = '';
    creds = await apiJson('/me/ai-credentials');
    renderCreds();               // rebuilds the row, so `btn` is gone by now
    toast('已儲存金鑰');
  } catch (e) {
    restore();
    toast(e.message || '儲存金鑰失敗', true);
  }
}

async function dropCred(provider, btn) {
  if (!confirm('確定要移除這組金鑰嗎？')) return;
  const restore = busyButton(btn, '移除中…');
  try {
    await apiJson(`/me/ai-credentials/${provider}`, { method: 'DELETE' });
    creds = await apiJson('/me/ai-credentials');
    renderCreds();
    toast('已移除');
  } catch {
    restore();
    toast('移除失敗', true);
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

/** Spinner + label on a button while an await runs; returns its undo. */
function busyButton(btn, label) {
  if (!btn) return () => {};
  const html = btn.innerHTML;
  const was  = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-sm"></span>${esc(label)}`;
  return () => { btn.innerHTML = html; btn.disabled = was; };
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast visible' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3600);
}

export default function SocialPage() {
  const [saveDisabled, setSaveDisabledState] = useState(true);
  const [saveLabel, setSaveLabelState] = useState('儲存');

  useEffect(() => {
    window.__socialKind        = (v) => { if (!current) return; current.kind = v; renderEditor(); updateSaveBar(); };
    window.__socialOpenTmpl    = openTmplModal;
    window.__socialOpen        = openPost;
    window.__socialNew         = newPost;
    window.__socialField       = setField;
    window.__socialVariant     = setVariant;
    window.__socialTab         = switchTab;
    window.__socialFillAll     = fillAllFromBody;
    window.__socialCopy        = copyActive;
    window.__socialUpload      = uploadImages;
    window.__socialRemoveImage = removeImage;
    window.__socialMoveImage   = moveImage;
    window.__socialPreview     = openPreview;
    window.__socialDelete      = deletePost;
    window.__socialOpenGen     = openGenModal;
    window.__socialOpenImg     = openImgModal;
    window.__socialOpenPublish = openPublishModal;
    window.__socialSaveCred    = saveCred;
    window.__socialSaveClubCred = saveClubCred;
    window.__socialDropClubCred = dropClubCred;
    window.__socialDropCred    = dropCred;
    window.__socialReview      = reviewPost;
    window.__socialPoster      = makePoster;
    window.__socialOpenPrefs   = openPrefsModal;
    window.__pp                = ppHandlers;   // 貼文品牌設定 dialog
    setSaveDisabled = setSaveDisabledState;
    setSaveLabel    = setSaveLabelState;

    applyRoleUI();

    const onKeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        savePost();
      }
    };
    const onBeforeUnload = (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('beforeunload', onBeforeUnload);

    (async function init() {
      const ok = await checkSocialAuth();
      if (!ok) return;
      await Promise.all([loadClubs(), loadCreds(), loadAiModels()]);
      await Promise.all([loadPosts(), loadAgendas(), loadSocialAccounts()]);
      renderEditor();
    })();

    return () => {
      ['__socialOpen', '__socialNew', '__socialField', '__socialVariant', '__socialTab',
       '__socialFillAll', '__socialCopy', '__socialUpload', '__socialRemoveImage',
       '__socialDelete', '__socialOpenGen', '__socialOpenImg', '__socialOpenPublish',
       '__socialSaveCred', '__socialDropCred', '__socialReview', '__socialPoster',
       '__socialOpenPrefs', '__pp'].forEach((k) => { delete window[k]; });
      setSaveDisabled = null;
      setSaveLabel = null;
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      if (genBusy) { clearInterval(genBusy.timer); genBusy = null; }
      if (publishBusy) { clearInterval(publishBusy); publishBusy = null; }
      pendingImages = [];
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  return (
    <>
      <Sidebar active="social" />

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">社群發文</div>
          <div className="topbar-actions">
            <span className="save-state" id="saveState"></span>
            <button className="btn-ghost" onClick={openCredModal}>AI 帳號</button>
            {/* Also reachable without a post open: it holds the club's PPTX
                templates, which people look for before writing anything. */}
            <button className="btn-ghost write-action" onClick={openPrefsModal}>貼文品牌設定・海報模板</button>
            <button className="btn-add write-action" onClick={savePost} disabled={saveDisabled}>{saveLabel}</button>
          </div>
        </header>

        <div className="content">
          <div className="picker-card">
            <div id="clubPickerBar" style={{ display: 'none' }}>
              <span className="picker-label">
                分會
                <SearchableSelect id="clubPickerSelect" className="picker-select" onChange={onClubChange} style={{ marginLeft: 6 }} placeholder="輸入分會名稱搜尋…" emptyText="找不到符合的分會">
                  <option value="">— 請選擇分會 —</option>
                </SearchableSelect>
              </span>
            </div>
            <div className="toolbar-spacer"></div>
            <span className="pager-label">
              發布前請先到「分會管理 → 社群」連接平台帳號；未連接的平台在發布視窗會顯示「未連接帳號」且無法勾選。
            </span>
          </div>

          <div className="social-layout">
            <div className="list-card">
              <div className="list-head">
                <span className="list-title">貼文草稿</span>
                <span className="list-count" id="postCount">0 則</span>
                <button className="btn-mini write-action" onClick={newPost}>＋ 新增</button>
              </div>
              <div className="post-list" id="postList">
                <div className="loading-spinner"><div className="spinner"></div></div>
              </div>
            </div>

            <div className="editor-card" id="editorWrap"></div>
          </div>
        </div>
      </div>

      <div id="toast" className="toast"></div>

      {/* AI copy */}
      <div id="genModal" className="modal-overlay" style={{ display: 'none' }}
           onClick={(e) => { if (e.target === e.currentTarget) closeGenModal(); }}>
        <div className="modal-box">
          <div className="modal-header">
            <h3>AI 產生文案</h3>
            <button className="modal-close" onClick={closeGenModal}>✕</button>
          </div>
          <div className="modal-body">
            <div id="genProgress" style={{ display: 'none' }} className="gen-progress">
              <div className="spinner"></div>
              <div className="gen-progress-t"></div>
              <div className="gen-progress-s"></div>
              <div className="gen-progress-n">這通常要 20–60 秒，請不要關閉視窗。</div>
            </div>
            <div id="genForm">
            <div className="modal-note" id="genAgendaNote"></div>
            <label className="modal-field-label">用哪個 AI 帳號</label>
            <select id="genProvider" className="ed-select ed-select-wide"
                    onChange={syncGenModels}></select>
            <div className="modal-field-hint" id="genProviderHint"></div>
            <label className="modal-field-label">模型</label>
            <select id="genModel" className="ed-select ed-select-wide"></select>
            <div className="modal-field-hint">
              價格是每百萬 token 的輸入／輸出，一則貼文大約幾千 token。
              換一個更省的通常也寫得動，值不值得省要看你對文案品質的要求。
            </div>
            <label className="modal-field-label">補充指示（選填）</label>
            <textarea id="genBrief" className="modal-textarea" rows="4"
                      placeholder="例如：這次想強調歡迎新朋友來參觀，語氣輕鬆一點"></textarea>
            <div id="genGoverned" style={{ display: 'none' }}></div>
            <label className="modal-field-label">要產生哪些平台</label>
            <div className="modal-checks">
              {SOCIAL_PLATFORMS.map((p) => (
                <label key={p.key} className="modal-check">
                  <input type="checkbox" id={`genP_${p.key}`} defaultChecked />
                  {p.label}
                </label>
              ))}
            </div>
            <p className="modal-field-hint">一律使用你自己連接的 AI 帳號計費。產生的內容會覆蓋目前的主文案與所選平台版本。</p>
            </div>
          </div>
          <div className="modal-actions">
            <button className="modal-btn modal-btn-cancel" onClick={closeGenModal}>取消</button>
            <button className="modal-btn modal-btn-confirm" id="genConfirmBtn" onClick={runGenerate}>產生</button>
          </div>
        </div>
      </div>

      {/* 貼文品牌設定 + PPTX poster templates */}
      <div id="prefsModal" className="modal-overlay" style={{ display: 'none' }}
           onClick={(e) => { if (e.target === e.currentTarget) closePrefsModal(); }}>
        <div className="modal-box pp-box" role="dialog" aria-labelledby="prefsTitle">
          <div className="modal-header pp-header">
            <div>
              <h3 id="prefsTitle">貼文品牌設定</h3>
              <div className="pp-subtitle">例會宣傳與回顧的受控生成會用到這些設定，整個分會共用。</div>
            </div>
            <button className="modal-close" onClick={closePrefsModal} aria-label="關閉">✕</button>
          </div>
          <div className="pp-tabs" id="prefsTabs" role="tablist"></div>
          <div className="modal-body pp-body" id="prefsBody"></div>
          <div className="modal-actions pp-actions">
            <span className="pp-state" id="prefsState"></span>
            <button className="modal-btn modal-btn-cancel" onClick={closePrefsModal}>關閉</button>
            <button className="modal-btn modal-btn-confirm write-action" id="prefsSaveBtn" onClick={savePrefs}>儲存設定</button>
          </div>
        </div>
      </div>

      {/* AI image */}
      <div id="previewModal" className="modal-overlay preview-overlay" style={{ display: 'none' }}
           onClick={(e) => { if (e.target === e.currentTarget) closePreview(); }}>
        <div className="preview-box">
          <div className="preview-head">
            <span id="previewName"></span>
            <button className="modal-close" onClick={closePreview}>✕</button>
          </div>
          <div className="preview-body" id="previewBody"></div>
        </div>
      </div>

      <div id="tmplModal" className="modal-overlay" style={{ display: 'none' }}
           onClick={(e) => { if (e.target === e.currentTarget) closeTmplModal(); }}>
        <div className="modal-box modal-box-wide">
          <div className="modal-header">
            <h3>套用版型</h3>
            <button className="modal-close" onClick={closeTmplModal}>✕</button>
          </div>
          <div className="modal-body">
            <div className="modal-note" id="tmplNote"></div>
            <div className="tmpl-grid">
              <div>
                <label className="modal-field-label">版面</label>
                <select id="tmplPick" className="ed-select ed-select-wide"
                        onChange={refreshTmplPreview}></select>
                <label className="modal-field-label">插圖</label>
                <select id="tmplBg" className="ed-select ed-select-wide"
                        onChange={(e) => onTmplBgChange(e.target)}></select>
                <div className="tmpl-bg-state" id="tmplBgState"></div>
                <label className="tmpl-check">
                  <input type="checkbox" id="tmplHideTitle"
                         onChange={refreshTmplPreview} />
                  插圖裡已經有主題標題，不要再寫一次
                </label>
                <p className="modal-field-hint">
                  插圖用這則貼文裡的圖片——上傳的照片、AI 生圖，
                  或用 PowerPoint／Canva 設計好再匯出成 PNG 上傳。
                  日期、地址、入場費一律由系統疊成<strong>真實文字</strong>——
                  影像模型畫中文會壞，不能交給它。
                </p>
              </div>
              <div className="tmpl-preview">
                <canvas id="tmplCanvas"></canvas>
              </div>
            </div>
          </div>
          <div className="modal-actions">
            <button className="modal-btn modal-btn-cancel" onClick={closeTmplModal}>取消</button>
            <button className="modal-btn modal-btn-confirm" id="tmplConfirmBtn"
                    onClick={runApplyTemplate}>加入這則貼文</button>
          </div>
        </div>
      </div>

      <div id="imgModal" className="modal-overlay" style={{ display: 'none' }}
           onClick={(e) => { if (e.target === e.currentTarget) closeImgModal(); }}>
        <div className="modal-box">
          <div className="modal-header">
            <h3>AI 生圖</h3>
            <button className="modal-close" onClick={closeImgModal}>✕</button>
          </div>
          <div className="modal-body">
            <label className="modal-field-label">想要什麼樣的圖片</label>
            <textarea id="imgPrompt" className="modal-textarea" rows="4"
                      placeholder="例如：一群人在明亮的會議室裡鼓掌，暖色調，扁平插畫風格，不要有文字"></textarea>
            <div id="imgTmplWrap" style={{ display: 'none' }}>
              <label className="tmpl-check">
                <input type="checkbox" id="imgAutoTmpl" defaultChecked />
                產生後直接套成海報（日期、地址、入場費會疊在圖上）
              </label>
              <select id="imgTmplPick" className="ed-select ed-select-wide"></select>
              <p className="modal-field-hint">
                只會加入合成後的海報，不另外留一張原圖。
                提示詞請描述<strong>插圖本身</strong>就好——版面、文字由版型負責。
              </p>
            </div>
            <div className="modal-field-hint" id="imgNoTmplNote"></div>
            <label className="modal-field-label">模型</label>
            <select id="imgModel" className="ed-select ed-select-wide"></select>
            <label className="modal-field-label">品質</label>
            <select id="imgQuality" className="ed-select ed-select-wide" defaultValue="low">
              <option value="low">低（最省，社群插圖通常夠用）</option>
              <option value="medium">中</option>
              <option value="high">高（最貴，約低品質的 15 倍）</option>
              <option value="auto">自動（由模型決定，費用不可預期）</option>
            </select>
            <label className="modal-field-label">尺寸</label>
            <select id="imgSize" className="ed-select ed-select-wide" defaultValue="1024x1024">
              <option value="1024x1024">正方形 1024×1024（IG 首選）</option>
              <option value="1024x1536">直式 1024×1536</option>
              <option value="1536x1024">橫式 1536×1024</option>
            </select>
            <p className="modal-field-hint">
              使用你自己的 OpenAI 帳號計費。圖片會存進雲端並加入這則貼文。
              品質與尺寸都會影響單價——低品質正方形每張約 US$0.01，
              高品質直式約 US$0.25。
            </p>
          </div>
          <div className="modal-actions">
            <button className="modal-btn modal-btn-cancel" onClick={closeImgModal}>取消</button>
            <button className="modal-btn modal-btn-confirm" id="imgConfirmBtn" onClick={runGenerateImage}>生成</button>
          </div>
        </div>
      </div>

      {/* Publish */}
      <div id="publishModal" className="modal-overlay" style={{ display: 'none' }}
           onClick={(e) => { if (e.target === e.currentTarget) closePublishModal(); }}>
        <div className="modal-box">
          <div className="modal-header">
            <h3>發布到社群平台</h3>
            <button className="modal-close" onClick={closePublishModal}>✕</button>
          </div>
          <div className="modal-body">
            <div id="publishProgress" style={{ display: 'none' }} className="gen-progress">
              <div className="spinner"></div>
              <div className="gen-progress-t">正在發布…</div>
              <div className="gen-progress-s"></div>
              <div className="gen-progress-n">每個平台要好幾次 API 呼叫，請不要關閉視窗。</div>
            </div>
            <div id="publishBody"></div>
          </div>
          <div className="modal-actions">
            <button className="modal-btn modal-btn-cancel" onClick={closePublishModal}>取消</button>
            <button className="modal-btn modal-btn-confirm" id="publishConfirmBtn" onClick={runPublish}>發布</button>
          </div>
        </div>
      </div>

      {/* AI accounts */}
      <div id="credModal" className="modal-overlay" style={{ display: 'none' }}
           onClick={(e) => { if (e.target === e.currentTarget) closeCredModal(); }}>
        <div className="modal-box modal-box-wide">
          <div className="modal-header">
            <h3>AI 帳號</h3>
            <button className="modal-close" onClick={closeCredModal}>✕</button>
          </div>
          <div className="modal-body" id="credBody"></div>
          <div className="modal-actions">
            <button className="modal-btn modal-btn-cancel" onClick={closeCredModal}>關閉</button>
          </div>
        </div>
      </div>
    </>
  );
}
