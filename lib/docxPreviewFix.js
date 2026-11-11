// ----------------------------------------------------------------
// Bring docx-preview's HTML closer to how Word lays the same file out, for
// the agenda page's live Word preview. Each fix is a measured difference
// (Word's PDF vs the HTML, same .docx):
//
//  - Row height: Word's w:trHeight leaves out the cells' top/bottom margins
//    and the border, and adds them on top; a CSS row height includes them.
//    Without this every row comes out ~2.7pt short and a page-filling table
//    stops well above the bottom (a 25-row agenda: 60pt short; with it, 2pt).
//  - A paragraph ending in a line break: Word gives the empty last line its
//    height, HTML drops a trailing <br>.
//  - The default paragraph style's run font: docx-preview writes it only for
//    the paragraph (`.docx p, p.docx_X span`), so its spans fall back to the
//    theme font (often Cambria) instead of e.g. Arial.
//  - Floating objects (wp:anchor, or a VML shape with position:absolute):
//    docx-preview drops what the offset is measured from and the text wrap,
//    and leaves the object inline, so it pushes the text down and one placed
//    from the page edge lands off the page (e.g. logos beside a centered
//    title). It also draws no DrawingML text box, shape or group, and turns
//    the VML fallback of a text box into an SVG. parseForPreview keeps the
//    reference and wrap (as classes) and parses text boxes, shapes and groups;
//    matchWordLayout then places each object: no wrap on its page, square /
//    tight / through as a float beside the text, top and bottom as a band the
//    text skips. A float has text on one side only, so a picture in the middle
//    of a paragraph (Word: text on both sides) gets it on the wider side.
//  - Latin vs East Asian fonts: Word picks a font per character — w:ascii /
//    w:hAnsi for Latin, w:eastAsia for CJK — and a run that names only an
//    East Asian font (e.g. eastAsia="標楷體", common in templates typed on a
//    Chinese system) keeps its inherited Latin font. docx-preview writes one
//    CSS font list per run, so such a run drew its English names in 標楷體's
//    Latin glyphs. parseForPreview marks those runs (EA_ONLY); matchWordLayout
//    puts the inherited Latin font in front, so the browser's per-glyph
//    fallback gives Latin text that font and CJK text the East Asian one.
//
// Kept free of imports; call after the rendered pages are in the document
// (the row fix reads computed styles).
// ----------------------------------------------------------------

const ANCHOR = 'wp-anchor';
// First family of a run that names only an East Asian font; never installed, so harmless if left.
const EA_ONLY = 'docx-ea-only';
const NS_WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const NS_WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';

/** docx-preview's parseAsync, keeping floating objects' position and parsing shapes. */
export async function parseForPreview(parseAsync, data, options) {
  const doc = await parseAsync(data, options);
  // The parser class isn't exported: patch it from the first document and parse again.
  return patchParser(Object.getPrototypeOf(doc._parser)) ? parseAsync(data, options) : doc;
}

// ---- XML helpers (the parser's own helper isn't exported either) ----

const kids = (n) => (n ? [...n.children] : []);
const child = (n, name) => kids(n).find((c) => c.localName === name);
const path = (n, ...names) => names.reduce((x, name) => child(x, name), n);
const attr = (n, name) => (n ? [...n.attributes].find((a) => a.localName === name)?.value : undefined);
const emuPt = (v) => (parseInt(v, 10) || 0) / 12700;
const pt = (n) => `${+n.toFixed(2)}pt`;
const xfrmPt = (xfrm, off = 'off', ext = 'ext') => {
  const o = child(xfrm, off), e = child(xfrm, ext);
  return { x: emuPt(attr(o, 'x')), y: emuPt(attr(o, 'y')), w: emuPt(attr(e, 'cx')), h: emuPt(attr(e, 'cy')) };
};

// Theme colours come from docx-preview's --docx-*-color variables; fallbacks are Office's defaults.
const SCHEME = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
const SCHEME_DEFAULT = { lt1: '#ffffff', dk1: '#000000', lt2: '#e7e6e6', dk2: '#44546a', accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5', accent4: '#ffc000', accent5: '#5b9bd5', accent6: '#70ad47' };
function colorOf(n) {
  const c = kids(n).find((k) => /Clr$/.test(k.localName));
  if (!c) return null;
  if (c.localName === 'srgbClr') return `#${attr(c, 'val')}`;
  if (c.localName === 'sysClr') return `#${attr(c, 'lastClr') || '000000'}`;
  if (c.localName === 'schemeClr') {
    const key = SCHEME[attr(c, 'val')] || attr(c, 'val');
    return `var(--docx-${key}-color, ${SCHEME_DEFAULT[key] || '#000000'})`;
  }
  return null;
}
/** 'none', a colour, or null when the element doesn't say. */
function fillOf(n) {
  if (child(n, 'noFill')) return 'none';
  const solid = child(n, 'solidFill');
  return solid ? colorOf(solid) : null;
}
function styleRef(style, name) {
  const ref = child(style, name);
  return ref && attr(ref, 'idx') !== '0' ? colorOf(ref) : null;
}

// ---- Parsed nodes: docx-preview renders type 'drawing' as a div with cssStyle, class and children ----

function boxStyle({ w, h, fill, line, lineWidth, inset, align, geom }) {
  return {
    width: pt(w), height: pt(h), 'box-sizing': 'border-box',
    background: fill && fill !== 'none' ? fill : 'transparent',
    border: line && line !== 'none' ? `${pt(lineWidth)} solid ${line}` : 'none',
    padding: inset.map(pt).join(' '),
    'justify-content': { ctr: 'center', center: 'center', middle: 'center', b: 'flex-end', bottom: 'flex-end' }[align] || 'flex-start',
    'border-radius': { ellipse: '50%', oval: '50%', roundRect: '12%', roundrect: '12%' }[geom] || '0',
  };
}

function shapeNode(parser, wsp, w, h) {
  const spPr = child(wsp, 'spPr'), style = child(wsp, 'style'), body = child(wsp, 'bodyPr');
  const ln = child(spPr, 'ln');
  const inset = (name, d) => (attr(body, name) != null ? emuPt(attr(body, name)) : d);
  const content = path(wsp, 'txbx', 'txbxContent');
  return {
    type: 'drawing', className: 'wp-shape', children: content ? parser.parseBodyElements(content) : [],
    cssStyle: boxStyle({
      w, h,
      fill: fillOf(spPr) ?? styleRef(style, 'fillRef'),
      line: (ln && fillOf(ln)) ?? styleRef(style, 'lnRef'),
      lineWidth: attr(ln, 'w') ? emuPt(attr(ln, 'w')) : 0.75,
      inset: [inset('tIns', 3.6), inset('rIns', 7.2), inset('bIns', 3.6), inset('lIns', 7.2)],
      align: attr(body, 'anchor'),
      geom: attr(child(spPr, 'prstGeom'), 'prst'),
    }),
  };
}

/** A group drawn w × h pt; its children are placed in its own child coordinates. */
function groupNode(parser, wgp, w, h) {
  const box = xfrmPt(path(wgp, 'grpSpPr', 'xfrm'), 'chOff', 'chExt');
  const sx = box.w ? w / box.w : 1, sy = box.h ? h / box.h : 1;
  const children = [];
  for (const k of kids(wgp)) {
    const xfrm = k.localName === 'grpSp' || k.localName === 'wgp' ? path(k, 'grpSpPr', 'xfrm') : path(k, 'spPr', 'xfrm');
    if (!xfrm) continue;
    const r = xfrmPt(xfrm);
    const cw = r.w * sx, ch = r.h * sy;
    let node;
    if (k.localName === 'wsp') node = shapeNode(parser, k, cw, ch);
    else if (k.localName === 'pic') node = parser.parsePicture(k);
    else if (k.localName === 'grpSp' || k.localName === 'wgp') node = groupNode(parser, k, cw, ch);
    if (!node) continue;
    node.className = `${node.className || ''} wp-gchild`.trim();
    Object.assign(node.cssStyle, { left: pt((r.x - box.x) * sx), top: pt((r.y - box.y) * sy), width: pt(cw), height: pt(ch) });
    children.push(node);
  }
  return { type: 'drawing', className: 'wp-group', cssStyle: { width: pt(w), height: pt(h) }, children };
}

function anchorClasses({ wrap, hRel, hAlign, vRel, vAlign, behind, inCell }) {
  return [ANCHOR, `wp-wrap-${wrap}`, `wp-h-${hRel}`, hAlign && `wp-ha-${hAlign}`, `wp-v-${vRel}`,
    vAlign && `wp-va-${vAlign}`, behind && 'wp-behind', inCell && 'wp-incell'].filter(Boolean).join(' ');
}

const WRAP = { wrapNone: 'none', wrapSquare: 'square', wrapTight: 'square', wrapThrough: 'square', wrapTopAndBottom: 'tb' };

function anchorNode(node, result) {
  const simple = /^(1|true)$/.test(attr(node, 'simplePos') || '');
  const axis = (name) => {
    const n = child(node, name);
    const align = child(n, 'align')?.textContent.trim();
    return { rel: simple ? 'page' : attr(n, 'relativeFrom') || 'page', align: simple ? null : align, offset: emuPt(child(n, 'posOffset')?.textContent) };
  };
  const H = axis('positionH'), V = axis('positionV');
  if (simple) {
    const sp = child(node, 'simplePos');
    H.offset = emuPt(attr(sp, 'x'));
    V.offset = emuPt(attr(sp, 'y'));
  }
  const ext = child(node, 'extent');
  const wrapEl = kids(node).find((k) => WRAP[k.localName]);
  const dist = (side) => emuPt(attr(node, `dist${side}`));
  result.className = anchorClasses({
    wrap: wrapEl ? WRAP[wrapEl.localName] : 'none', hRel: H.rel, hAlign: H.align, vRel: V.rel, vAlign: V.align,
    behind: /^(1|true|on)$/.test(attr(node, 'behindDoc') || ''), inCell: !/^(0|false|off)$/.test(attr(node, 'layoutInCell') || ''),
  });
  result.cssStyle = {
    width: pt(emuPt(attr(ext, 'cx'))), height: pt(emuPt(attr(ext, 'cy'))), left: pt(H.offset), top: pt(V.offset),
    margin: [dist('T'), dist('R'), dist('B'), dist('L')].map(pt).join(' '),
  };
  return result;
}

// VML: a style string ("position:absolute;margin-left:93.6pt;mso-position-horizontal-relative:page;…").
const VML_UNIT = { pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, px: 0.75, emu: 1 / 12700 };
function vmlPt(v) {
  const m = /^(-?[\d.]+)\s*([a-z]*)$/i.exec((v || '').trim());
  return m ? parseFloat(m[1]) * (VML_UNIT[m[2].toLowerCase()] ?? 0.75) : 0;
}
const VML_HREL = { page: 'page', margin: 'margin', text: 'column', char: 'character', 'left-margin-area': 'leftMargin', 'right-margin-area': 'rightMargin', 'inner-margin-area': 'leftMargin', 'outer-margin-area': 'rightMargin' };
const VML_VREL = { page: 'page', margin: 'margin', text: 'paragraph', line: 'line', 'top-margin-area': 'topMargin', 'bottom-margin-area': 'bottomMargin', 'inner-margin-area': 'topMargin', 'outer-margin-area': 'bottomMargin' };
const VML_WRAP = { none: 'none', square: 'square', tight: 'square', through: 'square', topAndBottom: 'tb' };
const vmlColor = (v) => (v || '').trim().split(/\s+/)[0] || null;
const vmlOff = (v) => /^(f|false)$/i.test(v || '');

/** The shape's attribute, else its v:shapetype's (type="#_x0000_t75" → <v:shapetype id="_x0000_t75" …>). */
function vmlAttr(shape, name) {
  const own = attr(shape, name);
  if (own != null) return own;
  const type = (attr(shape, 'type') || '').replace(/^#/, '');
  if (!type) return undefined;
  for (const t of shape.ownerDocument.getElementsByTagNameNS('*', 'shapetype')) {
    if (attr(t, 'id') === type) return attr(t, name);
  }
  return undefined;
}

/** A VML text box or picture as a drawing node; anything else stays docx-preview's SVG. */
function vmlNode(parser, pict) {
  const shape = kids(pict).find((n) => ['shape', 'rect', 'roundrect', 'oval'].includes(n.localName) && (child(n, 'textbox') || child(n, 'imagedata')));
  if (!shape) return null;
  // VML draws a white fill and a black line unless the shape (or its type) says not to.
  const look = {
    fill: vmlOff(vmlAttr(shape, 'filled')) ? 'none' : vmlColor(vmlAttr(shape, 'fillcolor')) || '#ffffff',
    line: vmlOff(vmlAttr(shape, 'stroked')) ? 'none' : vmlColor(vmlAttr(shape, 'strokecolor')) || '#000000',
    lineWidth: vmlAttr(shape, 'strokeweight') ? vmlPt(vmlAttr(shape, 'strokeweight')) : 0.75,
    geom: shape.localName,
  };
  const css = {};
  for (const decl of (attr(shape, 'style') || '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) css[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  const w = vmlPt(css.width), h = vmlPt(css.height);
  const textbox = child(shape, 'textbox');
  let inner;
  if (textbox) {
    const inset = (attr(textbox, 'inset') || '').split(',');
    const [l, t, r, b] = [7.2, 3.6, 7.2, 3.6].map((d, i) => (inset[i] && inset[i].trim() ? vmlPt(inset[i]) : d));
    inner = {
      type: 'drawing', className: 'wp-shape', children: parser.parseBodyElements(child(textbox, 'txbxContent')),
      cssStyle: boxStyle({ w, h, ...look, inset: [t, r, b, l], align: css['v-text-anchor'] }),
    };
  } else {
    const image = { type: 'image', src: attr(child(shape, 'imagedata'), 'id'), cssStyle: { width: '100%', height: '100%', display: 'block' } };
    inner = { type: 'drawing', className: 'wp-pic', cssStyle: boxStyle({ w, h, ...look, inset: [0, 0, 0, 0] }), children: [image] };
  }
  if (css.position !== 'absolute') return inner;
  const align = (v) => (v && v !== 'absolute' ? v : null);
  const wrap = path(shape, 'wrap');
  const dist = (side, d) => (css[`mso-wrap-distance-${side}`] ? vmlPt(css[`mso-wrap-distance-${side}`]) : d);
  return {
    type: 'drawing', children: [inner],
    className: anchorClasses({
      wrap: VML_WRAP[attr(wrap, 'type')] || 'none',
      hRel: VML_HREL[css['mso-position-horizontal-relative']] || 'column', hAlign: align(css['mso-position-horizontal']),
      vRel: VML_VREL[css['mso-position-vertical-relative']] || 'paragraph', vAlign: align(css['mso-position-vertical']),
      behind: parseInt(css['z-index'], 10) < 0, inCell: !vmlOff(attr(shape, 'allowincell')),
    }),
    cssStyle: {
      width: pt(w), height: pt(h), left: pt(vmlPt(css['margin-left']) + vmlPt(css.left)), top: pt(vmlPt(css['margin-top']) + vmlPt(css.top)),
      margin: [dist('top', 0), dist('right', 9), dist('bottom', 0), dist('left', 9)].map(pt).join(' '),
    },
  };
}

function patchParser(proto) {
  if (!proto.parseDrawingWrapper || proto.keepsFloats) return false;
  proto.keepsFloats = true;
  const { checkAlternateContent, parseDrawingWrapper, parseVmlPicture, parseFont } = proto;

  // Word: Latin text uses ascii / hAnsi, CJK text eastAsia. docx-preview reads
  // ascii, asciiTheme and eastAsia into one list and ignores hAnsi.
  proto.parseFont = function (node, style) {
    const theme = (name) => (attr(node, name) ? `var(--docx-${attr(node, name)}-font)` : null);
    const latin = attr(node, 'ascii') || theme('asciiTheme') || attr(node, 'hAnsi') || theme('hAnsiTheme');
    const eastAsia = attr(node, 'eastAsia');
    if (!latin && !eastAsia) return parseFont.call(this, node, style);
    // Only an East Asian font: the Latin one is inherited, so EA_ONLY holds its
    // place until fixEastAsiaOnlyFonts fills it in after layout.
    const fonts = [latin ? (latin.startsWith('var(') ? latin : quoteFamily(latin)) : EA_ONLY];
    if (eastAsia && eastAsia !== latin) fonts.push(quoteFamily(eastAsia));
    style['font-family'] = fonts.join(', ');
  };

  // Take the DrawingML text box / group over its VML fallback.
  proto.checkAlternateContent = function (elem) {
    const choice = elem.localName === 'AlternateContent' && child(elem, 'Choice');
    const requires = (attr(choice, 'Requires') || '').split(/\s+/).filter(Boolean);
    if (choice?.firstElementChild && requires.length && requires.every((p) => [NS_WPS, NS_WPG].includes(elem.lookupNamespaceURI(p)))) {
      return choice.firstElementChild;
    }
    return checkAlternateContent.call(this, elem);
  };
  proto.parseDrawingWrapper = function (node) {
    const result = parseDrawingWrapper.call(this, node);
    // docx-preview reads pictures only; a text box, shape or group is sized by the drawing's extent.
    const ext = child(node, 'extent');
    const w = emuPt(attr(ext, 'cx')), h = emuPt(attr(ext, 'cy'));
    const shape = kids(path(node, 'graphic', 'graphicData')).find((n) => n.localName === 'wsp' || n.localName === 'wgp');
    if (shape) {
      result.children = [shape.localName === 'wsp' ? shapeNode(this, shape, w, h) : groupNode(this, shape, w, h)];
      if (node.localName === 'inline') result.className = 'wp-inline';
    }
    return node.localName === 'anchor' ? anchorNode(node, result) : result;
  };
  proto.parseVmlPicture = function (elem) {
    return vmlNode(this, elem) || parseVmlPicture.call(this, elem);
  };
  return true;
}

const quoteFamily = (f) => `'${f.replace(/['\\]/g, '')}'`;
const firstFamily = (list) => (list.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');

/**
 * Give each EA_ONLY run its inherited Latin font in front of its East Asian one:
 * the first family (Word's ascii) of the nearest ancestor that sets its own.
 * Document order, so a fixed paragraph is what its runs then inherit.
 */
function fixEastAsiaOnlyFonts(root) {
  for (const el of root.querySelectorAll('p, span')) {
    const own = getComputedStyle(el).fontFamily;
    if (firstFamily(own) !== EA_ONLY) continue;
    let up = el.parentElement;
    while (up && up !== root.parentElement && firstFamily(getComputedStyle(up).fontFamily) === EA_ONLY) up = up.parentElement;
    const latin = up ? firstFamily(getComputedStyle(up).fontFamily) : '';
    const rest = own.split(',').slice(1).join(',').trim();
    el.style.fontFamily = latin && latin !== EA_ONLY ? `${quoteFamily(latin)}, ${rest}` : rest;
  }
}

// ---- Placing floating objects after layout ----

const FLOAT_CSS = `
.wp-shape { display: flex !important; flex-direction: column; overflow: hidden; }
.wp-shape > p { flex: none; }
.wp-gchild { position: absolute !important; }
.wp-group { display: inline-block; }
.wp-inline { overflow: hidden; } /* sits on the baseline by its bottom edge, like a picture */
`;

const toPx = (v) => (parseFloat(v) || 0) * (/pt$/.test(v) ? 4 / 3 : 1);
const cls = (el, prefix) => [...el.classList].find((c) => c.startsWith(prefix))?.slice(prefix.length);

function placeAnchors(root) {
  const style = document.createElement('style');
  style.textContent = FLOAT_CSS;
  root.prepend(style);

  // All out of the text flow first (Word lays the text out without them); the
  // static position stays where the object sat.
  const anchors = [...root.querySelectorAll(`section div.${ANCHOR}`)].map((el) => {
    const s = el.style;
    const a = {
      el, offset: { x: toPx(s.left), y: toPx(s.top) },
      dist: { t: toPx(s.marginTop), r: toPx(s.marginRight), b: toPx(s.marginBottom), l: toPx(s.marginLeft) },
    };
    Object.assign(s, { position: 'absolute', left: '', top: '', margin: '0' });
    return a;
  });
  // One at a time: a float moves the text after it, so measure after the ones before it.
  for (const a of anchors) placeAnchor(a);
}

function placeAnchor({ el, offset, dist }) {
  const section = el.closest('section');
  const box = section.getBoundingClientRect();
  const scale = box.width / section.offsetWidth || 1;
  const rel = (node) => {
    const r = node.getBoundingClientRect();
    return { x: (r.left - box.left) / scale, y: (r.top - box.top) / scale, w: r.width / scale, h: r.height / scale };
  };
  // The frame offsets are measured in: the page and its margins, or — for an
  // object laid out in its table cell — the cell and its text area, for every
  // reference (LibreOffice, as 精確預覽 / PDF lay it out: "page" too).
  const cell = el.classList.contains('wp-incell') ? el.closest('td') : null;
  const frameEl = cell || section;
  const fcs = getComputedStyle(frameEl);
  const inset = (side) => parseFloat(fcs[`padding${side}`]) + (cell ? parseFloat(fcs[`border${side}Width`]) : 0);
  const pad = { l: inset('Left'), r: inset('Right'), t: inset('Top'), b: inset('Bottom') };
  const f = cell ? rel(cell) : { x: 0, y: 0, w: section.offsetWidth, h: section.offsetHeight };
  const here = rel(el);
  const para = el.parentElement?.closest('p');
  const paraBox = para ? rel(para) : { x: f.x + pad.l, y: here.y, w: f.w - pad.l - pad.r, h: 0 };
  const w = el.offsetWidth, h = el.offsetHeight;

  // [start, length] of what the offset is measured from, per axis.
  const margin = [f.x + pad.l, f.w - pad.l - pad.r];
  const hRef = {
    page: [f.x, f.w], leftMargin: [f.x, pad.l], rightMargin: [f.x + f.w - pad.r, pad.r],
    insideMargin: [f.x, pad.l], outsideMargin: [f.x + f.w - pad.r, pad.r], character: [here.x, 0],
  }[cls(el, 'wp-h-')] || margin;
  const vRef = {
    page: [f.y, f.h], margin: [f.y + pad.t, f.h - pad.t - pad.b], topMargin: [f.y, pad.t], bottomMargin: [f.y + f.h - pad.b, pad.b],
    insideMargin: [f.y, pad.t], outsideMargin: [f.y + f.h - pad.b, pad.b], line: [here.y, 0],
  }[cls(el, 'wp-v-')] || [paraBox.y, 0];
  const at = ([start, len], align, off, size) => {
    if (align === 'center') return start + (len - size) / 2;
    if (align === 'right' || align === 'bottom' || align === 'outside') return start + len - size;
    if (align) return start;
    return start + off;
  };
  const x = at(hRef, cls(el, 'wp-ha-'), offset.x, w);
  const y = at(vRef, cls(el, 'wp-va-'), offset.y, h);
  const wrap = cls(el, 'wp-wrap-');

  if (wrap === 'none' || !para) {
    // The article (text) is z-index 1: in front of a behind-text object, behind the others.
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, zIndex: el.classList.contains('wp-behind') ? '0' : '2' });
    section.appendChild(el);
    return;
  }

  // A float at the top of its paragraph. A zero-width spacer float holds it
  // down to its offset, so the lines above it still run full width.
  const dy = y - paraBox.y;
  const side = wrap === 'tb' || x + w / 2 <= paraBox.x + paraBox.w / 2 ? 'left' : 'right';
  const spacer = document.createElement('span');
  Object.assign(spacer.style, { float: side, width: '0', height: `${Math.max(0, dy - dist.t)}px` });
  Object.assign(el.style, {
    position: 'relative', float: side, clear: side, display: 'block',
    marginTop: dy < 0 ? `${dy}px` : `${Math.min(dy, dist.t)}px`, marginBottom: `${dist.b}px`,
  });
  if (wrap === 'tb') {
    // A full-width band: no text beside it.
    Object.assign(el.style, { width: `${paraBox.w}px`, boxSizing: 'border-box', paddingLeft: `${Math.max(0, x - paraBox.x)}px`, marginLeft: `${Math.min(0, x - paraBox.x)}px` });
  } else if (side === 'left') {
    Object.assign(el.style, { marginLeft: `${x - paraBox.x}px`, marginRight: `${dist.r}px` });
  } else {
    Object.assign(el.style, { marginRight: `${paraBox.x + paraBox.w - x - w}px`, marginLeft: `${dist.l}px` });
  }
  para.prepend(spacer, el);
}

export function matchWordLayout(root) {
  for (const style of root.querySelectorAll('style')) {
    const css = style.textContent.replace(/\.docx p, p\.(docx_[\w-]+) span \{/g, '.docx p, .docx p span, p.$1 span {');
    if (css !== style.textContent) style.textContent = css;
  }

  for (const tr of root.querySelectorAll('tr')) {
    if (!tr.style.height) continue;
    let extra = 0;
    for (const td of tr.cells) {
      const cs = getComputedStyle(td);
      // Collapsed borders: the row already holds half of its border.
      extra = Math.max(extra, parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) / 2);
    }
    if (extra > 0) tr.style.height = `calc(${tr.style.height} + ${extra}px)`;
  }

  for (const br of root.querySelectorAll('p br')) {
    const p = br.closest('p');
    const rest = document.createRange();
    rest.setStartAfter(br);
    rest.setEndAfter(p.lastChild);
    const after = rest.cloneContents();
    if (!after.textContent.trim() && !after.querySelector('br, img, svg')) br.after('​');
  }

  fixEastAsiaOnlyFonts(root);
  placeAnchors(root);
}
