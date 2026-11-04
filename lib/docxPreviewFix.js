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
//  - Floating pictures with no text wrap (wp:anchor + wrapNone, e.g. logos
//    beside a centered title): docx-preview drops what the offset is measured
//    from and leaves the picture inline, so it pushes the text down and one
//    placed from the page edge lands off the page. parseForPreview keeps the
//    reference (as classes) and matchWordLayout places the picture on its page.
//
// Kept free of imports; call after the rendered pages are in the document
// (the row fix reads computed styles).
// ----------------------------------------------------------------

const ANCHOR = 'wp-anchor';

/** docx-preview's parseAsync, keeping where floating pictures are measured from. */
export async function parseForPreview(parseAsync, data, options) {
  const doc = await parseAsync(data, options);
  // The parser class isn't exported: patch it from the first document and parse again.
  return patchDrawingParser(Object.getPrototypeOf(doc._parser)) ? parseAsync(data, options) : doc;
}

function patchDrawingParser(proto) {
  const original = proto.parseDrawingWrapper;
  if (!original || original.keepsAnchor) return false;
  proto.parseDrawingWrapper = function (node) {
    const result = original.call(this, node);
    const kids = [...node.children];
    if (node.localName !== 'anchor' || !kids.some((n) => n.localName === 'wrapNone')) return result;
    const classes = [ANCHOR];
    for (const n of kids) {
      if (n.localName !== 'positionH' && n.localName !== 'positionV') continue;
      const axis = n.localName === 'positionH' ? 'h' : 'v';
      classes.push(`wp-${axis}-${n.getAttribute('relativeFrom') || 'page'}`);
      const align = [...n.children].find((c) => c.localName === 'align');
      if (align) classes.push(`wp-${axis}a-${align.textContent.trim()}`);
    }
    if (/^(1|true|on)$/.test(node.getAttribute('behindDoc') || '')) classes.push('wp-behind');
    result.className = classes.join(' ');
    return result;
  };
  proto.parseDrawingWrapper.keepsAnchor = true;
  return true;
}

const toPx = (v) => (parseFloat(v) || 0) * (/pt$/.test(v) ? 4 / 3 : 1);

function placeAnchors(root) {
  const anchors = [...root.querySelectorAll(`section div.${ANCHOR}`)].map((el) => {
    const offset = { x: toPx(el.style.left), y: toPx(el.style.top) };
    // Out of the text flow first, as in Word; the static position stays where the picture sat.
    Object.assign(el.style, { position: 'absolute', left: '', top: '', width: '', height: '' });
    return { el, offset };
  });
  const placed = anchors.map(({ el, offset }) => {
    const section = el.closest('section');
    const box = section.getBoundingClientRect();
    const scale = box.width / section.offsetWidth || 1;
    const rel = (r) => ({ x: (r.left - box.left) / scale, y: (r.top - box.top) / scale });
    const cs = getComputedStyle(section);
    const W = section.offsetWidth, H = section.offsetHeight;
    const pad = { l: parseFloat(cs.paddingLeft), r: parseFloat(cs.paddingRight), t: parseFloat(cs.paddingTop), b: parseFloat(cs.paddingBottom) };
    const here = rel(el.getBoundingClientRect());
    const para = el.closest('p');
    const pic = el.firstElementChild;
    const size = { w: pic ? pic.offsetWidth : 0, h: pic ? pic.offsetHeight : 0 };
    const cls = (prefix) => [...el.classList].find((c) => c.startsWith(prefix))?.slice(prefix.length);

    // [start, length] of what the offset is measured from, per axis.
    const hRef = { page: [0, W], leftMargin: [0, pad.l], rightMargin: [W - pad.r, pad.r], character: [here.x, 0] }[cls('wp-h-')] || [pad.l, W - pad.l - pad.r];
    const paraY = para ? rel(para.getBoundingClientRect()).y : here.y;
    const vRef = {
      page: [0, H], topMargin: [0, pad.t], bottomMargin: [H - pad.b, pad.b],
      margin: [pad.t, H - pad.t - pad.b], paragraph: [paraY, 0], line: [here.y, 0],
    }[cls('wp-v-')] || [paraY, 0];
    const at = ([start, len], align, offset, picLen) => {
      if (align === 'center') return start + (len - picLen) / 2;
      if (align === 'right' || align === 'bottom' || align === 'outside') return start + len - picLen;
      if (align) return start;
      return start + offset;
    };
    return { el, section, x: at(hRef, cls('wp-ha-'), offset.x, size.w), y: at(vRef, cls('wp-va-'), offset.y, size.h) };
  });
  for (const { el, section, x, y } of placed) {
    // The article (text) is z-index 1: in front of a behind-text picture, behind the others.
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, display: 'block', zIndex: el.classList.contains('wp-behind') ? '0' : '2' });
    section.appendChild(el);
  }
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

  placeAnchors(root);
}
