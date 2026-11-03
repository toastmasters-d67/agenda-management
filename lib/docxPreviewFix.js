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
//
// Kept free of imports; call after the rendered pages are in the document
// (the row fix reads computed styles).
// ----------------------------------------------------------------

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
}
