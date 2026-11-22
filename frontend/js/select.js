import { icon } from './icons.js';
import { adaptiveExhibitName } from './exhibit-label.js';

let active = null;
let activePopover = null;
let serial = 0;

function close(refocus = false) {
    if (!active) return;
    const { button, menu } = active;
    button.setAttribute('aria-expanded', 'false');
    menu.remove();
    if (refocus && button.isConnected) button.focus();
    active = null;
}

function closePopover(refocus = false) {
    if (!activePopover) return;
    const { details, summary, menu, placeholder, style } = activePopover;
    activePopover = null;
    details.open = false;
    summary.setAttribute('aria-expanded', 'false');
    menu.classList.remove('floating-popover');
    if (style === null) menu.removeAttribute('style');
    else menu.setAttribute('style', style);
    if (details.isConnected) placeholder.replaceWith(menu);
    else { menu.remove(); placeholder.remove(); }
    if (refocus && summary.isConnected) summary.focus();
}

export function closeMenus(refocus = false) {
    const opened = Boolean(active || activePopover);
    close(refocus);
    closePopover(refocus);
    return opened;
}

function openPopover(details) {
    const menu = details.querySelector(':scope > .popover');
    const summary = details.querySelector(':scope > summary');
    if (!menu || !summary) return;
    closeMenus();
    details.open = true;
    const style = menu.getAttribute('style');
    const width = Math.min(parseFloat(getComputedStyle(menu).width) || 220, innerWidth - 24);
    const placeholder = document.createComment('');
    menu.before(placeholder);
    menu.classList.add('floating-popover');
    (details.closest('dialog') || document.body).append(menu);
    menu.style.width = width + 'px';
    menu.style.maxHeight = 'min(420px, calc(100dvh - 32px))';
    const rect = summary.getBoundingClientRect();
    const beside = getComputedStyle(details).getPropertyValue('--popover-side').trim() === 'right';
    const below = innerHeight - rect.bottom - 14;
    const above = !beside && below < Math.min(menu.scrollHeight, 240) && rect.top > below;
    const availableHeight = beside ? innerHeight - 24 : above ? rect.top - 18 : below;
    menu.style.maxHeight = Math.max(80, Math.min(420, availableHeight)) + 'px';
    const height = Math.min(menu.scrollHeight, parseFloat(menu.style.maxHeight));
    const sideLeft = rect.right + width + 8 <= innerWidth - 12 ? rect.right + 8 : rect.left - width - 8;
    const left = beside ? sideLeft : rect.right - width;
    const top = beside ? Math.min(rect.top, innerHeight - height - 12) : above ? rect.top - height - 6 : rect.bottom + 6;
    menu.style.left = Math.max(12, Math.min(innerWidth - width - 12, left)) + 'px';
    menu.style.top = Math.max(12, top) + 'px';
    menu.style.transformOrigin = beside ? (left > rect.left ? 'left top' : 'right top') : above ? 'right bottom' : 'right top';
    menu.style.bottom = 'auto';
    menu.style.right = 'auto';
    summary.setAttribute('aria-expanded', 'true');
    menu.id ||= 'popover-' + ++serial;
    summary.setAttribute('aria-controls', menu.id);
    activePopover = { details, summary, menu, placeholder, style };
    menu.querySelector('button:not(:disabled), input, select + button')?.focus();
}

function enhance(select) {
    if (select.dataset.custom) return;
    const exhibitNames = select.hasAttribute('data-exhibit-names');
    const setLabel = (element, text) => {
        if (exhibitNames) element.innerHTML = adaptiveExhibitName(text);
        else element.textContent = text;
    };
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
    for (const attribute of ['aria-description', 'aria-describedby']) {
        if (select.hasAttribute(attribute)) button.setAttribute(attribute, select.getAttribute(attribute));
    }
    select.after(button);
    const sync = () => {
        button.replaceChildren();
        const text = document.createElement('span');
        setLabel(text, select.selectedOptions[0]?.textContent || '');
        button.append(text);
        button.insertAdjacentHTML('beforeend', icon('chevron-down', 'status-chevron'));
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
            setLabel(item, option.textContent);
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
        menu.style.transformOrigin = above ? 'left bottom' : 'left top';
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
                if (event.key === 'Escape') event.stopPropagation();
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
        if (activePopover && !activePopover.details.isConnected) closePopover();
        document.querySelectorAll('select:not([data-custom])').forEach(enhance);
        document.querySelectorAll('details > summary:not(.icon-button):not([data-disclosure])').forEach(summary => {
            summary.dataset.disclosure = 'true';
            summary.insertAdjacentHTML('beforeend', icon('chevron-right', 'disclosure-icon'));
        });
        for (const panel of panels) if (!panel.isConnected) { observer.unobserve(panel); panels.delete(panel); }
        document.querySelectorAll('.panel-content:not([data-measured])').forEach(panel => { panel.dataset.measured = 'true'; panels.add(panel); observer.observe(panel); });
    };
    new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('toggle', event => {
        if (!(event.target instanceof HTMLDetailsElement)) return;
        if (event.target.open && event.target.querySelector(':scope > .popover')) openPopover(event.target);
        else if (!event.target.open && activePopover?.details === event.target) closePopover();
    }, true);
    document.addEventListener('pointerdown', event => {
        if (active && !active.menu.contains(event.target) && !active.button.contains(event.target)) close();
        if (activePopover && !activePopover.menu.contains(event.target) && !activePopover.summary.contains(event.target) && !active?.menu.contains(event.target)) closePopover();
    });
    document.addEventListener('click', event => {
        const item = event.target.closest('button[data-action], button[data-add-hardware], button[data-duplicate-exhibit], button[data-trash-exhibit], button[data-remove-instance], button[data-duplicate-instance], button[data-correct], button[data-delete-note], button[data-delete-link], button[data-edit-link]');
        if (item && activePopover?.menu.contains(item)) closePopover();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && (active || activePopover)) {
            event.preventDefault(); event.stopPropagation(); closeMenus(true);
        } else if (activePopover?.menu.contains(event.target) && !event.target.matches('input, select, textarea, [role=combobox]') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            const items = [...activePopover.menu.querySelectorAll('button:not(:disabled)')];
            const index = items.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            event.preventDefault(); items[next]?.focus();
        }
    }, true);
    document.addEventListener('focusin', event => {
        if (activePopover && !activePopover.menu.contains(event.target) && !activePopover.summary.contains(event.target) && !active?.menu.contains(event.target)) closePopover();
    });
    window.addEventListener('resize', () => closeMenus());
    document.addEventListener('scroll', event => {
        if (active && !active.menu.contains(event.target)) close();
        if (activePopover && !activePopover.menu.contains(event.target)) closePopover();
    }, true);
    update();
}
