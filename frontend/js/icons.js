import { icons } from '../vendor/lucide.js';

const attribute = value => String(value).replace(/[&"<>]/g, character => ({
    '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;'
})[character]);

// Lucide move/rotate and the supplied custom scale/transform SVGs.
const transformIcons = {
    "move-3d": [
        ["path", {"d": "M5 3v16h16"}],
        ["path", {"d": "m5 19 6-6"}],
        ["path", {"d": "m2 6 3-3 3 3"}],
        ["path", {"d": "m18 16 3 3-3 3"}]
    ],
    "rotate-3d": [
        ["path", {"d": "m15.194 13.707 3.814 1.86-1.86 3.814"}],
        ["path", {"d": "M16.47214 7.52786 A 5 10 0 1 0 13 21.79796"}],
        ["path", {"d": "M21.79796 11 A 10 5 0 1 0 19 15.57071"}]
    ],
    "square-upscale": [
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 16 3 L 21 3 L 21 8"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 17 21 L 19 21 C 20.10457 21 21 20.10457 21 19"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 21 12 L 21 15"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 21 3 L 16 8"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 3 7 L 3 5 C 3 3.895432 3.895431 3 5 3"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 9 3 L 12 3"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 4 11 L 12 11 C 12.552285 11 13 11.447715 13 12 L 13 20 C 13 20.552284 12.552285 21 12 21 L 4 21 C 3.447715 21 3 20.552284 3 20 L 3 12 C 3 11.447715 3.447715 11 4 11 Z"}]
    ],
    "transform": [
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 22.71875 6.65625 L 22.71875 1.65625 L 17.71875 1.65625"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 1.375 17.625 L 1.375 22.625 L 6.375 22.625"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "1.996875", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 11.4375 6.46875 L 11.4375 18.09375"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "1.996875", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 13.181251 16.349998 L 11.4375 18.09375 L 9.69375 16.349998"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "1.996875", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 15.506249 10.537499 L 17.25 12.28125 L 15.506249 14.025001"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "1.996875", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 5.625 12.28125 L 17.25 12.28125"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "1.996875", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 7.36875 10.537499 L 5.625 12.28125 L 7.36875 14.025001"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "1.996875", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 9.69375 8.212501 L 11.4375 6.46875 L 13.181251 8.212501"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "1.996875", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 20.374554 5.817032 L 20.378929 8.283062 L 17.912897 8.287436"}],
        ["path", {"fill": "none", "stroke": "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "d": "M 20.4375 12.28125 C 20.4375 17.251812 16.408062 21.28125 11.4375 21.28125 C 6.466937 21.28125 2.4375 17.251812 2.4375 12.28125 C 2.4375 7.310688 6.466937 3.28125 11.4375 3.28125 C 13.9575 3.28125 16.3675 4.28125 18.1775 6.02125 L 20.4375 8.28125"}]
    ]
};

export function icon(name, className = '') {
    const nodes = transformIcons[name] || icons[name];
    if (!nodes) throw Error('Unknown icon: ' + name);
    const shapes = nodes.map(([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes).map(([key, value]) => `${key}="${attribute(value)}"`).join(' ')}/>`
    ).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-${name}${className ? ' ' + attribute(className) : ''}" data-lucide="${name}" aria-hidden="true" focusable="false">${shapes}</svg>`;
}
