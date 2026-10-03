'use client';

/**
 * Reusable member autocomplete for any `<input class="member-ac">`.
 * Ported from the legacy member-ac.js (shared by index.html/app.js and
 * roles.html/roles.js) — same public API, just converted from an IIFE
 * global to an ES module, and init() now returns a cleanup function so
 * React components can remove the document-level listeners on unmount.
 *
 * Free typing is always allowed — the dropdown only *suggests* roster entries,
 * it never constrains the value. That matters for role planning, where a slot
 * may go to a guest, a visiting member, or a placeholder like "TBD".
 *
 * Requires a `<div id="memberDropdown" class="member-dropdown">` in the page
 * and the matching `.member-dropdown` / `.member-dd-item` styles.
 *
 * Usage:
 *   MemberAC.setRoster(users);   // [{ nameZh, nameEn, level }]
 *   const cleanup = MemberAC.init();   // once, after DOM is ready
 *   // ...later, on unmount: cleanup();
 *
 * Per-input option (data attribute):
 *   data-ac-lang="zh" | "en"   which name to insert when picking (default 'en')
 */
let roster = [];
let activeInput = null;
let highlight = -1;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const ddEl = () => document.getElementById('memberDropdown');

/** Which of the two names to show/insert for the input currently in focus. */
function acLang(input) {
  return (input && input.dataset.acLang) === 'zh' ? 'zh' : 'en';
}

/** Canonical "Name, LEVEL" string written into the agenda field. */
function formatMember(m, lang) {
  const name = (lang === 'zh' ? m.nameZh : m.nameEn) || m.nameEn || m.nameZh || '';
  return m.level ? `${name}, ${m.level}` : name;
}

function filtered() {
  const q = (activeInput?.value || '').trim().toLowerCase();
  if (!q) return roster;
  return roster.filter((m) => {
    const zh = m.level ? `${m.nameZh}, ${m.level}` : m.nameZh;
    const en = m.level ? `${m.nameEn}, ${m.level}` : m.nameEn;
    return [m.nameZh, m.nameEn, m.level, zh, en]
      .some((v) => (v || '').toLowerCase().includes(q));
  });
}

function render() {
  const dd = ddEl();
  if (!dd || !activeInput) return;
  const items = filtered();
  if (!items.length) { dd.style.display = 'none'; return; }

  const lang = acLang(activeInput);
  dd.innerHTML = items.map((m, i) => {
    const primary = (lang === 'zh' ? m.nameZh : m.nameEn) || m.nameEn || m.nameZh || '';
    const alt = (lang === 'zh' ? m.nameEn : m.nameZh) || '';
    return `<div class="member-dd-item${i === highlight ? ' ac-active' : ''}" data-idx="${i}">
        <span class="mdi-name">${esc(primary)}</span>
        ${alt ? `<span class="mdi-alt">${esc(alt)}</span>` : ''}
        ${m.level ? `<span class="mdi-level">${esc(m.level)}</span>` : ''}
      </div>`;
  }).join('');

  const rect = activeInput.getBoundingClientRect();
  dd.style.display = 'block';
  dd.style.left = rect.left + 'px';
  dd.style.minWidth = rect.width + 'px';

  // Open upward when there is not enough room below.
  const ddHeight = Math.min(dd.scrollHeight, 240);
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  if (spaceBelow >= ddHeight || spaceBelow >= spaceAbove) {
    dd.style.top = (rect.bottom + 4) + 'px'; dd.style.bottom = 'auto';
  } else {
    dd.style.bottom = (window.innerHeight - rect.top + 4) + 'px'; dd.style.top = 'auto';
  }

  if (highlight >= 0) {
    dd.querySelectorAll('.member-dd-item')[highlight]?.scrollIntoView({ block: 'nearest' });
  }
}

function hide() {
  const dd = ddEl();
  if (dd) dd.style.display = 'none';
  activeInput = null;
  highlight = -1;
}

function pick(m) {
  if (!activeInput) return;
  activeInput.value = formatMember(m, acLang(activeInput));
  // Let the host page react through its normal input handler.
  activeInput.dispatchEvent(new Event('input', { bubbles: true }));
  hide();
}

const isTarget = (el) => el && el.classList && el.classList.contains('member-ac');

function init() {
  const onFocusIn = (e) => {
    if (!isTarget(e.target)) { hide(); return; }
    e.target.setAttribute('autocomplete', 'off');
    activeInput = e.target;
    highlight = -1;
    render();
  };
  const onInput = (e) => {
    if (!isTarget(e.target)) return;
    activeInput = e.target;
    highlight = -1;
    render();
  };
  const onKeydown = (e) => {
    const dd = ddEl();
    if (!dd || dd.style.display === 'none') return;
    const items = filtered();
    if (e.key === 'ArrowDown') {
      e.preventDefault(); highlight = Math.min(highlight + 1, items.length - 1); render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); highlight = Math.max(highlight - 1, -1); render();
    } else if (e.key === 'Enter' && highlight >= 0) {
      e.preventDefault(); pick(items[highlight]);
    } else if (e.key === 'Escape') {
      hide();
    }
  };
  const onFocusOut = (e) => {
    if (!isTarget(e.target)) return;
    setTimeout(() => {
      const dd = ddEl();
      if (dd && !dd.contains(document.activeElement)) hide();
    }, 100);
  };
  const onDropdownMousedown = (e) => {
    e.preventDefault(); // keep focus on the input
    const item = e.target.closest('.member-dd-item');
    if (!item) return;
    const m = filtered()[parseInt(item.dataset.idx, 10)];
    if (m) pick(m);
  };
  // Keep the dropdown glued to its input while the page/table scrolls.
  const reposition = () => {
    if (!activeInput) return;
    const rect = activeInput.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) hide();
    else render();
  };

  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('focusout', onFocusOut);
  const dd = ddEl();
  dd?.addEventListener('mousedown', onDropdownMousedown);
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  return () => {
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('input', onInput);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('focusout', onFocusOut);
    ddEl()?.removeEventListener('mousedown', onDropdownMousedown);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  };
}

export const MemberAC = {
  init,
  setRoster: (list) => { roster = Array.isArray(list) ? list : []; },
  getRoster: () => roster,
  formatMember,
  hide,
};
