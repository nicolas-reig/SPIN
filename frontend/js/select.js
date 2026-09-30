let active = null;
let serial = 0;

function close(refocus = false) {
    if (!active) return;
    const { button, menu } = active;
    button.setAttribute('aria-expanded', 'false');
    menu.remove();
    if (refocus && button.isConnected) button.focus();
    active = null;
}

function enhance(select) {
    if (select.dataset.custom) return;
    select.dataset.custom = 'true';
    select.hidden = true;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'select-button';
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const label = select.getAttribute('aria-label') || select.labels?.[0]?.textContent || select.title;
    if (label) button.setAttribute('aria-label', label);
    button.title = select.title || label || '';
    select.after(button);
    const sync = () => {
        button.replaceChildren();
        const text = document.createElement('span');
        text.textContent = select.selectedOptions[0]?.textContent || '';
        const arrow = document.createElement('span');
        arrow.className = 'status-chevron';
        arrow.setAttribute('aria-hidden', 'true');
        button.append(text, arrow);
        button.disabled = select.disabled;
    };
    sync();
    select.addEventListener('change', sync);
    select.labels?.forEach(label => label.addEventListener('click', () => button.focus()));
    const open = () => {
        if (active?.button === button) { close(); return; }
        close();
        const menu = document.createElement('div');
        menu.id = 'select-options-' + ++serial;
        menu.className = 'selection-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', label || '');
        button.setAttribute('aria-controls', menu.id);
        button.setAttribute('aria-expanded', 'true');
        let options = [];
        for (const option of select.options) {
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = option.textContent;
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', option.selected);
            item.tabIndex = -1;
            item.disabled = option.disabled;
            item.addEventListener('click', () => {
                select.value = option.value;
                close(true);
                select.dispatchEvent(new Event('change', { bubbles: true }));
            });
            menu.append(item);
            if (!option.disabled) options.push(item);
        }
        (select.closest('dialog') || document.body).append(menu);
        active = { button, menu };
        const rect = button.getBoundingClientRect();
        const width = Math.min(Math.max(rect.width, 180), innerWidth - 24);
        menu.style.width = width + 'px';
        menu.style.left = Math.max(12, Math.min(innerWidth - width - 12, rect.left)) + 'px';
        const availableBelow = innerHeight - rect.bottom - 14;
        const above = availableBelow < Math.min(menu.scrollHeight, 230) && rect.top > availableBelow;
        menu.style.maxHeight = Math.max(80, Math.min(320, above ? rect.top - 18 : availableBelow)) + 'px';
        menu.style.top = (above ? rect.top - Math.min(menu.scrollHeight, parseFloat(menu.style.maxHeight)) - 6 : rect.bottom + 6) + 'px';
        options.find(item => item.getAttribute('aria-selected') === 'true')?.focus();
        let prefix = '', timer;
        menu.addEventListener('keydown', event => {
            const index = options.indexOf(document.activeElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                options[next]?.focus();
            } else if (event.key === 'Escape' || event.key === 'Tab') {
                if (event.key === 'Escape') event.preventDefault();
                close(true);
            } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
                prefix += event.key.toLocaleLowerCase();
                clearTimeout(timer);
                timer = setTimeout(() => { prefix = ''; }, 650);
                options.find(item => item.textContent.toLocaleLowerCase().startsWith(prefix))?.focus();
            }
        });
    };
    button.addEventListener('click', open);
    button.addEventListener('keydown', event => {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); }
    });
}

export function installSelects() {
    const panels = new Set();
    const observer = new ResizeObserver(entries => {
        for (const { target } of entries) {
            const gutter = Math.max(0, (target.offsetWidth - target.clientWidth) / 2);
            target.style.setProperty('--scroll-inset', gutter + 'px');
        }
    });
    const update = () => {
        if (active && !active.button.isConnected) close();
        document.querySelectorAll('select:not([data-custom])').forEach(enhance);
        for (const panel of panels) if (!panel.isConnected) { observer.unobserve(panel); panels.delete(panel); }
        document.querySelectorAll('.panel-content:not([data-measured])').forEach(panel => { panel.dataset.measured = 'true'; panels.add(panel); observer.observe(panel); });
    };
    new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('pointerdown', event => {
        if (active && !active.menu.contains(event.target) && !active.button.contains(event.target)) close();
    });
    window.addEventListener('resize', () => close());
    document.addEventListener('scroll', event => { if (active && !active.menu.contains(event.target)) close(); }, true);
    update();
}
