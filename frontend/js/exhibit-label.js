import { exhibitNameSuffix } from './exhibit-groups.js';
import { escape as esc } from './html.js';

const labelSelector = '.adaptive-exhibit-name';

export function adaptiveExhibitName(name, action = '') {
    const suffix = exhibitNameSuffix(name);
    const prefix = name.slice(0, name.length - suffix.length);
    const prefixHTML = prefix ? `<span class="exhibit-name-prefix"${action ? ' aria-hidden="true"' : ''}>${esc(prefix)}</span>` : '';
    let text = esc(suffix);
    if (action) {
        const end = suffix.search(/\S+\s*$/u);
        text = `<span aria-hidden="true">${esc(suffix.slice(0, end))}</span><span class="exhibit-name-end"><span aria-hidden="true">${esc(suffix.slice(end))}</span>${action}</span>`;
    }
    if (!prefix) return text;
    return `<span class="adaptive-exhibit-name" title="${esc(name)}"><span class="exhibit-name-text">${prefixHTML}${text}</span><span class="exhibit-name-probe" aria-hidden="true"><span data-full-exhibit-name="${esc(name)}"${action ? ' class="with-exhibit-action"' : ''}></span></span></span>`;
}

export function installAdaptiveExhibitNames() {
    const resize = new ResizeObserver(entries => {
        const labels = new Set(entries.map(({ target }) => target.closest(labelSelector)));
        const changes = [];
        for (const label of labels) {
            if (!label?.isConnected) continue;
            const probe = label.lastElementChild;
            const available = probe.getBoundingClientRect().width;
            if (available) changes.push([label.querySelector('.exhibit-name-prefix'), probe.firstElementChild.getBoundingClientRect().width > available]);
        }
        for (const [prefix, short] of changes) prefix.classList.toggle('sr-only', short);
    });
    const sync = node => {
        if (!(node instanceof Element)) return;
        const labels = node.querySelectorAll(labelSelector);
        const watch = label => {
            const probe = label.lastElementChild;
            for (const target of [probe, probe.firstElementChild]) {
                if (label.isConnected) resize.observe(target);
                else resize.unobserve(target);
            }
        };
        if (node.matches(labelSelector)) watch(node);
        labels.forEach(watch);
    };
    new MutationObserver(records => {
        for (const { addedNodes, removedNodes } of records) {
            removedNodes.forEach(sync);
            addedNodes.forEach(sync);
        }
    }).observe(document.body, { childList: true, subtree: true });
    sync(document.body);
}
