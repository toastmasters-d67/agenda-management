'use client';

// ================================================================
// SOCIAL PLATFORM SPECS
// ================================================================
// What differs between Facebook, Instagram and Threads, expressed once so the
// composer's counters, warnings and preview cards all agree. The backend keeps
// its own short prose version of the same rules for the copywriting prompt
// (api/index.py, _PLATFORM_BRIEF) — that one is instructions for a model, this
// one is checks for a person, so they are deliberately not shared.
//
// LinkedIn is absent on purpose: its posting API is gated behind a partner
// review that the club has not started, so shipping a LinkedIn tab now would
// promise something the app cannot do.

export const SOCIAL_PLATFORMS = [
  {
    key: 'facebook',
    label: 'Facebook',
    short: 'FB',
    // Facebook's own cap. Nobody reaches it — the counter exists so the field
    // has the same furniture as the other two, and turns amber long before.
    max: 63206,
    soft: 1500,
    needsMedia: false,
    // A Page post is a video or photos, never both, and /videos takes one file.
    maxMedia: null,
    maxVideos: 1,
    allowsMixedMedia: false,
    linksClickable: true,
    hint: '連結可點。字數寬鬆，但超過 3 行就會被折疊成「查看更多」。影片一則只能放一支，且不能和圖片混放。',
  },
  {
    key: 'instagram',
    label: 'Instagram',
    short: 'IG',
    max: 2200,
    soft: 1200,
    needsMedia: true,
    maxMedia: 10,
    maxVideos: 10,
    allowsMixedMedia: true,
    linksClickable: false,
    hint: '一定要有圖片或影片。單支影片會發成 Reels。內文連結不可點，請改寫成「報名連結在個人簡介」。',
  },
  {
    key: 'threads',
    label: 'Threads',
    short: 'TH',
    max: 500,
    soft: 450,
    needsMedia: false,
    maxMedia: 20,
    maxVideos: 20,
    allowsMixedMedia: true,
    linksClickable: true,
    hint: '上限 500 字，口語為主，hashtag 越少越好。多個項目會發成輪播。',
  },
];

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
