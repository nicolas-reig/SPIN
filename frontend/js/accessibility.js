import { COLOR_SCHEMES, colorMode, setColorMode, onColorModeChange } from './colors.js';
import { t, lang, setLanguage } from './locale.js';
import { icon } from './icons.js';
import { escape as esc } from './html.js';

const main = document.querySelector('#accessibility-content');
const keys = ['ok', 'problem', 'retired', 'selection', 'editSelection', 'floor'];
const labels = { selection: 'paletteSelection', editSelection: 'paletteEditSelection', floor: 'paletteFloor' };
let saved = true;
const returnUrl = new URL('./', location.href);
try {
    const requested = new URL(new URLSearchParams(location.search).get('return') || './', location.href);
    if (requested.origin === location.origin && [returnUrl.pathname, returnUrl.pathname + 'index.html'].includes(requested.pathname)) {
        returnUrl.pathname = requested.pathname;
        returnUrl.search = requested.search;
        returnUrl.hash = requested.hash;
    }
} catch {}

function render() {
    const focused = document.activeElement?.id;
    document.documentElement.lang = lang();
    document.title = t('accessibility') + ' · ' + t('hub');
    main.innerHTML = `
        <nav class="accessibility-nav" aria-label="${esc(t('accessibility'))}">
            <a class="accessibility-back" href="${esc(returnUrl.href)}">${icon('arrow-left')}<span>${esc(t('backToMap'))}</span></a>
            <div class="language" aria-label="${esc(t('language'))}">
                ${['de', 'en'].map(value => `<button id="language-${value}" type="button" data-language="${value}" lang="${value}" class="${lang() === value ? 'active' : ''}" aria-pressed="${lang() === value}">${value.toUpperCase()}</button>`).join('')}
            </div>
        </nav>
        <header class="accessibility-heading">
            <h1>${esc(t('accessibility'))}</h1>
            <p>${esc(t('paletteIntro'))}</p>
        </header>
        <fieldset class="palette-options">
            <legend class="sr-only">${esc(t('colorScheme'))}</legend>
            ${Object.entries(COLOR_SCHEMES).map(([value, scheme]) => `
                <label class="palette-option">
                    <input class="sr-only" id="palette-${value}" type="radio" name="color-scheme" value="${value}" aria-labelledby="palette-title-${value}" aria-describedby="palette-description-${value}" ${value === colorMode() ? 'checked' : ''}>
                    <span class="palette-card">
                        <span class="palette-heading"><strong id="palette-title-${value}">${esc(t('palette_' + value))}</strong><span class="palette-check" aria-hidden="true">${icon('check')}</span></span>
                        <span class="palette-description" id="palette-description-${value}">${esc(t('paletteHint_' + value))}</span>
                        <span class="palette-swatches">
                            ${keys.map(key => `<span class="palette-sample"><span class="palette-color" style="--swatch: ${scheme.materials[key]}" aria-hidden="true"></span><span>${esc(t(labels[key] || key))}</span></span>`).join('')}
                        </span>
                    </span>
                </label>`).join('')}
        </fieldset>
        <footer class="accessibility-footer">
            <p>${esc(t('paletteScope'))}</p>
            <p id="palette-save-state" role="status" class="${saved ? 'muted' : 'error'}">${esc(t(saved ? 'paletteSaved' : 'paletteNotSaved'))}</p>
        </footer>`;
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
}

main.addEventListener('change', event => {
    if (event.target.name !== 'color-scheme') return;
    saved = setColorMode(event.target.value);
    const status = document.querySelector('#palette-save-state');
    status.className = saved ? 'muted' : 'error';
    status.textContent = t(saved ? 'paletteSaved' : 'paletteNotSaved');
});
main.addEventListener('click', event => {
    const button = event.target.closest('[data-language]');
    if (!button) return;
    setLanguage(button.dataset.language);
    render();
});
onColorModeChange(() => {
    const input = document.querySelector('#palette-' + colorMode());
    if (input) input.checked = true;
});
render();
