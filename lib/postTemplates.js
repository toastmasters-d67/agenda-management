'use client';
import { withBase } from './basePath';

// ================================================================
// POST KINDS & IMAGE TEMPLATES
// ================================================================
// Three kinds of post, and the poster layouts that go with two of them.
//
// Why the facts are drawn here rather than asked for in an image prompt:
// image models render Chinese badly — warped strokes, invented characters —
// which is why the generate-image hint tells you to ask for a picture with no
// text in it. A promo whose whole job is to carry a date, an address and a
// door fee cannot rely on that. The meeting's own theme illustration supplies
// the artwork; these layouts draw the facts over it as real text, from the
// same /meeting-fields the copywriter reads.
//
// Rendering runs in the browser on a plain 2D canvas: the fonts are already
// installed there, nothing has to be packaged, and no server-side converter
// (which Vercel could not run anyway) sits in the path. The composed PNG goes
// to R2 like any uploaded image, so the publishing pipeline is unchanged.

export const POST_KINDS = [
  {
    key: 'promo',
    label: '例會宣傳',
    hint: '邀請人來參加下一場。文案與海報都會帶上日期、地址、入場費。',
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
// Toastmasters International's own colours, so a club poster looks like one.
const NAVY   = '#004165';   // Loyal Blue
const MAROON = '#772432';   // True Maroon
const YELLOW = '#F2DF74';   // Happy Yellow
const GRAY   = '#A9B2B1';   // Cool Gray
const PAPER  = '#FFFDF8';
const PANEL  = '#EEF2F6';

const FONT =
  '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif';

// ---------------------------------------------------------------- formatting
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const parseDate = (raw) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw || '').trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "2026-09-15" -> "Sep 15, 2026" */
export function enDate(raw) {
  const d = parseDate(raw);
  if (!d) return String(raw || '');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "2026-09-15" -> "2026/09/15（週二）" */
export function zhDate(raw) {
  const d = parseDate(raw);
  if (!d) return String(raw || '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}（週${WEEKDAYS[d.getDay()]}）`;
}

const to12h = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return hhmm.trim();
  const h = Number(m[1]);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${m[2]} ${ampm}`;
};

/** "19:10 ~ 21:00" -> "07:10 PM - 09:00 PM" */
export function clockRange(raw) {
  const parts = String(raw || '').split(/[~\-–—]/).filter((s) => s.trim());
  if (parts.length < 2) return String(raw || '');
  return `${to12h(parts[0])} - ${to12h(parts[1])}`;
}

/** "NTD150" / "150" / "免費" -> "入場費用：$150" / "入場費用：免費" */
export function feeText(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const n = /(\d[\d,]*)/.exec(s);
  return n ? `入場費用：$${n[1]}` : `入場費用：${s}`;
}

/**
 * Drop decorative emoji from a meeting theme.
 *
 * Themes are stored as typed, e.g. "🧩 When Differences Click — FUSION 🧩".
 * The emoji read as enthusiasm in an agenda and as clutter set in 60px type,
 * and a canvas renders them in a colour that fights the palette.
 */
export function cleanTheme(raw) {
  return String(raw || '')
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The API's meeting fields, turned into the strings a layout draws. */
export function templateValues(kind, fields = {}) {
  const f = fields || {};
  const [venue, ...rest] = String(f.venue || '').split('\n');
  return {
    kindLabel: kindLabel(kind),
    clubEn:    (f.clubNameEn || '').toUpperCase(),
    clubZh:    f.clubName || '',
    theme:     cleanTheme(f.theme),
    dateEn:    enDate(f.date),
    dateZh:    zhDate(f.date),
    clock:     clockRange(f.time),
    venue,
    venueSub:  [rest.join(' '), f.transit].filter(Boolean).join('　'),
    fee:       feeText(f.fee),
    session:   f.meetingNo ? `第 ${f.meetingNo} 次例會` : '',
  };
}

// ---------------------------------------------------------------- primitives
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const ch of Array.from(para)) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        const space = line.lastIndexOf(' ');
        // Break at a space only when the overflow is inside a Latin run;
        // Chinese has no spaces, so anywhere is a legal break there.
        if (/[A-Za-z0-9]/.test(ch) && space > 0) {
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

/** Draw wrapped text; returns the y just past the last line. */
function text(ctx, str, { x, y, maxW, size, weight = 700, color = NAVY,
                          lh = 1.28, maxLines = 99, align = 'left' }) {
  if (!str) return y;
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  let lines = wrapText(ctx, str, maxW);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, -1)}…`;
  }
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * size * lh));
  return y + lines.length * size * lh;
}

/**
 * Fill the box completely, cropping the overflow rather than letterboxing it.
 *
 * Contain-fitting a square picture into a wide box leaves a column of white on
 * each side, which reads as a small picture in a large hole. Filling the box
 * makes the illustration as wide as the text it sits with.
 *
 * The crop is biased towards the top (`anchorY` below 0.5) because faces sit
 * above the middle of almost any photo or generated scene — a centred crop
 * takes the same amount off the top as the bottom and is the one that beheads
 * people.
 */
// Beyond roughly this, a cropped scene stops reading as a picture and starts
// reading as a banner — and the crop is deep enough to take people's heads off.
// A box wider than this is pulled in rather than filled.
const MAX_ART_RATIO = 1.7;

function artBox(x, y, w, h) {
  const cap = h * MAX_ART_RATIO;
  return w <= cap ? [x, y, w, h] : [x + (w - cap) / 2, y, cap, h];
}

function drawCoverBox(ctx, img, x, y, w, h, anchorY = 0.38) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  return [x + (w - dw) / 2, y - (dh - h) * anchorY, dw, dh];
}

// ---------------------------------------------------------------- icons
// Hand-drawn paths rather than an icon font: nothing to load, and they scale
// with the layout instead of being a fixed-size bitmap.
const icons = {
  calendar(ctx, x, y, s, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = s * 0.075; ctx.lineCap = 'round';
    roundRect(ctx, x, y + s * 0.12, s, s * 0.85, s * 0.12); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + s * 0.26, y); ctx.lineTo(x + s * 0.26, y + s * 0.22);
    ctx.moveTo(x + s * 0.74, y); ctx.lineTo(x + s * 0.74, y + s * 0.22);
    ctx.moveTo(x, y + s * 0.36); ctx.lineTo(x + s, y + s * 0.36);
    ctx.stroke();
    for (let r = 0; r < 2; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        ctx.beginPath();
        ctx.arc(x + s * (0.26 + c * 0.24), y + s * (0.55 + r * 0.22), s * 0.055, 0, 7);
        ctx.fill();
      }
    }
    ctx.restore();
  },
  ticket(ctx, x, y, s, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = s * 0.075; ctx.lineJoin = 'round';
    const h = s * 0.68;
    const top = y + s * 0.16;
    ctx.beginPath();
    ctx.moveTo(x + s * 0.08, top);
    ctx.lineTo(x + s * 0.92, top);
    ctx.lineTo(x + s * 0.92, top + h * 0.3);
    ctx.arc(x + s * 0.92, top + h * 0.5, h * 0.2, -Math.PI / 2, Math.PI / 2, true);
    ctx.lineTo(x + s * 0.92, top + h);
    ctx.lineTo(x + s * 0.08, top + h);
    ctx.lineTo(x + s * 0.08, top + h * 0.7);
    ctx.arc(x + s * 0.08, top + h * 0.5, h * 0.2, Math.PI / 2, -Math.PI / 2, true);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  },
  pin(ctx, x, y, s, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = s * 0.075; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x + s * 0.5, y + s * 0.97);
    ctx.bezierCurveTo(x + s * 0.5, y + s * 0.62, x + s * 0.88, y + s * 0.58,
                      x + s * 0.88, y + s * 0.34);
    ctx.arc(x + s * 0.5, y + s * 0.34, s * 0.38, 0, Math.PI, true);
    ctx.bezierCurveTo(x + s * 0.12, y + s * 0.58, x + s * 0.5, y + s * 0.62,
                      x + s * 0.5, y + s * 0.97);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + s * 0.5, y + s * 0.34, s * 0.14, 0, 7);
    ctx.stroke();
    ctx.restore();
  },
};

/** The brand's colour ribbons, suggested rather than copied. */
function ribbons(ctx, w, h) {
  ctx.save();
  const band = (color, alpha, off, width) => {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(w + off, -h * 0.05);
    ctx.bezierCurveTo(w - h * 0.22 + off, h * 0.30,
                      w + h * 0.10 + off, h * 0.62,
                      w - h * 0.30 + off, h * 1.06);
    ctx.stroke();
  };
  band(YELLOW, 0.95, w * 0.10, w * 0.085);
  band(NAVY,   0.85, w * 0.17, w * 0.055);
  band(MAROON, 0.80, w * 0.23, w * 0.075);
  band(GRAY,   0.45, w * 0.05, w * 0.030);
  ctx.restore();
}

// ---------------------------------------------------------------- layouts
/** The club's badge, drawn to a width and keeping its own proportions. */
function drawLogo(ctx, logo, x, y, width) {
  if (!logo) return 0;
  const hh = width * (logo.height / logo.width);
  ctx.drawImage(logo, x, y, width, hh);
  return hh;
}

function drawPromo(ctx, { w, h, v, art, L, hideTitle, logo }) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  ribbons(ctx, w, h);

  const pad = w * 0.075;
  const maxW = w - pad * 2;

  // Header — badge at the left, English above Chinese beside it, as on the
  // club's own posters. Without a badge the text simply starts at the margin.
  const top = h * L.header;
  const ls = w * 0.125;
  const lh2 = drawLogo(ctx, logo, pad, top - h * 0.012, ls);
  const hx = logo ? pad + ls + w * 0.024 : pad;
  const hw = w - hx - pad;
  let y = logo ? top + (lh2 - h * 0.012 - w * 0.080) / 2 : top;
  y = text(ctx, v.clubEn, { x: hx, y, maxW: hw, size: w * (logo ? 0.035 : 0.040),
                            weight: 800, color: NAVY, maxLines: 2, lh: 1.2 });
  text(ctx, v.clubZh, { x: hx, y: y + h * 0.004, maxW: hw,
                        size: w * (logo ? 0.038 : 0.042),
                        weight: 800, color: NAVY, maxLines: 1 });

  // Drawn unless the caller says the artwork already has a title in it — a
  // slide exported from PowerPoint usually does, a photo or a generated
  // picture usually does not, and only the person choosing it knows which.
  //
  // With no illustration the theme is set larger and sits in the middle of the
  // space the picture would have taken. Leaving that space empty instead reads
  // as a poster that failed to load something, not as one that never had a
  // picture.
  if (!hideTitle) {
    const big = !art;
    const size = w * (big ? 0.090 : 0.066);
    const y = big ? h * (L.theme + (L.artBottom - L.theme) * 0.28) : h * L.theme;
    text(ctx, v.theme, { x: pad, y, maxW, size,
                         weight: 800, color: NAVY, maxLines: 3, lh: 1.18 });
  }

  if (art) {
    const boxY = h * (hideTitle ? L.theme : L.artTop);
    const boxH = h * (L.artBottom - (hideTitle ? L.theme : L.artTop));
    const [bx, by, bw, bh] = artBox(pad, boxY, maxW, boxH);
    const [dx, dy, dw, dh] = drawCoverBox(ctx, art, bx, by, bw, bh);
    ctx.save();
    // Clip to the box, not to the drawn image: the image is deliberately
    // larger than the box now, and the corners belong to the box.
    roundRect(ctx, bx, by, bw, bh, w * 0.028);
    ctx.clip();
    ctx.drawImage(art, dx, dy, dw, dh);
    ctx.restore();
  }

  // Date + time
  const ds = w * 0.058;
  const dy0 = h * L.date;
  icons.calendar(ctx, pad, dy0 + ds * 0.06, ds, MAROON);
  text(ctx, v.dateEn, { x: pad + ds * 1.5, y: dy0, maxW: maxW - ds * 1.5,
                        size: w * 0.046, weight: 800, color: NAVY, maxLines: 1 });
  text(ctx, v.clock, { x: pad + ds * 1.5, y: dy0 + w * 0.056, maxW: maxW - ds * 1.5,
                       size: w * 0.038, weight: 600, color: NAVY, maxLines: 1 });

  // Facts panel
  const py = h * L.panel;
  const ph = h * (L.panelEnd - L.panel);
  ctx.fillStyle = PANEL;
  roundRect(ctx, pad * 0.6, py, w - pad * 1.2, ph, w * 0.026);
  ctx.fill();

  const ix = pad * 0.6 + w * 0.040;
  const tx = ix + w * 0.078;
  const tw = w - tx - pad * 0.7;
  const is = w * 0.050;

  const feeY = py + ph * 0.13;
  icons.ticket(ctx, ix, feeY, is, NAVY);
  text(ctx, v.fee, { x: tx, y: feeY + is * 0.10, maxW: tw, size: w * 0.038,
                     weight: 700, color: NAVY, maxLines: 1 });

  // An address is long and must not spill past the panel it sits in, so it is
  // set smaller than the fee and clamped — two lines for the street, two for
  // whatever transit note follows it.
  const venY = py + ph * 0.45;
  icons.pin(ctx, ix, venY, is, NAVY);
  const vy = text(ctx, v.venue, { x: tx, y: venY, maxW: tw, size: w * 0.028,
                                  weight: 600, color: NAVY, maxLines: 2, lh: 1.34 });
  text(ctx, v.venueSub, { x: tx, y: vy + h * 0.005, maxW: tw, size: w * 0.025,
                          weight: 500, color: '#4a5a68', maxLines: 2, lh: 1.32 });
}

function drawRecap(ctx, { w, h, v, art, L, hideTitle, logo }) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  ribbons(ctx, w, h);

  const pad = w * 0.075;
  const maxW = w - pad * 2;

  // A recap says so, so nobody reads it as an invitation to a meeting that
  // has already happened.
  // The badge sits opposite the "recap" tag rather than beside it: the tag is
  // the thing that must be read first here.
  const ls = w * 0.115;
  drawLogo(ctx, logo, w - pad - ls, h * (L.header - 0.018), ls);

  ctx.fillStyle = MAROON;
  const tagW = w * 0.30;
  roundRect(ctx, pad, h * (L.header - 0.012), tagW, w * 0.062, w * 0.031);
  ctx.fill();
  text(ctx, '例會回顧', { x: pad + tagW / 2, y: h * (L.header - 0.012) + w * 0.014,
                          maxW: tagW, size: w * 0.034, weight: 800,
                          color: '#fff', align: 'center', maxLines: 1 });

  let y = h * (L.header + 0.055);
  y = text(ctx, v.clubZh, { x: pad, y, maxW, size: w * 0.040, weight: 800,
                            color: NAVY, maxLines: 1 });
  text(ctx, [v.session, v.dateZh].filter(Boolean).join('　·　'),
       { x: pad, y: y + h * 0.006, maxW, size: w * 0.030, weight: 600,
         color: '#456', maxLines: 1 });

  if (!hideTitle) {
    const big = !art;
    const size = w * (big ? 0.086 : 0.062);
    const y = big ? h * (L.theme + (L.artBottom - L.theme) * 0.25) : h * L.theme;
    text(ctx, v.theme, { x: pad, y, maxW, size,
                         weight: 800, color: NAVY, maxLines: 3, lh: 1.18 });
  }

  if (art) {
    const boxY = h * (hideTitle ? L.theme : L.artTop);
    const boxH = h * (L.artBottom - (hideTitle ? L.theme : L.artTop));
    const [bx, by, bw, bh] = artBox(pad, boxY, maxW, boxH);
    const [dx, dy, dw, dh] = drawCoverBox(ctx, art, bx, by, bw, bh);
    ctx.save();
    // Clip to the box, not to the drawn image: the image is deliberately
    // larger than the box now, and the corners belong to the box.
    roundRect(ctx, bx, by, bw, bh, w * 0.028);
    ctx.clip();
    ctx.drawImage(art, dx, dy, dw, dh);
    ctx.restore();
  }
}

export const TEMPLATES = [
  { key: 'promo-portrait', kind: 'promo', label: '宣傳・直式 4:5',
    w: 1080, h: 1350, draw: drawPromo,
    L: { header: 0.055, theme: 0.160, artTop: 0.275, artBottom: 0.655,
         date: 0.690, panel: 0.790, panelEnd: 0.968 } },
  { key: 'promo-square', kind: 'promo', label: '宣傳・方形 1:1',
    w: 1080, h: 1080, draw: drawPromo,
    L: { header: 0.050, theme: 0.170, artTop: 0.285, artBottom: 0.640,
         date: 0.668, panel: 0.780, panelEnd: 0.968 } },
  { key: 'recap-portrait', kind: 'recap', label: '回顧・直式 4:5',
    w: 1080, h: 1350, draw: drawRecap,
    L: { header: 0.060, theme: 0.225, artTop: 0.365, artBottom: 0.905 } },
];

export const templatesFor = (kind) => TEMPLATES.filter((t) => t.kind === kind);

/**
 * Draw one layout onto `canvas`. Preview and export call this same function,
 * so what you approve on screen is what gets uploaded.
 */
export function drawTemplate(canvas, { template, values, background, hideTitle, logo }) {
  canvas.width = template.w;
  canvas.height = template.h;
  const ctx = canvas.getContext('2d');
  template.draw(ctx, {
    w: template.w, h: template.h, v: values, art: background || null,
    L: template.L, hideTitle: !!hideTitle, logo: logo || null,
  });
  return canvas;
}

/** Where the Toastmasters badge lives — same origin, so no proxy is needed. */
export const LOGO_URL = withBase('/media/toastmasters_logo.png');

/** The composed image, as a PNG blob ready for the usual R2 upload. */
export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('無法輸出圖片'))),
      'image/png',
    );
  });
}
