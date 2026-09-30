import { icons } from '../vendor/lucide.js';

const attribute = value => String(value).replace(/[&"<>]/g, character => ({
    '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;'
})[character]);

export function icon(name, className = '') {
    const nodes = icons[name];
    if (!nodes) throw Error('Unknown icon: ' + name);
    const shapes = nodes.map(([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes).map(([key, value]) => `${key}="${attribute(value)}"`).join(' ')}/>`
    ).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-${name}${className ? ' ' + attribute(className) : ''}" data-lucide="${name}" aria-hidden="true" focusable="false">${shapes}</svg>`;
}
