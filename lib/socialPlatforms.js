'use client';

import platformData from './socialPlatforms.json';

// ================================================================
// SOCIAL PLATFORM SPECS
// ================================================================
// What differs between Facebook, Instagram and Threads, expressed once so the
// composer's counters, warnings and preview cards all agree, and so the
// backend's rendered variants fit the same limits. The backend also keeps a
// short prose version for the copywriting prompt (api/index.py,
// _PLATFORM_BRIEF) — instructions for a model, not numbers to check against.
//
// LinkedIn is absent on purpose: its posting API is gated behind a partner
// review that the club has not started, so shipping a LinkedIn tab now would
// promise something the app cannot do.

// The data lives in socialPlatforms.json so the backend reads the same limits
// (api/_postgen/renderers/social.py renders the IG / Threads variants to them).
// Facebook's `max` is its own cap; nobody reaches it — the counter exists so
// the field has the same furniture as the other two. A Page post is a video or
// photos, never both, and /videos takes one file (`allowsMixedMedia`).
export const SOCIAL_PLATFORMS = platformData.platforms;

export const PLATFORM_KEYS = SOCIAL_PLATFORMS.map((p) => p.key);

export const platformSpec = (key) =>
  SOCIAL_PLATFORMS.find((p) => p.key === key) || SOCIAL_PLATFORMS[0];

/** Bare URLs in the caption — the thing Instagram silently renders as plain text. */
const URL_RE = /\bhttps?:\/\/[^\s]+/gi;

const VIDEO_RE = /\.(mp4|mov|m4v|webm)(\?|$)/i;

/**
 * 'image' or 'video' for one attachment. Mirrors _media_kind in api/index.py —
 * the uploader's recorded type wins, and the extension is the fallback for
 * rows written before uploads recorded one.
 */
export const mediaKind = (item) => {
  if (item && (item.type === 'image' || item.type === 'video')) return item.type;
  return VIDEO_RE.test(String((item && item.url) || '')) ? 'video' : 'image';
};

/** "2 張圖、1 支影片" — for list rows and counters. */
export function mediaLabel(list = []) {
  const v = list.filter((m) => mediaKind(m) === 'video').length;
  const i = list.length - v;
  return [i ? `${i} 張圖` : '', v ? `${v} 支影片` : ''].filter(Boolean).join('、');
}

/**
 * Everything wrong with one platform's caption right now.
 * Returns [{ level: 'error' | 'warn', text }] — `error` means the platform
 * would reject or mangle it, `warn` means it will post but read badly.
 */
export function platformWarnings(key, text, media = []) {
  const spec = platformSpec(key);
  const body = String(text || '');
  const out  = [];

  const videos = media.filter((m) => mediaKind(m) === 'video');
  const photos = media.filter((m) => mediaKind(m) === 'image');

  if (spec.needsMedia && !media.length) {
    out.push({ level: 'error', text: `${spec.label} 貼文一定要有圖片或影片，請先上傳至少一個` });
  }
  if (!body.trim()) {
    out.push({ level: 'error', text: '文案還是空的' });
  }
  if (body.length > spec.max) {
    out.push({ level: 'error', text: `超出 ${spec.label} 上限 ${body.length - spec.max} 字` });
  } else if (body.length > spec.soft) {
    out.push({ level: 'warn', text: `已經 ${body.length} 字，${spec.label} 上偏長` });
  }

  // Media rules differ enough between the three that a post valid on one is
  // rejected by another. Saying so here beats relaying a Meta error later.
  if (spec.maxVideos != null && videos.length > spec.maxVideos) {
    out.push({
      level: 'error',
      text: `${spec.label} 一則最多 ${spec.maxVideos} 支影片，目前有 ${videos.length} 支`,
    });
  }
  if (!spec.allowsMixedMedia && videos.length && photos.length) {
    out.push({
      level: 'error',
      text: `${spec.label} 不能在同一則貼文裡混放影片和圖片，請分成兩則`,
    });
  }
  if (spec.maxMedia != null && media.length > spec.maxMedia) {
    out.push({
      level: 'error',
      text: `${spec.label} 最多 ${spec.maxMedia} 個項目，目前有 ${media.length} 個`,
    });
  }

  const links = body.match(URL_RE) || [];
  if (links.length && !spec.linksClickable) {
    out.push({
      level: 'warn',
      text: `${spec.label} 的內文連結不可點（${links[0]}），建議改寫成「連結在個人簡介」`,
    });
  }
  return out;
}

/** Simple, predictable count — what the platforms themselves show. */
export const charCount = (text) => String(text || '').length;
