'use client';

import { useEffect, useState } from 'react';
import { apiJson, apiFetch } from '@/lib/api';
import { setAuth, clearAuth, applyRoleUI, isSystemAdmin, canWrite, getClubId } from '@/lib/auth';
import { SOCIAL_PLATFORMS, PLATFORM_KEYS, platformSpec, platformWarnings,
         mediaKind, mediaLabel } from '@/lib/socialPlatforms';
import { POST_KINDS, KIND_KEYS, KIND_REQUIRED, kindSpec, kindLabel,
         templatesFor, templateValues, drawTemplate, canvasToBlob }
  from '@/lib/postTemplates';
import Sidebar from '@/components/Sidebar';
import './social.css';

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

let setSaveDisabled = null;   // React bridges (see the note in app/roles/page.js)
let setSaveLabel    = null;

const activeClubId = () => (isSystemAdmin() ? selectedClubId : getClubId());

const blankPost = () => ({
  id: null, clubId: activeClubId(), agendaId: null, kind: 'other',
  title: '', status: 'draft', body: '',
  variants: Object.fromEntries(PLATFORM_KEYS.map((k) => [k, { text: '', enabled: true }])),
  images: [],
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
           published: p.published || {} };
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
    setAuth(data.username, data.role, data.club_id, data.must_change_pw);
    if (data.must_change_pw) { location.href = '/change-password'; return false; }
    document.getElementById('navUser').textContent = data.username;
    document.getElementById('userAvatar').textContent = data.username.slice(0, 1).toUpperCase();
    applyRoleUI();
    return true;
  } catch {
    clearAuth();
    location.href = '/login';
    return false;
  }
}

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
      <span class="ai-bar-hint">會讀取上面綁定的例會資料，用你自己的 Anthropic 帳號產生。</span>
    </div>` : ''}

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
      <div id="imgStrip" class="img-strip"></div>
      ${canWrite() ? `
      <div class="img-actions">
        <label class="btn-mini btn-file">
          上傳圖片／影片
          <input type="file" accept="image/*,video/*" multiple onchange="window.__socialUpload(this)">
        </label>
        <button class="btn-mini" onclick="window.__socialOpenImg()">AI 生圖</button>
        ${templatesFor(current.kind).length
          ? '<button class="btn-mini" onclick="window.__socialOpenTmpl()">套用版型</button>' : ''}
        <span class="ai-bar-hint">AI 生圖使用你自己的 OpenAI 帳號。版型會把日期、地址、入場費疊成真實文字。</span>
      </div>` : ''}
    </div>

    ${canWrite() ? `
    <div class="ed-publish">
      <button class="btn-publish" onclick="window.__socialOpenPublish()">發布到社群平台</button>
      <span class="ai-bar-hint">${
        socialAccounts.length
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
    <div class="img-thumb">
      ${mediaKind(img) === 'video'
        // preload=metadata so the tile shows a real frame without pulling the
        // whole file; these are meeting clips, not thumbnails.
        ? `<video src="${esc(img.url)}" muted playsinline preload="metadata"></video>
           <span class="img-badge">影片</span>`
        : `<img src="${esc(img.url)}" alt="${esc(img.name || '')}">`}
      ${canWrite() ? `<button class="img-del" onclick="window.__socialRemoveImage(${i})" title="移除">✕</button>` : ''}
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
      await apiJson(`/social-posts/${current.id}`, { method: 'PUT', body });
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
  PLATFORM_KEYS.forEach((k) => {
    const el = document.getElementById(`genP_${k}`);
    if (el) el.checked = current.variants[k].enabled;
  });
  const note = document.getElementById('genAgendaNote');
  const a = agendas.find((x) => x.id === current.agendaId);
  note.textContent = a
    ? `會參考：${a.meetingDate || ''}${a.meetingTheme ? ` · ${a.meetingTheme}` : ''}`
    : '尚未綁定例會 — 只會依你寫的補充指示產生。';
  modal.style.display = 'flex';
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
  const brief = document.getElementById('genBrief').value;

  // This one call can run for the better part of a minute, so the modal turns
  // into a progress panel rather than leaving a dead form on screen.
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
      },
    });
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

  const restore = busyButton(document.getElementById('imgConfirmBtn'), '送出中…');
  let job;
  try {
    job = await apiJson('/ai-jobs', {
      method: 'POST',
      body: { kind: 'image', club_id: activeClubId(), params: { prompt, size } },
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

  const entry = { jobId: job.id, owner: current, prompt, startedAt: Date.now() };
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
      finishPending(entry);
      // The post object is the identity here: reloading a post replaces it, so
      // an image must never land on whatever happens to be open now.
      if (current === entry.owner) {
        current.images.push(job.result);
        renderImages();
        refreshPaneMeta();
        updateSaveBar();
        toast('圖片已加入，記得儲存');
      } else {
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

  // The meeting already has a theme illustration; that is the default, so the
  // common case is open-and-confirm rather than hunt-for-a-picture. The post's
  // own stills are offered as alternatives; videos cannot be artwork.
  const bsel = document.getElementById('tmplBg');
  const photos = (current.images || [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => mediaKind(m) === 'image');
  bsel.innerHTML = [
    tmplFields.themeImg ? '<option value="theme">例會主題圖（預設）</option>' : '',
    ...photos.map(({ m, i }) =>
      `<option value="${i}">${esc(m.name || `圖片 ${i + 1}`)}</option>`),
    '<option value="">不放插圖</option>',
  ].join('');
  bsel.value = tmplFields.themeImg ? 'theme' : '';
  tmplBg = null;
  await onTmplBgChange(bsel);
}

const closeTmplModal = () => {
  document.getElementById('tmplModal').style.display = 'none';
  tmplBg = null;
};

async function onTmplBgChange(sel) {
  const v = sel.value;
  let url = '';
  if (v === 'theme') url = tmplFields?.themeImg || '';
  else if (v !== '') url = current.images[parseInt(v, 10)]?.url || '';

  tmplBg = null;
  if (url) {
    try {
      tmplBg = await loadBackground(url);
    } catch (e) {
      toast(e.message || '插圖讀取失敗', true);
    }
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
  });
}

async function runApplyTemplate() {
  const canvas = document.getElementById('tmplCanvas');
  if (!canvas || !current) return;
  const restore = busyButton(document.getElementById('tmplConfirmBtn'), '產生中…');
  try {
    const blob = await canvasToBlob(canvas);
    const { uploadUrl, publicUrl } = await apiJson('/upload/presign', {
      method: 'POST',
      body: { filename: `template-${Date.now()}.png`, content_type: 'image/png',
              club_id: activeClubId() },
    });
    const put = await fetch(uploadUrl, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob,
    });
    if (!put.ok) throw new Error('上傳至雲端失敗');
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

async function openCredModal() {
  document.getElementById('credModal').style.display = 'flex';
  const body = document.getElementById('credBody');
  body.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  try {
    creds = await apiJson('/me/ai-credentials');
    renderCreds();
  } catch {
    body.innerHTML = '<div class="list-empty">載入失敗</div>';
  }
}

const closeCredModal = () => { document.getElementById('credModal').style.display = 'none'; };

function renderCreds() {
  const body = document.getElementById('credBody');
  body.innerHTML = `
    <p class="cred-intro">金鑰只屬於你自己，會加密後存放，存好之後<strong>不會再顯示出來</strong>，
       畫面上只看得到末四碼。所有 AI 產生都是走你自己的帳號計費。<br>
       <strong>產生文案</strong>兩家都可以，在產生視窗裡選。<strong>AI 生圖只有 OpenAI 能做</strong>
       ——Anthropic 的 API 不輸出圖片——而且生圖沒有伺服器帳號可退，一定要連自己的。</p>
    ${creds.map((c) => {
      const meta = PROVIDER_LABELS[c.provider] || { name: c.provider, use: '', url: '' };
      const set  = !!c.hint;
      return `<div class="cred-row">
        <div class="cred-head">
          <span class="cred-name">${esc(meta.name)}</span>
          <span class="cred-use">${esc(meta.use)}</span>
          ${set ? `<span class="cred-set">已連接 ${esc(c.hint)}</span>`
                : (c.serverFallback
                    ? '<span class="cred-fallback">未連接，目前用伺服器帳號</span>'
                    : '<span class="cred-unset">未連接</span>')}
        </div>
        <div class="cred-actions">
          <input type="password" id="cred_${c.provider}" class="cred-input"
                 placeholder="${set ? '貼上新的金鑰以覆蓋' : '貼上 API 金鑰'}" autocomplete="off">
          <button class="btn-mini" onclick="window.__socialSaveCred('${c.provider}', this)">儲存</button>
          ${set ? `<button class="btn-mini danger" onclick="window.__socialDropCred('${c.provider}', this)">移除</button>` : ''}
        </div>
        ${meta.url ? `<a class="cred-link" href="${meta.url}" target="_blank" rel="noreferrer">到 ${esc(meta.name)} 取得金鑰 ↗</a>` : ''}
      </div>`;
    }).join('')}`;
}

async function saveCred(provider, btn) {
  const el = document.getElementById(`cred_${provider}`);
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
    window.__socialDelete      = deletePost;
    window.__socialOpenGen     = openGenModal;
    window.__socialOpenImg     = openImgModal;
    window.__socialOpenPublish = openPublishModal;
    window.__socialSaveCred    = saveCred;
    window.__socialDropCred    = dropCred;
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
      await Promise.all([loadClubs(), loadCreds()]);
      await Promise.all([loadPosts(), loadAgendas(), loadSocialAccounts()]);
      renderEditor();
    })();

    return () => {
      ['__socialOpen', '__socialNew', '__socialField', '__socialVariant', '__socialTab',
       '__socialFillAll', '__socialCopy', '__socialUpload', '__socialRemoveImage',
       '__socialDelete', '__socialOpenGen', '__socialOpenImg', '__socialOpenPublish',
       '__socialSaveCred', '__socialDropCred'].forEach((k) => { delete window[k]; });
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
            <button className="btn-add write-action" onClick={savePost} disabled={saveDisabled}>{saveLabel}</button>
          </div>
        </header>

        <div className="content">
          <div className="picker-card">
            <div id="clubPickerBar" style={{ display: 'none' }}>
              <span className="picker-label">
                分會
                <select id="clubPickerSelect" className="picker-select" onChange={onClubChange} style={{ marginLeft: 6 }}>
                  <option value="">— 請選擇分會 —</option>
                </select>
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
            <select id="genProvider" className="ed-select ed-select-wide"></select>
            <div className="modal-field-hint" id="genProviderHint"></div>
            <label className="modal-field-label">補充指示（選填）</label>
            <textarea id="genBrief" className="modal-textarea" rows="4"
                      placeholder="例如：這次想強調歡迎新朋友來參觀，語氣輕鬆一點"></textarea>
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

      {/* AI image */}
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
                <p className="modal-field-hint">
                  預設用這場例會的主題圖，也可以換成貼文裡的其他圖片，
                  或用 PowerPoint／Canva 設計好再匯出成 PNG 上傳。
                  <strong>主題標題已經畫在插圖裡時，版面不會再重複寫一次。</strong>
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
            <label className="modal-field-label">尺寸</label>
            <select id="imgSize" className="ed-select ed-select-wide" defaultValue="1024x1024">
              <option value="1024x1024">正方形 1024×1024（IG 首選）</option>
              <option value="1024x1536">直式 1024×1536</option>
              <option value="1536x1024">橫式 1536×1024</option>
            </select>
            <p className="modal-field-hint">使用你自己的 OpenAI 帳號計費。圖片會存進雲端並加入這則貼文。</p>
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
