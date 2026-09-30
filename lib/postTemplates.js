'use client';

// ================================================================
// POST KINDS & IMAGE TEMPLATES
// ================================================================
// Three kinds of post, and the image templates that go with two of them.
//
// Why the text is drawn here rather than asked for in the image prompt:
// image models render Chinese badly — warped strokes, invented characters —
// which is why the generate-image hint tells you to ask for a picture with no
// text in it. A promo whose whole job is to carry a date, an address and a
// door fee cannot rely on that. So the model (or a photo, or a slide exported
// from PowerPoint) supplies the background, and these templates draw the facts
// over it as real text, from the same `/meeting-fields` the copywriter reads.
//
// Rendering runs in the browser on a plain 2D canvas: the fonts are already
// installed there, nothing has to be packaged, and no server-side converter
// (which Vercel could not run anyway) sits in the path. The composed PNG goes
// to R2 like any uploaded image, so the publishing pipeline is unchanged.

export const POST_KINDS = [
  {
    key: 'promo',
    label: '例會宣傳',
    hint: '邀請人來參加下一場。文案與圖都會帶上日期、地址、入場費。',
  },
  {
    key: 'recap',
    label: '例會回顧',
    hint: '記錄剛結束的那場例會：誰上台、講了什麼、現場如何。',
  },
  {
    key: 'other',
    label: '其他',
    hint: '特殊活動、重要事項佈達等，以你寫的補充指示為主。',
  },
];

export const KIND_KEYS = POST_KINDS.map((k) => k.key);
export const kindSpec  = (key) =>
  POST_KINDS.find((k) => k.key === key) || POST_KINDS[2];
export const kindLabel = (key) => kindSpec(key).label;

/** Which facts a kind is refused without — mirrors _KIND_REQUIRED in api/index.py. */
export const KIND_REQUIRED = {
  promo: [['date', '日期'], ['venue', '地址'], ['fee', '入場費']],
};

// ---------------------------------------------------------------- palette
const INK   = '#ffffff';
const MUTED = 'rgba(255,255,255,0.82)';
const ACCENT = '#fbbf24';

// Positions are fractions of the canvas, so one definition renders at any size
// and a new aspect ratio is a size change rather than a rewrite.
const promoSlots = [
  { field: 'kindLabel', x: 0.08, y: 0.085, w: 0.84, size: 0.030, weight: 700,
    color: ACCENT, letterSpacing: 0.004 },
  { field: 'clubName', x: 0.08, y: 0.135, w: 0.84, size: 0.042, weight: 600, color: INK },
  { field: 'theme',    x: 0.08, y: 0.225, w: 0.84, size: 0.062, weight: 800, color: INK,
    lineHeight: 1.25, maxLines: 3 },
  { field: 'when',     x: 0.08, y: 0.660, w: 0.84, size: 0.048, weight: 700, color: ACCENT },
  { field: 'venue',    x: 0.08, y: 0.745, w: 0.84, size: 0.034, weight: 500, color: INK,
    lineHeight: 1.45, maxLines: 3 },
  { field: 'fee',      x: 0.08, y: 0.895, w: 0.84, size: 0.036, weight: 700, color: MUTED },
];

const recapSlots = [
  { field: 'kindLabel', x: 0.08, y: 0.085, w: 0.84, size: 0.030, weight: 700,
    color: ACCENT, letterSpacing: 0.004 },
  { field: 'clubName', x: 0.08, y: 0.135, w: 0.84, size: 0.042, weight: 600, color: INK },
  { field: 'theme',    x: 0.08, y: 0.245, w: 0.84, size: 0.064, weight: 800, color: INK,
    lineHeight: 1.25, maxLines: 3 },
  { field: 'session',  x: 0.08, y: 0.860, w: 0.84, size: 0.038, weight: 600, color: MUTED },
];

export const TEMPLATES = [
  { key: 'promo-portrait', kind: 'promo', label: '宣傳・直式 4:5',
    w: 1080, h: 1350, slots: promoSlots, scrim: 0.52 },
  { key: 'promo-square',   kind: 'promo', label: '宣傳・方形 1:1',
    w: 1080, h: 1080, slots: promoSlots, scrim: 0.50 },
  { key: 'recap-portrait', kind: 'recap', label: '回顧・直式 4:5',
    w: 1080, h: 1350, slots: recapSlots, scrim: 0.46 },
];

export const templatesFor = (kind) => TEMPLATES.filter((t) => t.kind === kind);

// ---------------------------------------------------------------- values
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** "2026-09-15" -> "2026/09/15（週二）"; anything unparseable passes through. */
function prettyDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw || '').trim());
  if (!m) return String(raw || '');
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  if (Number.isNaN(d.getTime())) return `${m[1]}/${m[2]}/${m[3]}`;
  return `${m[1]}/${m[2]}/${m[3]}（週${WEEKDAYS[d.getDay()]}）`;
}

/** The API's meeting fields, turned into the strings a template draws. */
export function templateValues(kind, fields = {}) {
  const f = fields || {};
  const when = [prettyDate(f.date), f.time].filter(Boolean).join('  ');
  const fee  = f.fee ? `入場費 ${f.fee}` : '';
  return {
    kindLabel: kindLabel(kind),
    clubName:  f.clubName || '',
    theme:     f.theme || '',
    when,
    venue:     [f.venue, f.transit].filter(Boolean).join('\n'),
    fee,
    session:   [f.meetingNo ? `第 ${f.meetingNo} 次例會` : '', prettyDate(f.date)]
                 .filter(Boolean).join('  ·  '),
  };
}

// ---------------------------------------------------------------- drawing
const FONT_STACK =
  '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif';

/**
 * Break text to fit `maxWidth`.
 *
 * Chinese has no spaces, so a space-only word wrap puts a whole paragraph on
 * one line; breaking anywhere would instead split English words down the
 * middle. This does both: break at the last space when the overflow lands
 * inside a Latin run, and between characters otherwise.
 */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const ch of Array.from(para)) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        const space = line.lastIndexOf(' ');
        const latin = /[A-Za-z0-9]/.test(ch) && space > 0;
        if (latin) {
          lines.push(line.slice(0, space));
          line = line.slice(space + 1) + ch;
        } else {
          lines.push(line);
          line = ch === ' ' ? '' : ch;
        }
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Cover-fit: fill the frame, crop the overflow, never distort. */
function drawCover(ctx, img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * Draw one template onto `canvas`. Preview and export call this same function,
 * so what you approve on screen is what gets uploaded.
 */
export function drawTemplate(canvas, { template, values, background }) {
  const { w, h } = template;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Background: the supplied image, else a quiet gradient so a template with
  // no picture yet still reads as finished rather than broken.
  if (background) {
    drawCover(ctx, background, w, h);
  } else {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#1e3a5f');
    g.addColorStop(1, '#0f172a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // Scrim: text sits over a photo nobody chose for its contrast. Without this
  // a light background makes white text vanish.
  const scrim = ctx.createLinearGradient(0, 0, 0, h);
  scrim.addColorStop(0, `rgba(10,15,28,${(template.scrim ?? 0.5) * 0.9})`);
  scrim.addColorStop(0.45, `rgba(10,15,28,${(template.scrim ?? 0.5) * 0.55})`);
  scrim.addColorStop(1, `rgba(10,15,28,${Math.min(0.92, (template.scrim ?? 0.5) + 0.42)})`);
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, w, h);

  ctx.textBaseline = 'top';
  for (const slot of template.slots) {
    const text = values[slot.field];
    if (!text) continue;                      // an empty fact draws nothing

    const size = Math.round(slot.size * h);
    ctx.font = `${slot.weight || 600} ${size}px ${FONT_STACK}`;
    ctx.fillStyle = slot.color || INK;
    ctx.textAlign = slot.align || 'left';
    if ('letterSpacing' in ctx) {
      ctx.letterSpacing = `${Math.round((slot.letterSpacing || 0) * w)}px`;
    }

    const maxW = slot.w * w;
    let lines = wrapText(ctx, text, maxW);
    if (slot.maxLines && lines.length > slot.maxLines) {
      lines = lines.slice(0, slot.maxLines);
      lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, -1)}…`;
    }

    const lh = size * (slot.lineHeight || 1.3);
    const x = slot.align === 'center' ? (slot.x + slot.w / 2) * w : slot.x * w;
    lines.forEach((line, i) => {
      // A soft shadow rather than an outline: it survives a busy photo without
      // making the type look stickered on.
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = size * 0.35;
      ctx.shadowOffsetY = size * 0.04;
      ctx.fillText(line, x, slot.y * h + i * lh);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    });
  }
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  return canvas;
}

/** The composed image, as a PNG blob ready for the usual R2 upload. */
export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('無法輸出圖片'))),
      'image/png',
    );
  });
}
