'use client';

import { useEffect, useRef } from 'react';
import './searchable-select.css';

// ================================================================
// SearchableSelect — a <select> you can type into to filter
// ================================================================
// Renders the real <select> (same id, same onChange) visually hidden, plus a
// text box and a list. Pages keep driving the <select> exactly as before —
// filling it with innerHTML, reading and setting `.value`, listening for
// `change` — and the box follows along:
//   - options replaced or edited → seen by a MutationObserver
//   - `.value` set from code     → the instance's value setter is wrapped
//   - picking from the list      → sets the value and fires a real `change`,
//                                  which React's onChange receives as usual

const NATIVE_VALUE = typeof window !== 'undefined'
  ? Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
  : null;

function attach(select, input, list, emptyText) {
  let shown = [];   // options currently listed
  let active = -1;  // keyboard highlight within `shown`

  const label = () => select.selectedOptions[0]?.textContent ?? '';
  const sync = () => {
    if (document.activeElement !== input) input.value = label();
    input.disabled = select.disabled;
  };

  function render(query) {
    const needle = query.trim().toLowerCase();
    shown = [...select.options].filter((o) => !needle || o.textContent.toLowerCase().includes(needle));
    list.innerHTML = '';
    shown.forEach((o, i) => {
      const li = document.createElement('li');
      li.textContent = o.textContent;
      li.setAttribute('role', 'option');
      li.className = 'ss-item'
        + (o.value === select.value ? ' ss-selected' : '')
        + (i === active ? ' ss-active' : '');
      // mousedown, not click: it lands before the input's blur closes the list.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(o); });
      list.appendChild(li);
    });
    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'ss-empty';
      li.textContent = emptyText;
      list.appendChild(li);
    }
    list.querySelector('.ss-active')?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    active = -1;
    render('');
    list.hidden = false;
    input.select();
  }
  function close() {
    list.hidden = true;
    sync();
  }
  function choose(option) {
    const changed = select.value !== option.value;
    NATIVE_VALUE.set.call(select, option.value);
    close();
    input.blur();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { open(); return; }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = Math.max(0, Math.min(shown.length - 1, active + step));
      render(input.value === label() ? '' : input.value);
    } else if (e.key === 'Enter') {
      if (!list.hidden && shown.length) {
        e.preventDefault();
        choose(shown[Math.max(active, 0)]);
      }
    } else if (e.key === 'Escape') {
      close();
      input.blur();
    }
  };
  const onInput = () => { active = 0; render(input.value); list.hidden = false; };

  input.addEventListener('focus', open);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', close);
  select.addEventListener('change', sync);

  // Code elsewhere sets `select.value = …` directly; keep the box in step.
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return NATIVE_VALUE.get.call(this); },
    set(v) { NATIVE_VALUE.set.call(this, v); sync(); },
  });
  const observer = new MutationObserver(sync);
  observer.observe(select, { childList: true, subtree: true, characterData: true,
                             attributes: true, attributeFilter: ['disabled'] });
  sync();

  return () => {
    observer.disconnect();
    delete select.value;    // back to the prototype's accessor
    input.removeEventListener('focus', open);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', close);
    select.removeEventListener('change', sync);
  };
}

/**
 * Drop-in for `<select>`: same id / className / onChange / children / ref.
 * `className` styles the visible box (it is what people see and click).
 */
export default function SearchableSelect({
  id, className = '', style, onChange, children, selectRef,
  placeholder = '輸入以搜尋…', emptyText = '找不到符合的項目', defaultValue,
}) {
  const ownRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    const select = ownRef.current;
    if (selectRef) selectRef.current = select;
    return attach(select, inputRef.current, listRef.current, emptyText);
  }, [selectRef, emptyText]);

  return (
    <span className="ss-wrap" style={style}>
      <select id={id} ref={ownRef} className="ss-native" onChange={onChange}
              defaultValue={defaultValue} tabIndex={-1} aria-hidden="true">
        {children}
      </select>
      <input ref={inputRef} type="text" className={`ss-input ${className}`}
             placeholder={placeholder} autoComplete="off" role="combobox" />
      <ul ref={listRef} className="ss-list" role="listbox" hidden />
    </span>
  );
}
