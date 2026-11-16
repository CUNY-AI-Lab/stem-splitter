// A select-backed menu uses the application's controls and keeps its form value.
(() => {
  let sequence = 0;
  const instances = new WeakMap();
  const courseLabel = course => [course.className, course.term].filter(Boolean).join(' · ');
  function enhance(select, name = 'Workspace') {
    if (!select || instances.has(select)) return instances.get(select);
    const wrapper = document.createElement('div');
    wrapper.className = 'stem-select';
    const control = document.createElement('button');
    control.type = 'button'; control.className = 'stem-select-control';
    control.setAttribute('role', 'combobox'); control.setAttribute('aria-haspopup', 'listbox');
    control.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'stem-select-label'; control.append(label);
    const menu = document.createElement('div');
    menu.id = `stem-select-menu-${++sequence}`; menu.className = 'stem-select-menu'; menu.hidden = true;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', name);
    control.setAttribute('aria-controls', menu.id);
    select.before(wrapper); wrapper.append(select, control, menu);
    select.classList.add('stem-select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    let active = -1, options = [], search = '', searchTimer;
    const close = () => { menu.hidden = true; control.setAttribute('aria-expanded', 'false'); control.removeAttribute('aria-activedescendant'); search = ''; };
    const highlight = index => {
      active = index;
      [...menu.children].forEach((item, i) => item.classList.toggle('is-active', i === active));
      const item = menu.children[active];
      if (item && !menu.hidden) { control.setAttribute('aria-activedescendant', item.id); item.scrollIntoView({ block: 'nearest' }); }
    };
    const commit = index => {
      const option = options[index];
      if (select.disabled || !option || option.disabled) return;
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sync(); close(); control.focus();
    };
    function sync() {
      const selected = select.selectedOptions[0];
      label.textContent = selected?.textContent || `Choose ${name.toLowerCase()}`;
      control.setAttribute('aria-label', `${name}: ${label.textContent}`);
      control.title = label.textContent;
      control.disabled = select.disabled;
      options = [...select.options].filter(option => !option.disabled && !option.hidden);
      menu.replaceChildren(...options.map((option, index) => {
        const item = document.createElement('div');
        item.id = `${menu.id}-${index}`; item.className = 'stem-select-option';
        item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(option.selected));
        item.textContent = option.textContent;
        item.addEventListener('mousedown', event => event.preventDefault());
        item.addEventListener('pointermove', () => highlight(index));
        item.addEventListener('click', () => commit(index));
        return item;
      }));
      highlight(Math.max(0, options.findIndex(option => option.selected)));
      if (select.disabled) close();
    }
    const open = () => {
      if (select.disabled || !options.length) return;
      sync(); menu.style.maxWidth = `${Math.max(0, Math.min(544, innerWidth - wrapper.getBoundingClientRect().left - 16))}px`;
      menu.hidden = false; control.setAttribute('aria-expanded', 'true'); highlight(active);
    };
    control.addEventListener('click', () => menu.hidden ? open() : close());
    control.addEventListener('keydown', event => {
      if (event.key === 'Tab') { close(); return; }
      if (event.key === 'Escape') { if (!menu.hidden) { event.preventDefault(); event.stopPropagation(); close(); } return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        if (menu.hidden) { open(); return; }
        if (event.key === 'Enter' || event.key === ' ') { commit(active); return; }
        highlight(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
          : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); if (menu.hidden) open();
        clearTimeout(searchTimer); search += event.key.toLocaleLowerCase();
        const found = options.findIndex(option => option.textContent.toLocaleLowerCase().startsWith(search));
        if (found >= 0) highlight(found);
        searchTimer = setTimeout(() => { search = ''; }, 600);
      }
    });
    const outside = event => { if (!wrapper.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside);
    wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(); });
    select.addEventListener('change', sync);
    for (const label of select.labels || []) label.addEventListener('click', event => { event.preventDefault(); control.focus(); });
    const observer = new MutationObserver(sync);
    observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'hidden'] });
    sync();
    const instance = { sync, destroy() { observer.disconnect(); clearTimeout(searchTimer); document.removeEventListener('pointerdown', outside); } };
    instances.set(select, instance); return instance;
  }
  window.StemSelect = { enhance, courseLabel };
})();
