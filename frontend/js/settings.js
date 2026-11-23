import { installControlMotion } from './control-motion.js';
import { COLOR_SCHEMES, colorMode, setColorMode, onColorModeChange } from './colors.js';
import { t, lang, setLanguage } from './locale.js';
import { icon } from './icons.js';
import { escape as esc } from './html.js';
import { readMapPreferences, saveMapPreferences } from './map-preferences.js';
import { clearBrowserData } from './browser-data.js';

installControlMotion();

const main = document.querySelector('main');
const isSettings = main.id === 'settings-content';
const keys = ['ok', 'problem', 'retired', 'selection', 'editSelection', 'floor'];
const labels = { selection: 'paletteSelection', editSelection: 'paletteEditSelection', floor: 'paletteFloor' };
let paletteSaved = true, mapSaved = true, resetStatus = '', clearing = false;
let preferences = readMapPreferences();
const returnUrl = new URL('./', location.href);
try {
    const requested = new URL(new URLSearchParams(location.search).get('return') || './', location.href);
    if (requested.origin === location.origin && [returnUrl.pathname, returnUrl.pathname + 'index.html'].includes(requested.pathname)) {
        returnUrl.pathname = requested.pathname;
        returnUrl.search = requested.search;
        returnUrl.hash = requested.hash;
    }
} catch {}

function palettes() {
    return `
        <p class="palette-intro">${esc(t('paletteIntro'))}</p>
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
            <p id="palette-save-state" role="status" class="${paletteSaved ? 'muted' : 'error'}">${esc(t(paletteSaved ? 'paletteSaved' : 'paletteNotSaved'))}</p>
        </footer>`;
}

function mapSwitch(key, name, hint) {
    return `<button type="button" id="setting-${key}" class="settings-switch" role="switch" data-setting="${key}"
        aria-checked="${preferences[key]}" aria-labelledby="${key}-name" aria-describedby="${key}-hint">
        <span class="settings-switch-copy"><strong id="${key}-name">${esc(t(name))}</strong><span id="${key}-hint">${esc(t(hint))}</span></span>
        <span class="settings-switch-track" aria-hidden="true"></span>
    </button>`;
}

function render() {
    const focused = document.activeElement?.id;
    const page = isSettings ? 'settings' : 'accessibility';
    document.documentElement.lang = lang();
    document.title = `SPIN · ${t(page)}`;
    main.innerHTML = `
        <nav class="settings-nav" aria-label="${esc(t(page))}">
            <a class="settings-back" href="${esc(returnUrl.href)}">${icon('arrow-left')}<span>${esc(t('backToMap'))}</span></a>
            <div class="language" aria-label="${esc(t('language'))}">
                ${['de', 'en'].map(value => `<button id="language-${value}" type="button" data-language="${value}" lang="${value}" class="${lang() === value ? 'active' : ''}" aria-pressed="${lang() === value}">${value.toUpperCase()}</button>`).join('')}
            </div>
        </nav>
        <h1 class="settings-title">${esc(t(page))}</h1>
        ${isSettings ? `
            <section class="settings-section" aria-labelledby="map-settings-title">
                <h2 id="map-settings-title">${esc(t('mapDisplay'))}</h2>
                <div class="settings-switches">
                    ${mapSwitch('topCircle', 'topCircle', 'topCircleHint')}
                    ${mapSwitch('groupLabels', 'groupLabels', 'groupLabelsHint')}
                </div>
                <p id="map-save-state" role="status" ${mapSaved ? 'hidden' : ''} class="error">${esc(t('mapPreferencesNotSaved'))}</p>
            </section>
            <section class="settings-section" aria-labelledby="accessibility">
                <h2 id="accessibility">${esc(t('accessibility'))}</h2>
                ${palettes()}
            </section>
            <section class="settings-section" aria-labelledby="browser-data-title">
                <h2 id="browser-data-title">${esc(t('browserData'))}</h2>
                <div class="settings-data-row">
                    <p>${esc(t('browserDataHint'))}</p>
                    <button type="button" class="danger" id="clear-browser-data">${icon('trash')}${esc(t('clearBrowserData'))}</button>
                </div>
                <p class="settings-reset-status" role="status" ${resetStatus ? '' : 'hidden'}>${resetStatus ? esc(t(resetStatus)) : ''}</p>
            </section>
            <dialog aria-labelledby="clear-dialog-title" aria-describedby="clear-dialog-description" id="clear-browser-dialog">
                <div class="dialog-header"><h2 id="clear-dialog-title">${esc(t('clearBrowserData'))}</h2></div>
                <form method="dialog" class="dialog-body" id="clear-browser-form">
                    <p id="clear-dialog-description">${esc(t('clearBrowserDataConfirm'))}</p>
                    <div class="dialog-footer">
                        <button type="submit" class="quiet" value="cancel" autofocus>${esc(t('cancel'))}</button>
                        <button type="submit" class="danger" value="clear">${esc(t('clearBrowserData'))}</button>
                    </div>
                </form>
            </dialog>` : palettes()}`;
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
}

main.addEventListener('change', event => {
    if (event.target.name !== 'color-scheme') return;
    paletteSaved = setColorMode(event.target.value);
    const status = document.querySelector('#palette-save-state');
    status.className = paletteSaved ? 'muted' : 'error';
    status.textContent = t(paletteSaved ? 'paletteSaved' : 'paletteNotSaved');
});
main.addEventListener('click', event => {
    const button = event.target.closest('[data-language]');
    if (button) {
        setLanguage(button.dataset.language);
        render();
    }
    const control = event.target.closest('[data-setting]');
    if (control) {
        const key = control.dataset.setting;
        preferences[key] = !preferences[key];
        mapSaved = saveMapPreferences(preferences);
        control.setAttribute('aria-checked', String(preferences[key]));
        document.querySelector('#map-save-state').hidden = mapSaved;
    }
    if (event.target.closest('#clear-browser-data')) document.querySelector('#clear-browser-dialog').showModal();
});
main.addEventListener('cancel', event => { if (clearing) event.preventDefault(); }, true);
main.addEventListener('submit', async event => {
    if (event.target.id !== 'clear-browser-form' || event.submitter?.value !== 'clear') return;
    event.preventDefault();
    if (clearing) return;
    clearing = true;
    for (const button of event.target.querySelectorAll('button')) button.disabled = true;
    event.submitter.textContent = t('clearingBrowserData');
    resetStatus = await clearBrowserData() ? 'browserDataReset' : 'browserDataLimited';
    paletteSaved = setColorMode('default');
    preferences = readMapPreferences();
    mapSaved = true;
    clearing = false;
    document.querySelector('#clear-browser-dialog').close();
    render();
    document.querySelector('#clear-browser-data').focus({ preventScroll: true });
});
onColorModeChange(() => {
    const input = document.querySelector('#palette-' + colorMode());
    if (input) input.checked = true;
});
render();
