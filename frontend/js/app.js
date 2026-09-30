import {
    Api,
    uid
} from './api.js';
import {
    EditSession,
    identity,
    MapPlacement,
    STATUSES,
    STATUS_COLORS,
    normalizeStatus,
    structural
} from './domain.js';
import {
    t,
    lang,
    setLanguage,
    date
} from './locale.js';
import {
    escape as esc,
    markdown
} from './markdown.js';
import { readNoteImage } from './images.js';
import { createNoteEditor } from './editor.js';
import { installSelects } from './select.js';
import { safeUrl, opensInBrowser } from './domain.js';
let noteEditor = null;
installSelects();
const $ = s => document.querySelector(s),
    api = new Api();
let snapshot = null,
    selected = null,
    floorId = '0',
    activeInstance = 0,
    tab = 'notes',
    edit = null,
    map = null,
    mapPromise = null,
    submitStructure = null,
    mapState = 'mapLoading',
    view = 'list',
    query = '',
    scope = 'nameFloor',
    floorFilter = '',
    statusFilter = '',
    mapMode = 'top',
    gizmo = '',
    axisConstraint = '',
    snap = false,
    noticeTimer, dialogCleanup = null;
let drafts = {}, draftStorageKey = '', editStorageKey = '';
const linkDrafts = {};
const linkSearches = {};
function loadDrafts() {
    draftStorageKey = 'hub-drafts-' + snapshot.datasetKey;
    editStorageKey = 'hub-edit-' + snapshot.datasetKey;
    try {
        drafts = JSON.parse(localStorage.getItem(draftStorageKey) || '{}');
        Object.values(drafts).forEach(draft => {
            draft.saving = false;
            draft.readingImages = false;
            if (draft.status === 'unset') draft.status = 'ok';
        });
    } catch {
        drafts = {};
    }
}
const data = () => edit?.value || snapshot;
const exhibit = () => data()?.exhibits.find(e => e.id === selected);
const floor = () => data()?.floors.find(f => f.id === floorId);
const titleFloor = id => data()?.floors.find(f => f.id === id)?.names[lang()] || id || t('noFloor');
const trashIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6"/></svg>';
for (const [status, value] of Object.entries(STATUS_COLORS)) document.documentElement.style.setProperty('--status-' + status, value);
const statusHTML = status => `<span class="status-badge"><span class="status-symbol ${status}" aria-hidden="true"></span>${esc(t(status))}</span>`;
const button = (label, action, cls = '', extra = '') => `<button type="button" data-action="${action}" class="${cls}" ${extra}>${esc(t(label))}</button>`;
const options = (rows, value) => rows.map(([id, label]) => `<option value="${esc(id)}" ${id===value?'selected':''}>${esc(label)}</option>`).join('');
const statusOptions = (value, keep = false) => options([...(keep ? [
    ['', t('keepStatus')]
] : []), ...STATUSES.map(s => [s, t(s)])], value);

function announce(message) {
    $('#notice').textContent = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => $('#notice').textContent = '', 6500);
}

function errorText(e) {
    return t(e.key || e.message || 'storage');
}

function persistDrafts() {
    try {
        if (draftStorageKey) localStorage.setItem(draftStorageKey, JSON.stringify(drafts, (key, value) => ['saving', 'readingImages'].includes(key) ? undefined : value));
        return true;
    } catch {
        announce(t('draftFailed'));
        return false;
    }
}

function persistEdit() {
    try {
        if (edit) localStorage.setItem(editStorageKey, JSON.stringify({
            base: edit.base,
            value: edit.value
        }));
        else if (editStorageKey) localStorage.removeItem(editStorageKey);
    } catch {
        announce(t('draftFailed'));
    }
}

function setView(value) {
    if (value === 'detail' && !exhibit() && !edit) value = 'map';
    collapseEmptyDraft();
    view = value;
    document.body.dataset.view = value;
    renderMobile();
    map?.resize();
}


function iconButton(label, action, symbol, extra = '') {
    return `<button type="button" class="icon-button" data-action="${action}" aria-label="${esc(t(label))}" title="${esc(t(label))}" ${extra}>${symbol}</button>`;
}

function displayName(record) {
    return record.name;
}

function floorLabel(record) {
    return record.names[lang()];
}

function collapseEmptyDraft() {
    const draft = drafts[selected];
    if (draft && !draft.noteId && !draft.body.trim() && !draft.images.length && !draft.existingImages.length) {
        draft.open = false;
        draft.signing = false;
        persistDrafts();
    }
}

function removeExhibit(id) {
    if (!edit) return;
    edit.change(state => {
        const record = state.exhibits.find(e => e.id === id);
        if (!record) return;
        if (record.notes.length || record.links.length) throw Error('notEmpty');
        state.exhibits = state.exhibits.filter(e => e.id !== id);
    });
    changed();
}

function showStructureForm(kind, title, content, onSubmit) {
    if (kind === 'floors') return showDialog(title, content, onSubmit);
    $('#structure-slot').innerHTML = `<form id="structure-form" novalidate>${content}<div class="error" id="structure-error" role="alert" hidden></div></form>`;
    submitStructure = async () => {
        try {
            await onSubmit(new FormData($('#structure-form')));
            return true;
        } catch (error) {
            $('#structure-error').hidden = false;
            $('#structure-error').textContent = errorText(error);
            return false;
        }
    };
    $('#structure-form').addEventListener('submit', event => {
        event.preventDefault();
        submitStructure();
    });
    return $('#structure-form');
}

function deleteNoteDialog(noteId) {
    const record = structuredClone(exhibit());
    const note = record.notes.find(n => n.id === noteId);
    if (!note || note.deleted) return;
    const requestId = uid();
    showDialog('deleteNote', `<p>${esc(t('noteBy'))} ${esc(note.author)} · ${esc(date(note.at))}</p><p class="muted small" style="margin:12px 0 20px">${esc(t('deleteNoteHint'))}</p>${signatureField()}${footer('deleteNote')}`, async form => {
        const result = await api.save({ action: 'deleteNote', exhibitId: record.id, noteId, baseRevision: record.revision, contentTag: record.contentTag, requestId, signature: requireSignature(form) });
        if (drafts[record.id]?.noteId === noteId) delete drafts[record.id];
        persistDrafts();
        closeDialog();
        acceptSnapshot(result.snapshot);
        announce(t('saved'));
    });
    $('#dialog button[type=submit]').className = 'danger';
}

function renderHeader() {
    $('#header').innerHTML = '';
}

function renderSidebar() {
    const filtered = Boolean(query || floorFilter || statusFilter || scope !== 'nameFloor');
    const frows = [
        ['', t('allFloors')], ...data().floors.map(f => [f.id, f.names[lang()]])
    ];
    $('#sidebar').setAttribute('aria-label', t('exhibits'));
    $('#sidebar').innerHTML = `
        <div class="sidebar-title row between"><h2>${esc(t('exhibits'))}</h2>${edit ? iconButton('newExhibit', 'newExhibit', '+') : ''}</div>
        <div class="search-row">
            <div class="searchbox">
                <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg>
                <input id="search" type="search" value="${esc(query)}" placeholder="${esc(t('searchShort'))}" aria-label="${esc(t('search'))}" autocomplete="off">
            </div>
            <details class="filter-menu">
                <summary class="icon-button ${filtered ? 'active' : ''}" title="${esc(t('filters'))}" aria-label="${esc(t('filters'))}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18l-7 8v7l-4 2v-9L3 4Z"/></svg>${filtered ? '<i class="filter-dot"></i>' : ''}</summary>
                <div class="popover">
                    <label for="scope">${esc(t('scope'))}</label>
                    <select id="scope">${options(['nameFloor', 'notes', 'documentation'].map(x => [x, t(x)]), scope)}</select>
                    <label for="floor-filter">${esc(t('floor'))}</label>
                    <select id="floor-filter">${options(frows, floorFilter)}</select>
                    <label for="status-filter">${esc(t('status'))}</label>
                    <select id="status-filter">${options([['', t('allStatuses')], ...STATUSES.map(x => [x, t(x)])], statusFilter)}</select>
                    ${button('clear', 'clear', 'quiet')}
                </div>
            </details>
        </div>
        <div class="active-filters" ${filtered ? '' : 'hidden'}>
            <span id="filter-description"></span>${iconButton('clear', 'clear', '×')}
        </div>
        <div class="exhibit-list" id="exhibit-list"></div>
        <div class="sidebar-footer">
            <div class="row between">
                <div class="language" aria-label="${esc(t('language'))}">
                    <button data-language="de" class="${lang() === 'de' ? 'active' : ''}" lang="de" aria-pressed="${lang() === 'de'}">DE</button>
                    <button data-language="en" class="${lang() === 'en' ? 'active' : ''}" lang="en" aria-pressed="${lang() === 'en'}">EN</button>
                </div>
                <details class="app-menu">
                    <summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">···</summary>
                    <div class="popover">
                        ${button('editStructure', 'enterEdit', 'quiet', edit ? 'disabled' : '')}
                        ${button('refresh', 'refresh', 'quiet')}
                    </div>
                </details>
            </div>
        </div>`;
    $('#search').addEventListener('input', e => {
        query = e.target.value;
        renderList();
    });
    for (const [selector, setter] of [
            ['#scope', value => scope = value],
            ['#floor-filter', value => floorFilter = value],
            ['#status-filter', value => statusFilter = value]
        ]) {
        $(selector).addEventListener('change', e => {
            setter(e.target.value);
            renderList();
        });
    }
    renderList();
}

function renderList() {
    const q = query.trim().toLocaleLowerCase(lang());
    const records = data().exhibits.filter(e => {
        if (floorFilter && e.floorId !== floorFilter || statusFilter && e.status !== statusFilter) return false;
        const text = scope === 'notes' ? e.notes.filter(n => !n.deleted).map(n => n.body).join(' ') : scope === 'documentation' ? e.links.map(l => l.title + ' ' + l.url).join(' ') : e.name + ' ' + titleFloor(e.floorId);
        return text.toLocaleLowerCase(lang()).includes(q);
    });
    const filtered = Boolean(query || floorFilter || statusFilter || scope !== 'nameFloor');
    $('.active-filters').hidden = !filtered;
    $('#filter-description').textContent = [scope !== 'nameFloor' ? t(scope) : '', floorFilter ? titleFloor(floorFilter) : '', statusFilter ? t(statusFilter) : '', query ? '“' + query + '”' : ''].filter(Boolean).join(' · ');
    $('#exhibit-list').innerHTML = records.length ? records.map(e => `
        <div class="exhibit-entry"><button class="exhibit-row ${e.id === selected ? 'active' : ''}" data-select="${esc(e.id)}" aria-pressed="${e.id === selected}" title="${esc(titleFloor(e.floorId) + ' · ' + t(e.placed ? e.status : 'unplaced'))}">
            <span class="exhibit-name">${esc(displayName(e))}</span>
            <span class="status-symbol ${e.status}" aria-label="${esc(t(e.status))}"></span>
        </button>${edit ? `<button class="icon-button danger exhibit-trash" data-trash-exhibit="${esc(e.id)}" aria-label="${esc(t('deleteExhibit') + ': ' + displayName(e))}">${trashIcon}</button>` : ''}</div>`).join('') : `<p class="empty">${esc(t('noResults'))}</p>`;
}

function renderMapUI() {
    $('#map-heading').innerHTML = `<nav class="floor-selector" aria-label="${esc(t('floor'))}">
        ${[...data().floors].sort((a, b) => b.order - a.order).map(f => `<button data-floor="${esc(f.id)}" aria-current="${floorId === f.id ? 'true' : 'false'}" title="${esc(f.names[lang()])}">${esc(floorLabel(f))}</button>`).join('')}
    </nav>`;
    $('.floor-selector').addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...$('.floor-selector').querySelectorAll('button')];
        const index = buttons.indexOf(event.target);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        changeFloor(buttons[next].dataset.floor);
        $('.floor-selector').querySelectorAll('button')[next].focus();
    });
    $('#map-controls').innerHTML = `
        <div class="map-toolbar" aria-label="${esc(t('keyboardMap'))}">
            <select id="camera-view" aria-label="${esc(t('cameraView'))}" title="${esc(t('cameraView'))}">
                ${options([['iso', t('iso')], ['top', t('top')], ['perspective', t('perspective')]], mapMode)}
            </select>
            <span class="toolbar-divider"></span>
            ${iconButton('focus', 'focus', '⌖', !selected ? 'disabled' : '')}
            ${iconButton('zoomOut', 'camera:zoomOut', '−') + iconButton('zoomIn', 'camera:zoomIn', '+')}
            <details class="camera-menu">
                <summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">···</summary>
                <div class="popover">
                    ${button('fit', 'camera:fit', 'quiet')}
                    ${button('rotate', 'camera:rotate', 'quiet')}
                    <div class="row">${[['panLeft', '←'], ['panUp', '↑'], ['panDown', '↓'], ['panRight', '→']].map(([a, symbol]) => iconButton(a, 'camera:' + a, symbol)).join('')}</div>
                    <p class="small muted">${esc(t('mapHelp'))}</p>
                </div>
            </details>
        </div>`;
    $('#camera-view').addEventListener('change', async e => {
        const value = e.target.value;
        mapMode = value;
        await ensureMap();
        map?.setView(mapMode);
        syncUrl();
        renderMapUI();
    });
    $('#map-message').textContent = mapState === 'mapReady' ? '' : t(mapState);
    map?.resize();
}

async function ensureMap() {
    if (mapPromise) return mapPromise;
    if (map) return;
    mapPromise = initializeMap();
    try { await mapPromise; } finally { mapPromise = null; }
}

async function initializeMap() {
    let instance;
    try {
        const {
            MapView
        } = await import('./map.js');
        instance = new MapView($('#map-canvas'), {
            onSelect: select,
            onMode: mode => { mapMode = mode; syncUrl(); renderMapUI(); },
            onState: key => {
                mapState = key;
                $('#map-canvas').classList.toggle('floor-loading', key === 'mapLoading');
                $('#map-message').textContent = key === 'mapReady' ? '' : t(key);
            },
            onTransform: (id, index, transform) => {
                if (!edit) return;
                edit.change(s => {
                    const e = s.exhibits.find(x => x.id === id);
                    if (e?.models[index]) e.models[index].transform = transform;
                });
                persistEdit();
                renderEditBar();
                renderInspector();
            }
        });
        await instance.init();
        map = instance;
        map.setView(mapMode);
        await updateMap(true);
    } catch (e) {
        instance?.destroy();
        map = null;
        mapState = 'mapUnavailable';
        $('#map-message').textContent = t(mapState);
    }
}
async function updateMap(reset = false) {
    if (map) await map.setData(data(), floorId, selected, Boolean(edit), {
        reset
    });
}

async function select(id, instanceIndex = 0) {
    collapseEmptyDraft();
    const e = data().exhibits.find(x => x.id === id);
    if (!e) {
        selected = null;
        renderList(); renderInspector(); renderMapUI(); updateMap(); syncUrl();
        return;
    }
    const changed = Boolean(e.floorId && floorId !== e.floorId);
    selected = id;
    activeInstance = instanceIndex;
    if (e.floorId) floorId = e.floorId;
    map?.setActiveInstance(activeInstance);
    renderList();
    renderInspector();
    renderMapUI();
    await updateMap(changed);
    if (!edit) map?.focus(true);
    syncUrl();
    if (changed) announce(t('floorChanged') + ': ' + titleFloor(floorId));
    if (matchMedia('(max-width:860px)').matches) setView('detail');
}

function changeFloor(id) {
    collapseEmptyDraft();
    floorId = id;
    const e = exhibit();
    if (e?.floorId !== id) selected = null;
    renderMapUI();
    renderList();
    renderInspector();
    updateMap(true);
    syncUrl();
}

function syncUrl() {
    const url = new URL(location.href);
    if (floorId) url.searchParams.set('floor', floorId);
    else url.searchParams.delete('floor');
    url.searchParams.delete('area');
    if (selected) url.searchParams.set('exhibit', selected);
    else url.searchParams.delete('exhibit');
    url.searchParams.set('view', mapMode);
    history.replaceState(null, '', url);
}

function noteHTML(n) {
    if (n.deleted) return `<article class="note tombstone"><p>${esc(t('noteBy'))} <strong>${esc(n.author)}</strong></p><p>${esc(t('deletedBy'))} <strong>${esc(n.deleted.signature)}</strong></p><time datetime="${esc(n.deleted.at)}">${esc(date(n.deleted.at))}</time></article>`;
    const shortDate = new Intl.DateTimeFormat(lang() === 'de' ? 'de-DE' : 'en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date(n.at));
    return `
        <article class="note">
            <div class="note-meta">
                <span class="note-author">${esc(n.author)}</span>
                <time class="note-date" datetime="${esc(n.at)}" title="${esc(date(n.at, true))}">${esc(shortDate)}</time>
            </div>
            <div class="note-body">${markdown(n.body, selected)}</div>
            ${n.images.map(id => `<a href="api.php?action=asset&kind=image&id=${encodeURIComponent(id)}" target="_blank" rel="noopener"><img class="note-image" src="api.php?action=asset&kind=image&id=${encodeURIComponent(id)}" alt="${esc(t('image'))}" loading="lazy"></a>`).join('')}
            <div class="note-footer">
                ${n.corrections?.length ? `<details class="edit-attribution"><summary>${esc(t('edited'))}</summary><p>${esc(t('editedBy'))} ${esc(n.corrections.at(-1).signature)} · ${esc(date(n.corrections.at(-1).at))}</p></details>` : '<span></span>'}
                <details class="note-options"><summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">···</summary><div class="popover"><button type="button" data-correct="${esc(n.id)}">${esc(t('correct'))}</button><button type="button" class="danger" data-delete-note="${esc(n.id)}">${esc(t('deleteNote'))}</button></div></details>
            </div>
        </article>`;
}

function renderInspector() {
    const visible = Boolean(exhibit() || edit);
    document.body.classList.toggle('inspector-hidden', !visible);
    $('#inspector').inert = !visible;
    $('#inspector').setAttribute('aria-hidden', String(!visible));
    $('#resizer').inert = !visible;
    $('#resizer').setAttribute('aria-hidden', String(!visible));
    if (!visible) {
        if (view === 'detail') setView('map');
        renderMobile();
        return;
    }
    noteEditor?.destroy();
    noteEditor = null;
    submitStructure = null;
    if (edit) {
        renderEditInspector();
        return;
    }
    const e = exhibit();
    if (!e) {
        $('#inspector').innerHTML = `<div class="panel-content empty">${esc(t('noSelection'))}</div>`;
        return;
    }
    $('#inspector').innerHTML = `
        <div class="inspector-header">
            <div class="inspector-tools">
                <h1 title="${esc(titleFloor(e.floorId))}">${esc(displayName(e))}</h1>
                <div class="status-picker">
                    <button type="button" class="status-toggle" aria-label="${esc(t('changeStatus') + ': ' + t(e.status))}" aria-expanded="false" aria-controls="status-menu" aria-haspopup="menu" title="${esc(t(e.status))}">${statusHTML(e.status)}<span class="status-chevron" aria-hidden="true"></span></button>
                    <div class="status-menu" id="status-menu" role="menu" aria-label="${esc(t('changeStatus'))}" aria-hidden="true" inert>
                        ${STATUSES.map(status => `<button type="button" class="status-choice" data-status-choice="${status}" role="menuitemradio" tabindex="-1" aria-label="${esc(t(status))}" aria-checked="${status === e.status}">${statusHTML(status)}</button>`).join('')}
                    </div>
                </div>
            </div>
        </div>
        <div class="tabs" role="tablist" aria-label="${esc(t('detail'))}">
            ${['notes', 'documentation'].map(key => `<button role="tab" id="tab-${key}" aria-controls="inspector-content" aria-selected="${tab === key}" tabindex="${tab === key ? 0 : -1}" data-tab="${key}">${esc(t(key))}</button>`).join('')}
        </div>
        <div class="panel-content" id="inspector-content" role="tabpanel" aria-labelledby="tab-${tab}"></div>`;
    bindStatusPicker();
    renderPanel();
    $('#inspector').querySelector('[role=tablist]').addEventListener('keydown', ev => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
            ev.preventDefault();
            tab = ev.key === 'Home' ? 'notes' : ev.key === 'End' ? 'documentation' : tab === 'notes' ? 'documentation' : 'notes';
            renderInspector();
            $('#tab-' + tab).focus();
        }
    });
}

function closeStatusPicker(returnFocus = false) {
    const picker = $('.status-picker');
    if (!picker) return;
    picker.classList.remove('open');
    picker.querySelector('.status-toggle').setAttribute('aria-expanded', 'false');
    picker.querySelector('.status-menu').inert = true;
    picker.querySelector('.status-menu').setAttribute('aria-hidden', 'true');
    if (returnFocus) picker.querySelector('.status-toggle').focus();
}

function bindStatusPicker() {
    const picker = $('.status-picker');
    const toggle = picker.querySelector('.status-toggle');
    const menu = picker.querySelector('.status-menu');
    const choices = [...menu.querySelectorAll('button')];
    const open = () => {
        picker.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
        menu.inert = false;
        menu.setAttribute('aria-hidden', 'false');
    };
    toggle.addEventListener('click', () => {
        if (picker.classList.contains('open')) closeStatusPicker();
        else {
            open();
            choices.find(choice => choice.getAttribute('aria-checked') === 'true')?.focus();
        }
    });
    picker.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeStatusPicker(true); return; }
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        open();
        const index = choices.indexOf(document.activeElement);
        const backwards = ['ArrowUp', 'ArrowLeft'].includes(event.key);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : index < 0 ? (backwards ? choices.length - 1 : 0) : (index + (backwards ? -1 : 1) + choices.length) % choices.length;
        choices[next].focus();
    });
    picker.addEventListener('focusout', () => {
        setTimeout(() => { if (picker.isConnected && !picker.contains(document.activeElement)) closeStatusPicker(); }, 0);
    });
    for (const choice of choices) choice.addEventListener('click', () => {
        const status = choice.dataset.statusChoice;
        closeStatusPicker();
        if (status !== exhibit().status) statusDialog(status);
        else toggle.focus();
    });
}

document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.status-picker')) closeStatusPicker();
    const form = $('#note-form');
    const draft = drafts[selected];
    if (form && !form.contains(event.target) && !event.target.closest('dialog, .selection-menu') && draft?.open && !draft.noteId && !draft.body.trim() && !draft.images.length && !draft.existingImages.length && !draft.readingImages) {
        collapseEmptyDraft();
        renderComposer();
    }
});

function renderPanel() {
    const e = exhibit();
    if (!e) return;
    const el = $('#inspector-content');
    if (tab === 'notes') {
        el.innerHTML = `<div id="composer-slot"></div>${e.notes.filter(n => drafts[e.id]?.noteId !== n.id || drafts[e.id]?.readOnly).map(noteHTML).join('')}`;
        if (!drafts[e.id]) {
            drafts[e.id] = newDraft(e);
            drafts[e.id].open = false;
        }
        renderComposer();
    } else {
        renderLinks(e, el);
    }
}

function renderLinks(e, element) {
    const draft = linkDrafts[e.id] ||= { open: false, id: null, title: '', url: '', description: '' };
    const searchable = e.links.length > 6;
    if (!searchable) delete linkSearches[e.id];
    element.innerHTML = `
        <form class="composer link-composer ${draft.open ? 'composing' : ''}" id="link-form" novalidate>
            <input id="link-title" name="title" aria-label="${esc(t('title'))}" placeholder="${esc(t('addLink'))}" maxlength="160" value="${esc(draft.title)}">
            <div class="link-fields" ${draft.open ? '' : 'hidden'}>
                <input id="link-url" name="url" type="text" inputmode="url" aria-label="${esc(t('url'))}" placeholder="${esc(t('url'))}" value="${esc(draft.url)}">
                <textarea id="link-description" name="description" aria-label="${esc(t('description'))}" placeholder="${esc(t('description'))}" maxlength="1000">${esc(draft.description)}</textarea>
                <div class="row between"><button type="button" class="quiet" data-action="cancelLink">${esc(t('cancel'))}</button><button type="submit" class="primary">${esc(t('save'))}</button></div>
            </div>
            <p class="link-error" role="alert" ${draft.error ? '' : 'hidden'}>${draft.error ? esc(errorText({ key: draft.error })) : ''}</p>
        </form>
        ${searchable ? `<div class="searchbox link-search">
            <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg>
            <input id="link-search" type="search" value="${esc(linkSearches[e.id] || '')}" placeholder="${esc(t('searchLinks'))}" aria-label="${esc(t('searchLinks'))}" aria-controls="link-results" autocomplete="off">
        </div>` : ''}
        <div id="link-results">${e.links.map(link => `
            <article class="link-card">
                <a class="document-open" href="${esc(link.url)}" ${opensInBrowser(link.url) ? 'target="_blank"' : ''} rel="noopener noreferrer" title="${esc(link.url)}"><span>${esc(link.title)}</span><span aria-hidden="true">↗</span></a>
                ${link.description ? `<p>${esc(link.description)}</p>` : ''}
                <div class="link-actions">
                    <button type="button" class="quiet" data-copy="${esc(link.id)}" title="${esc(link.url)}">${esc(t('copy'))}</button>
                    <details class="note-options"><summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">···</summary><div class="popover"><button type="button" data-edit-link="${esc(link.id)}">${esc(t('edit'))}</button><button type="button" class="danger" data-delete-link="${esc(link.id)}">${esc(t('remove'))}</button></div></details>
                </div>
            </article>`).join('')}
            <p id="link-no-results" class="empty" role="status" hidden>${esc(t('noLinkResults'))}</p>
        </div>`;
    const search = element.querySelector('#link-search');
    const cards = [...element.querySelectorAll('.link-card')];
    const empty = element.querySelector('#link-no-results');
    const filterLinks = () => {
        const query = search?.value.trim().toLocaleLowerCase() || '';
        cards.forEach((card, index) => {
            const link = e.links[index];
            card.hidden = ![link.title, link.url, link.description].join(' ').toLocaleLowerCase().includes(query);
        });
        empty.hidden = !query || cards.some(card => !card.hidden);
    };
    search?.addEventListener('input', () => {
        linkSearches[e.id] = search.value;
        filterLinks();
    });
    filterLinks();
    const form = element.querySelector('#link-form');
    form.addEventListener('focusin', () => {
        if (!draft.open) {
            draft.open = true;
            form.classList.add('composing');
            form.querySelector('.link-fields').hidden = false;
        }
    });
    form.addEventListener('input', event => {
        if (['title', 'url', 'description'].includes(event.target.name)) draft[event.target.name] = event.target.value;
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (draft.saving) return;
        const current = exhibit();
        draft.saving = true;
        form.querySelector('[type=submit]').disabled = true;
        try {
            if (!draft.title.trim()) throw Error('invalidInput');
            if (!safeUrl(draft.url.trim())) throw Error('invalidUrl');
            const result = await api.save({
                action: 'putLink', exhibitId: current.id, linkId: draft.id,
                title: draft.title.trim(), url: draft.url.trim(), description: draft.description.trim(),
                baseRevision: current.revision, contentTag: current.contentTag, requestId: uid()
            });
            delete linkDrafts[current.id];
            acceptSnapshot(result.snapshot);
            announce(t('saved'));
        } catch (error) {
            draft.error = error.key || error.message || 'storage';
            const message = form.querySelector('.link-error');
            message.textContent = errorText(error);
            message.hidden = false;
            form.querySelector('[type=submit]').disabled = false;
        } finally {
            draft.saving = false;
        }
    });
}

function noteLinkDialog() {
    if (!noteEditor) return;
    const editor = noteEditor, link = editor.link();
    showDialog('link', `<div class="field"><label for="note-link-url">URL</label><input id="note-link-url" name="url" type="text" inputmode="url" value="${esc(link.url)}" placeholder="${esc(t('url'))}"></div>${link.text ? '' : `<div class="field"><label for="note-link-text">${esc(t('title'))}</label><input id="note-link-text" name="text"></div>`}${footer('apply')}`, async form => {
        const url = String(form.get('url')).trim();
        if (url && !safeUrl(url)) throw Error('invalidUrl');
        closeDialog();
        editor.setLink(url, String(form.get('text') || ''));
    });
}

function newDraft(e, n = null) {
    return {
        body: n?.body || '',
        signature: '',
        images: [],
        existingImages: n?.images || [],
        status: '',
        requestId: uid(),
        baseRevision: e.revision,
        contentTag: e.contentTag,
        open: true,
        noteId: n?.id || null
    };
}


function renderComposer() {
    noteEditor?.destroy();
    noteEditor = null;
    const e = exhibit(),
        d = drafts[e.id];
    if (!d) return;
    if (d.readOnly) {
        $('#composer-slot').innerHTML = button('continueEdit', 'resumeNote', 'quiet');
        return;
    }
    const active = d.open || Boolean(d.body || d.images.length || d.noteId);
    $('#composer-slot').innerHTML = `
        <form class="composer ${active ? 'composing' : ''}" id="note-form" novalidate>
            ${d.noteId ? `<div class="composer-correction row between">${button('backToNote', 'backToNote', 'quiet')}${button('cancel', 'discardDraft', 'quiet')}</div>` : ''}
            <div id="note-editor" class="note-body"></div>
            <div class="composer-expanded" ${active ? '' : 'hidden'}>
                <div class="attachments">
                    ${d.existingImages.map(id => `<div class="attachment"><img src="api.php?action=asset&kind=image&id=${encodeURIComponent(id)}" alt="${esc(t('image'))}"><button type="button" data-remove-existing="${esc(id)}" aria-label="${esc(t('remove'))}">×</button></div>`).join('')}
                    ${d.images.map((im, i) => `<div class="attachment"><img src="${esc(im.data)}" alt="${esc(im.name)}"><button type="button" data-remove-image="${i}" aria-label="${esc(t('remove'))}">×</button></div>`).join('')}
                </div>
                <div class="composer-tools" ${d.signing ? 'hidden' : ''}>
                    <div class="toolbar">
                        ${[['bold', '<strong>B</strong>'], ['italic', '<em>I</em>'], ['heading', 'H'], ['list', '1.'], ['link', '↗']].map(([key, icon]) => `<button type="button" class="icon-button" data-format="${key}" aria-label="${esc(t(key === 'list' ? 'numberedList' : key))}" title="${esc(t(key === 'list' ? 'numberedList' : key))}">${icon}</button>`).join('')}
                        <button type="button" class="icon-button photo-button" id="add-note-image" aria-label="${esc(t('photo'))}" title="${esc(t('photoHint'))}"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8" cy="9" r="1.5"/><path d="m4 18 6-6 4 4 3-3 4 5"/></svg></button>
                        <input type="file" id="note-image" hidden accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple>
                    </div>
                    <button class="primary post-button" type="submit">${esc(t(d.saving ? 'saving' : 'postShort'))}</button>
                </div>
                <div class="composer-secondary" ${d.signing ? 'hidden' : ''}>
                    <span class="draft-label" title="${esc(t('draftScope'))}">${esc(t('draftShort'))}</span>
                    <details class="note-options"><summary class="icon-button" title="${esc(t('more'))}" aria-label="${esc(t('more'))}">···</summary><div class="popover">${d.noteId ? '' : `<label for="note-status">${esc(t('status'))}</label><select id="note-status">${statusOptions(d.status, true)}</select>`}${button('discardDraft', 'discardDraft', 'quiet danger')}</div></details>
                </div>
            </div>
            ${d.readingImages ? `<p class="muted small" role="status">${esc(t('addingImages'))}</p>` : ''}
            ${d.signing ? `
                <div class="signature-step">
                    <label for="note-signature">${esc(t('signature'))}</label>
                    <input id="note-signature" autocomplete="off" maxlength="120" value="${esc(d.signature)}" aria-describedby="note-error" placeholder="${esc(t('yourName'))}">
                    <div class="row signature-actions">${button('cancel', 'cancelSignature', 'quiet')}<button type="button" class="primary" data-action="confirmNote" ${d.saving || !d.signature.trim() ? 'disabled' : ''}>${esc(t(d.saving ? 'saving' : 'publish'))}</button></div>
                </div>` : ''}
            <div id="note-error" class="error" role="alert" ${d.error ? '' : 'hidden'}>${d.error ? esc(t(d.error)) : ''}</div>
            ${d.conflict ? button('reviewConflict', 'noteConflict', 'quiet') : ''}
        </form>`;
    const form = $('#note-form');
    let choosingImage = false;
    noteEditor = createNoteEditor($('#note-editor'), {
        exhibitId: e.id,
        value: d.body, label: t('noteBody'), placeholder: t('writeNote'), disabled: Boolean(d.saving),
        onChange: value => { d.body = value; delete d.error; persistDrafts(); },
        onFocus: () => {
            d.open = true;
            form.classList.add('composing');
            form.querySelector('.composer-expanded').hidden = false;
        },
        onLink: noteLinkDialog
    });
    form.querySelector('.toolbar').addEventListener('pointerdown', event => {
        if (event.target.closest('[data-format]')) event.preventDefault();
    });
    form.addEventListener('focusout', event => {
        if (!event.relatedTarget || form.contains(event.relatedTarget) || event.relatedTarget.closest('dialog, .selection-menu')) return;
        setTimeout(() => {
            if (!form.isConnected || $('#dialog').open || document.activeElement?.closest('.selection-menu') || form.contains(document.activeElement) || d.body.trim() || d.images.length || d.existingImages.length || d.noteId || d.signing || choosingImage || d.readingImages) return;
            d.open = false;
            delete d.error;
            persistDrafts();
            renderComposer();
        }, 0);
    });
    if (d.saving) form.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = true; });
    $('#note-signature')?.addEventListener('input', ev => {
        d.signature = ev.target.value;
        $('[data-action=confirmNote]').disabled = !d.signature.trim();
        persistDrafts();
    });
    $('#note-signature')?.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            postNote(e.id);
        }
    });
    $('#note-status')?.addEventListener('change', ev => {
        d.status = ev.target.value;
        persistDrafts();
    });
    const fileInput = $('#note-image');
    $('#add-note-image').addEventListener('pointerdown', () => { choosingImage = true; });
    $('#add-note-image').addEventListener('click', () => {
        choosingImage = true;
        fileInput.value = '';
        fileInput.click();
    });
    fileInput.addEventListener('change', event => {
        choosingImage = false;
        const files = [...event.target.files];
        if (files.length) addImages(files, e.id);
        else $('#note-body')?.focus();
    });
    fileInput.addEventListener('cancel', () => {
        choosingImage = false;
        $('#note-body')?.focus();
    });
    form.addEventListener('paste', ev => {
        const files = [...(ev.clipboardData?.files || [])];
        if (files.length) {
            ev.preventDefault();
            addImages(files, e.id);
        }
    });
    form.addEventListener('dragover', ev => ev.preventDefault());
    form.addEventListener('drop', ev => {
        ev.preventDefault();
        d.open = true;
        addImages([...ev.dataTransfer.files], e.id);
    });
    form.addEventListener('submit', ev => {
        ev.preventDefault();
        if (d.readingImages) return;
        if (!d.body.trim() && !d.images.length && !d.existingImages.length) {
            d.error = 'bodyRequired';
            renderComposer();
            $('#note-body').focus();
            return;
        }
        d.signing = true;
        renderComposer();
        $('#note-signature').focus();
        persistDrafts();
    });
}

async function addImages(files, id) {
    const draft = drafts[id];
    if (!draft || draft.saving || draft.readingImages) return;
    draft.open = true;
    draft.readingImages = true;
    delete draft.error;
    const redraw = () => {
        if (drafts[id] === draft && selected === id && tab === 'notes' && !edit && $('#composer-slot')) renderComposer();
    };
    redraw();
    try {
        for (const file of files) {
            if (draft.images.length + draft.existingImages.length >= 8) throw Error('tooManyImages');
            const image = await readNoteImage(file);
            if (drafts[id] !== draft) return;
            draft.images.push({ ...image, id: uid() });
            persistDrafts();
        }
    } catch (error) {
        draft.error = error.message || 'invalidImage';
    } finally {
        draft.readingImages = false;
        persistDrafts();
        redraw();
    }
}
async function postNote(id) {
    const d = drafts[id];
    if (d.saving || d.readingImages) return;
    if (!d.signing) return;
    if (!d.signature.trim()) {
        d.error = 'signatureRequired';
        renderComposer();
        $('#note-signature').focus();
        return;
    }
    if (!d.body.trim() && !d.images.length && !d.existingImages.length) {
        d.error = 'bodyRequired';
        renderComposer();
        $('#note-body').focus();
        return;
    }
    d.saving = true;
    renderComposer();
    const submit = $('#note-form button[type=submit]');
    if (submit) {
        submit.disabled = true;
        submit.textContent = t('saving');
    }
    try {
        const imageIds = [...d.existingImages];
        for (const image of d.images) {
            if (!image.uploaded) {
                const blob = await (await fetch(image.data)).blob();
                const file = new File([blob], image.name, {
                    type: blob.type
                });
                const r = await api.upload(file, 'image', d.signature, image.id, null, id);
                image.uploaded = r.id;
                persistDrafts();
            }
            imageIds.push(image.uploaded);
        }
        const payload = {
            action: d.noteId ? 'correctNote' : 'note',
            exhibitId: id,
            baseRevision: d.baseRevision,
            contentTag: d.contentTag,
            requestId: d.requestId,
            signature: d.signature,
            body: d.body,
            images: imageIds
        };
        if (d.noteId) payload.noteId = d.noteId;
        else if (d.status) payload.status = d.status;
        const result = await api.save(payload);
        delete drafts[id];
        persistDrafts();
        acceptSnapshot(result.snapshot);
        announce(t('saved'));
    } catch (error) {
        d.error = error.key || 'storage';
        d.conflict = error.status === 409;
        persistDrafts();
        if (id === selected) renderComposer();
    } finally {
        d.saving = false;
        if (drafts[id] && id === selected) renderComposer();
    }
}

function acceptSnapshot(value) {
    snapshot = value;
    for (const record of value.exhibits) {
        const draft = drafts[record.id];
        if (draft && !draft.body.trim() && !draft.images.length && !draft.existingImages.length && !draft.noteId) draft.baseRevision = record.revision;
    }
    if (edit) {
        for (const kind of ['exhibits', 'floors'])
            for (const r of edit.value[kind]) {
                const live = value[kind].find(x => x.id === r.id);
                if (live && kind === 'exhibits') {
                    for (const k of ['notes', 'links']) r[k] = structuredClone(live[k]);
                    const base = edit.base.exhibits.find(x => x.id === r.id);
                    if (r.status === base?.status) {
                        r.status = live.status;
                        r.statusBy = live.statusBy;
                    }
                }
            }
    }
    render();
}

function renderMobile() {
    $('#mobile-nav').innerHTML = ['list', 'map', 'detail'].map(key => button(key === 'list' ? 'exhibits' : key, 'view:' + key, view === key ? 'active' : '', `aria-current="${view===key?'page':'false'}" ${key === 'detail' && !exhibit() && !edit ? 'disabled' : ''}`)).join('');
}

function renderEditBar() {
    const el = $('#editbar');
    el.hidden = !edit;
    if (!edit) return;
    const count = edit.changes().length;
    el.innerHTML = `<span class="edit-label">${esc(t('editContext'))} · ${count}</span><div class="row">${button('undo', 'undo', '', edit.undoStack.length ? '' : 'disabled')}${button('redo', 'redo', '', edit.redoStack.length ? '' : 'disabled')}${button('saveExit', 'saveExit', 'primary')}</div>`;
}

function renderEditInspector() {
    const record = exhibit();
    $('#inspector').innerHTML = `<div class="inspector-header"><p class="edit-context">${esc(t('editContext'))}</p><h1>${esc(record ? displayName(record) : t('newExhibit'))}</h1></div><div class="panel-content" id="structure-panel">
        <div class="spatial-tools">
            <label for="gizmo">${esc(t('gizmo'))}</label><select id="gizmo">${options([['', t('gizmo')], ['translate', t('move')], ['rotate', t('rotate')], ['scale', t('scaleTool')]], gizmo)}</select>
            <div class="row"><label class="check"><input type="checkbox" id="snap" ${snap ? 'checked' : ''}>${esc(t('snap'))}</label><select id="axis" aria-label="${esc(t('axis'))}">${options([['', t('allAxes')], ['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], axisConstraint)}</select></div>
        </div>
        <div id="structure-slot"></div>
        <div class="edit-resources"><div class="row">${button('editFloor', 'editFloor', 'quiet')}${button('newFloor', 'newFloor', 'quiet')}${button('models', 'models', 'quiet')}</div></div>
    </div>`;
    $('#axis').addEventListener('change', e => {
        axisConstraint = e.target.value;
        map?.setAxis(axisConstraint);
    });
    $('#gizmo').addEventListener('change', e => {
        gizmo = e.target.value;
        map?.setTool(gizmo, snap);
    });
    $('#snap').addEventListener('change', e => {
        snap = e.target.checked;
        map?.setTool(gizmo, snap);
    });
    if (record) structureDialog('exhibits');
    else $('#structure-slot').innerHTML = button('newExhibit', 'newExhibit', 'primary');
}

function render() {
    document.body.classList.toggle('editing', Boolean(edit));
    renderHeader();
    if (!snapshot) return;
    if (!data().floors.some(f => f.id === floorId)) floorId = data().floors[0]?.id;
    if (!data().exhibits.some(e => e.id === selected)) selected = null;
    renderSidebar();
    renderInspector();
    renderMapUI();
    renderEditBar();
    renderMobile();
    updateMap();
    $('#resizer').setAttribute('aria-label', t('resize'));
    document.documentElement.lang = lang();
}

function closeDialog() {
    dialogCleanup?.();
    dialogCleanup = null;
    $('#dialog').close();
    $('#dialog').innerHTML = '';
}

function showDialog(title, html, onSubmit = null) {
    closeDialog();
    const dialog = $('#dialog');
    dialog.innerHTML = `<div class="dialog-header"><h2>${esc(t(title))}</h2><button type="button" data-action="closeDialog" class="quiet" aria-label="${esc(t('close'))}">×</button></div><form class="dialog-body" id="dialog-form" novalidate>${html}<div id="dialog-error" class="error" role="alert" hidden></div></form>`;
    if (onSubmit) $('#dialog-form').addEventListener('submit', async e => {
        e.preventDefault();
        const submit = e.submitter;
        if (submit?.disabled) return;
        try {
            if (submit) submit.disabled = true;
            await onSubmit(new FormData(e.target), e.target);
        } catch (error) {
            const err = $('#dialog-error');
            if (err) {
                err.textContent = errorText(error);
                err.hidden = false;
            }
        } finally {
            if (submit?.isConnected) submit.disabled = false;
        }
    });
    dialog.showModal();
    return dialog;
}
const signatureField = () => `<div class="field"><label for="signature">${esc(t('signature'))}</label><input id="signature" name="signature" autocomplete="off" maxlength="120" required><p class="small muted">${esc(t('signatureHint'))}</p></div>`;
const footer = (key = 'save') => `<div class="dialog-footer">${button('cancel','closeDialog')}<button type="submit" class="primary">${esc(t(key))}</button></div>`;

function requireSignature(form) {
    const value = String(form.get('signature') || '').trim();
    if (!value) {
        $('#signature')?.focus();
        throw Error('signatureRequired');
    }
    return value;
}

function statusDialog(chosenStatus = exhibit().status) {
    const e = structuredClone(exhibit()),
        requestId = uid();
    showDialog('changeStatus', `<p style="margin-bottom:18px">${esc(e.name)}</p><p class="chosen-status">${statusHTML(chosenStatus)}</p>${signatureField()}${footer()}`, async form => {
        const signature = requireSignature(form);
        const result = await api.save({
            action: 'status',
            exhibitId: e.id,
            baseRevision: e.revision,
            requestId,
            signature,
            status: chosenStatus
        });
        closeDialog();
        acceptSnapshot(result.snapshot);
        announce(t('saved'));
    });
}

function editLink(id = null) {
    const record = exhibit();
    const link = record.links.find(item => item.id === id);
    if (id && !link) return;
    linkDrafts[record.id] = { open: true, id, title: link?.title || '', url: link?.url || '', description: link?.description || '' };
    renderPanel();
    $('#link-title')?.focus();
}

function deleteLink(id) {
    const record = exhibit();
    const link = record.links.find(item => item.id === id);
    if (!link) return;
    showDialog('remove', `<p>${esc(link.title)}</p>${footer('remove')}`, async () => {
        const result = await api.save({
            action: 'deleteLink', exhibitId: record.id, linkId: id,
            baseRevision: record.revision, contentTag: record.contentTag, requestId: uid()
        });
        closeDialog();
        acceptSnapshot(result.snapshot);
        announce(t('saved'));
    });
}

function enterEdit() {
    if (edit) return;
    edit = new EditSession(snapshot);
    persistEdit();
    render();
}

function changed() {
    persistEdit();
    render();
    map?.setTool(gizmo, snap);
    map?.setAxis(axisConstraint);
}

function vectorFields(transform, attributes = '') {
    return ['position', 'rotation', 'scale'].map(key => `
        <div class="vector"><h3>${esc(t(key))}</h3><div class="grid3">
            ${['X', 'Y', 'Z'].map((axis, index) => `<div><label>${axis}<input type="number" step="any" data-vector="${key}" data-axis="${index}" ${attributes} value="${Number(transform[key][index].toFixed(4))}"></label></div>`).join('')}
        </div></div>`).join('');
}

function structureDialog(kind, isNew = false) {
    if (!edit) return;
    const isFloor = kind === 'floors';
    const source = isFloor ? floor() : exhibit();
    if (!source && !isNew) return;
    const record = isNew ? (isFloor ? {
        id: '', names: { de: '', en: '' }, order: 0, modelId: null,
        transform: identity(), views: {}, revision: null
    } : {
        id: '', name: '', floorId: floorId || null, status: 'ok',
        transform: identity(), models: [], views: {}, revision: null,
        notes: [], links: [], placed: false
    }) : structuredClone(source);
    const hardware = data().assets.filter(asset => asset.kind === 'hardware');
    if (isNew && !isFloor) {
        $('#inspector h1').textContent = t('newExhibit');
        map?.setTool('');
    }
    const presets = `<div class="view-presets"><h3>${esc(t('defaultViews'))}</h3>${['top', 'three'].map(key => `
        <div class="row"><span>${esc(t(key === 'top' ? 'view2D' : 'view3D'))}</span>
            <button type="button" class="quiet" ${isFloor ? 'data-floor-view' : 'data-capture-exhibit'}="${key}">${esc(t('useCurrentView'))}</button>
            <button type="button" class="icon-button" ${isFloor ? 'data-clear-floor-view' : 'data-clear-view'}="${key}" aria-label="${esc(t('automatic'))}" title="${esc(record.views?.[key] ? t('automatic') : t('viewFallback'))}">×</button>
        </div>`).join('')}</div>`;
    const content = isFloor ? `
        <div class="field"><label for="floor-number">${esc(t('floorNumber'))}</label><input id="floor-number" name="floorNumber" type="number" step="1" value="${esc(record.id)}" ${isNew ? '' : 'readonly'}></div>
        <div class="grid2"><div class="field"><label for="floor-name-de">${esc(t('nameDe'))}</label><input id="floor-name-de" name="nameDe" value="${esc(record.names.de)}"></div><div class="field"><label for="floor-name-en">${esc(t('nameEn'))}</label><input id="floor-name-en" name="nameEn" value="${esc(record.names.en)}"></div></div>
        ${presets}${footer('apply')}` : `
        <div class="field"><label for="ex-name">${esc(t('name'))}</label><input id="ex-name" name="name" maxlength="160" value="${esc(record.name)}" ${isNew ? '' : `readonly title="${esc(t('folderNameHint'))}"`}></div>
        <div class="grid2"><div class="field"><label for="ex-floor">${esc(t('floor'))}</label><select id="ex-floor" name="floorId">${options([['', t('noFloor')], ...data().floors.map(item => [item.id, item.names[lang()]])], record.floorId || '')}</select></div><div class="field"><label for="initial-status">${esc(t('status'))}</label><select id="initial-status" name="status">${statusOptions(record.status)}</select></div></div>
        <div class="instance-heading row between"><h3>${esc(t('modelInstances'))}</h3><button type="button" class="icon-button" data-add-instance title="${esc(t('addModel'))}" aria-label="${esc(t('addModel'))}" ${hardware.length ? '' : 'disabled'}>+</button></div>
        <div id="instance-list"></div>
        <details class="exhibit-transform"><summary>${esc(t('exhibitTransform'))}</summary>${vectorFields(record.transform, 'data-group-vector')}</details>
        ${presets}
        <div class="dialog-footer">${button('duplicate', 'duplicateExhibit', 'quiet', isNew ? 'disabled' : '')}${button('cancel', 'cancelStructure', 'quiet')}<button type="submit" class="primary">${esc(t('apply'))}</button></div>
        ${isNew ? '' : `<button type="button" class="quiet danger" data-delete-current ${record.notes.length || record.links.length ? `disabled title="${esc(t('notEmpty'))}"` : ''}>${esc(t('deleteExhibit'))}</button>`}`;
    const formRoot = showStructureForm(kind, isNew ? (isFloor ? 'newFloor' : 'newExhibit') : (isFloor ? 'editFloor' : 'editExhibit'), content, async form => {
        if (isFloor) {
            const number = String(form.get('floorNumber')).trim();
            if (!/^(0|-?[1-9][0-9]*)$/.test(number)) throw Error('invalidFloor');
            if (isNew && data().floors.some(item => item.id === number)) throw Error('duplicateName');
            record.id = number;
            record.order = Number(number);
            record.names = { de: String(form.get('nameDe')).trim() || number, en: String(form.get('nameEn')).trim() || number };
        } else {
            record.name = String(form.get('name')).trim();
            if (!record.name || /[<>:"/\\|?*\x00-\x1f]/.test(record.name) || /^[.]/.test(record.name) || /[. ]$/.test(record.name)) throw Error('invalidInput');
            if (isNew && data().exhibits.some(item => item.id === record.name)) throw Error('duplicateName');
            record.id = record.name;
            record.floorId = form.get('floorId') || null;
            record.status = form.get('status');
            record.placed = Boolean(record.floorId && record.models.length);
            if (record.models.length && !record.floorId) throw Error('invalidFloor');
            new MapPlacement(record.transform);
            record.models.forEach(instance => new MapPlacement(instance.transform));
        }
        const previous = data()[kind].find(item => item.id === record.id);
        if (previous && JSON.stringify(structural(previous, kind)) === JSON.stringify(structural(record, kind))) {
            if (isFloor) closeDialog();
            return;
        }
        edit.change(state => {
            const index = state[kind].findIndex(item => item.id === record.id);
            if (index < 0) state[kind].push(structuredClone(record));
            else state[kind][index] = structuredClone(record);
        });
        if (isFloor) floorId = record.id;
        else {
            selected = record.id;
            if (record.floorId) floorId = record.floorId;
        }
        if (isFloor) closeDialog();
        changed();
    });
    if (isFloor) {
        formRoot.querySelectorAll('[data-floor-view], [data-clear-floor-view]').forEach(control => control.addEventListener('click', async () => {
            const key = control.dataset.floorView || control.dataset.clearFloorView;
            if (control.dataset.clearFloorView) delete record.views[key];
            else {
                await ensureMap();
                if (!map || record.id !== floorId) { announce(t('viewFloorMismatch')); return; }
                record.views[key] = map.captureView(key === 'top' ? 'top' : mapMode === 'top' ? 'perspective' : mapMode);
                announce(t('viewCaptured'));
            }
        }));
        return;
    }
    const list = formRoot.querySelector('#instance-list');
    const renderInstances = () => {
        list.innerHTML = record.models.length ? record.models.map((instance, index) => `
            <div class="model-instance ${index === activeInstance ? 'active' : ''}">
                <div class="row"><button type="button" class="icon-button" data-active-instance="${index}" title="${esc(t('selectModel'))}" aria-label="${esc(t('selectModel'))}" aria-pressed="${index === activeInstance}">⌖</button>
                    <select data-instance-model="${index}" aria-label="${esc(t('model'))}">${options(hardware.map(asset => [asset.id, asset.name]), instance.model)}</select>
                    <button type="button" class="icon-button" data-remove-instance="${index}" aria-label="${esc(t('remove'))}">×</button></div>
                <details ${index === activeInstance ? 'open' : ''}><summary>${esc(t('placement'))}</summary>${vectorFields(instance.transform, `data-instance="${index}"`)}</details>
            </div>`).join('') : `<p class="small muted">${esc(t('noModel'))}</p>`;
    };
    const updateVector = input => {
        const target = input.hasAttribute('data-group-vector') ? record.transform : record.models[Number(input.dataset.instance)]?.transform;
        if (!target) return;
        const key = input.dataset.vector, axis = Number(input.dataset.axis);
        let value = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(value) || key === 'scale' && value <= 0) {
            input.value = target[key][axis];
            return;
        }
        if (snap && key === 'position') value = Math.round(value);
        if (snap && key === 'rotation') value = Math.round(value / 15) * 15;
        target[key][axis] = value;
    };
    formRoot.addEventListener('change', event => {
        const input = event.target;
        if (input.dataset.vector) updateVector(input);
        if (input.dataset.instanceModel !== undefined) record.models[Number(input.dataset.instanceModel)].model = input.value;
    });
    formRoot.querySelector('[data-add-instance]').addEventListener('click', () => {
        record.models.push({ model: hardware[0].id, transform: identity() });
        activeInstance = record.models.length - 1;
        renderInstances();
    });
    list.addEventListener('click', async event => {
        const remove = event.target.closest('[data-remove-instance]');
        if (remove) {
            record.models.splice(Number(remove.dataset.removeInstance), 1);
            activeInstance = Math.max(0, Math.min(activeInstance, record.models.length - 1));
            renderInstances();
        }
        const activate = event.target.closest('[data-active-instance]');
        if (activate) {
            activeInstance = Number(activate.dataset.activeInstance);
            if (submitStructure && !await submitStructure()) return;
            map?.setActiveInstance(activeInstance);
        }
    });
    formRoot.querySelector('[data-delete-current]')?.addEventListener('click', () => removeExhibit(record.id));
    renderInstances();
    map?.setActiveInstance(activeInstance);
}

async function saveExit() {
    if (!edit) return;
    if (submitStructure && $('#structure-form') && !await submitStructure()) return;
    const changes = edit.changes();
    if (!changes.length) {
        edit = null;
        persistEdit();
        render();
        return;
    }
    const requestId = uid();
    const items = changes.map(change => {
        const record = change.record || edit.base.exhibits.find(e => e.id === change.id) || edit.value.exhibits.find(e => e.id === change.id) || {};
        const old = edit.base[change.kind].find(e => e.id === change.id);
        const detail = JSON.stringify({
            before: old ? structural(old, change.kind) : null,
            after: change.record || change.op
        }, null, 2);
        return `<li><strong>${esc(record.name || record.names?.[lang()] || change.id)}</strong> · ${esc(t(change.op))}
            <details><summary>${esc(t('changes'))}</summary><pre class="diff">${esc(detail)}</pre></details></li>`;
    }).join('');
    const content = `
        <ul class="change-list">${items}</ul>
        ${signatureField()}
        <div class="dialog-footer">
            ${button('discard', 'discard', 'danger')}
            ${button('continueEdit', 'closeDialog')}
            <button type="submit" id="sign-save" class="primary" disabled>${esc(t('signSave'))}</button>
        </div>`;
    showDialog('review', content, async form => {
        const signature = requireSignature(form);
        try {
            const result = await api.save({
                action: 'structure',
                baseRevision: edit.base.structureRevision,
                requestId,
                signature,
                changes
            });
            edit = null;
            persistEdit();
            closeDialog();
            acceptSnapshot(result.snapshot);
            announce(t('saved'));
        } catch (error) {
            if (error.status === 409) {
                const field = $('#dialog-error');
                field.innerHTML = esc(t('conflict')) + '<br>' + button('reviewConflict', 'structureConflict');
                field.hidden = false;
                return;
            }
            throw error;
        }
    });
    $('#signature').addEventListener('input', e => {
        $('#sign-save').disabled = !e.target.value.trim();
    });
}

async function modelsDialog() {
    const rows = data().assets.filter(asset => asset.kind === 'hardware').map(asset => {
        return `<div class="model-row">
            <div class="model-text"><strong>${esc(asset.name)}</strong><p>${esc(asset.file)}</p><p>${esc(asset.source || 'GLB')}</p></div>
            <button type="button" data-preview-model="${esc(asset.id)}">${esc(t('preview'))}</button>
        </div>`;
    }).join('');
    showDialog('models', `
        <p class="muted small" style="margin-bottom:16px">${esc(t('modelHint'))}</p>
        <div class="model-grid">${rows}</div>
        <div class="field" style="margin-top:24px"><label for="model-file">${esc(t('uploadModel'))}</label><input type="file" name="model" id="model-file" accept=".glb,model/gltf-binary"></div>
        ${footer('uploadModel')}`, async form => {
        const file = form.get('model');
        if (!file?.size) throw Error('invalidModel');
        if (file.size > 32 * 1024 * 1024) throw Error('fileTooLarge');
        const { inspectModel } = await import('./map.js');
        const dimensions = await inspectModel(file);
        await api.upload(file, 'model', '', uid(), dimensions);
        const live = await api.load();
        snapshot = live;
        if (edit) {
            edit.value.assets = structuredClone(live.assets);
            edit.base.assets = structuredClone(live.assets);
        }
        closeDialog();
        render();
        announce(t('saved'));
    });
}

async function modelPreview(id) {
    const asset = data().assets.find(a => a.id === id);
    showDialog('modelPreview', `<h3>${esc(asset.name)}</h3><div class="preview-stage" id="asset-preview" style="margin-top:15px"></div><p id="preview-error" role="status"></p><div class="dialog-footer">${button('models', 'models')}</div>`);
    try {
        const { MapView } = await import('./map.js');
        const preview = new MapView($('#asset-preview'));
        dialogCleanup = () => preview.destroy();
        await preview.init();
        await preview.preview(asset);
    } catch {
        if ($('#preview-error')) $('#preview-error').textContent = t('mapUnavailable');
    }
}

async function noteConflict() {
    const id = selected, draft = drafts[id];
    const live = await api.load();
    const current = live.exhibits.find(e => e.id === id);
    if (!current) throw Error('notFound');
    const history = current.notes.slice(0, 4).map(n => n.author + ': ' + n.body).join('\n\n');
    showDialog('reviewConflict', `
        <h3>${esc(t('current'))}</h3><div class="diff">${esc(history)}</div>
        <h3 style="margin-top:20px">${esc(t('yours'))}</h3><div class="diff">${esc(draft.body)}</div>
        ${footer('rebase')}`, async () => {
        snapshot = live;
        draft.baseRevision = current.revision;
        draft.contentTag = current.contentTag;
        draft.requestId = uid();
        delete draft.conflict;
        delete draft.error;
        persistDrafts();
        closeDialog();
        render();
    });
}

async function structureConflict() {
    const changes = edit.changes(), live = await api.load();
    const savedValue = structuredClone(edit.value);
    const current = JSON.stringify(changes.map(c => live[c.kind].find(x => x.id === c.id) || null), null, 2);
    showDialog('reviewConflict', `
        <p class="small muted">${esc(t('conflict'))}</p>
        <h3 style="margin-top:16px">${esc(t('current'))}</h3><pre class="diff">${esc(current)}</pre>
        <h3>${esc(t('yours'))}</h3><pre class="diff">${esc(JSON.stringify(changes, null, 2))}</pre>
        ${footer('rebase')}`, async () => {
        const next = new EditSession(live);
        next.change(state => {
            for (const change of changes) {
                if (change.op === 'put') {
                    const old = state[change.kind].find(x => x.id === change.id);
                    const desired = savedValue[change.kind].find(x => x.id === change.id);
                    const merged = { ...(old || desired), ...change.record };
                    const index = state[change.kind].findIndex(x => x.id === change.id);
                    if (index < 0) state[change.kind].push(merged);
                    else state[change.kind][index] = merged;
                } else if (change.op === 'delete') {
                    state[change.kind] = state[change.kind].filter(e => e.id !== change.id);

                }
            }
        });
        snapshot = live;
        edit = next;
        persistEdit();
        closeDialog();
        render();
        saveExit();
    });
}

async function refresh() {
    try {
        acceptSnapshot(await api.load());
    } catch (error) {
        announce(errorText(error));
    }
}

async function refreshFromFiles() {
    if (document.hidden || edit || $('#dialog').open || document.activeElement?.closest('#note-form, #link-form, #link-search')) return;
    try {
        const current = await api.load();
        const stamp = value => JSON.stringify([value.revision, value.structureRevision, value.exhibits.map(item => [item.id, item.revision, item.contentTag])]);
        if (!snapshot || stamp(current) !== stamp(snapshot)) acceptSnapshot(current);
    } catch {
        // A later refresh can read the files after an external editor finishes saving.
    }
}

setInterval(refreshFromFiles, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshFromFiles(); });

function recoverDraft() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(editStorageKey) || 'null'); } catch {}
    if (!saved) return;
    showDialog('draftRecover', `<p>${esc(t('draft'))}</p><div class="dialog-footer">${button('discard', 'forgetEditDraft')}<button type="submit" class="primary">${esc(t('recover'))}</button></div>`, async () => {
        edit = new EditSession(saved.base);
        saved.value.exhibits.forEach(record => { record.status = normalizeStatus(record.status); });
        edit.value = saved.value;
        closeDialog();
        render();
    });
}

const actions = {
    refresh,
    enterEdit,
    resumeNote: () => { drafts[selected].readOnly = false; renderPanel(); },
    backToNote: () => { drafts[selected].readOnly = true; persistDrafts(); renderPanel(); },
    discardDraft: () => { delete drafts[selected]; persistDrafts(); renderPanel(); },
    cancelStructure: () => renderEditInspector(),
    duplicateExhibit: () => {
        if (!edit || !exhibit()) return;
        const copy = structuredClone(exhibit());
        const originalName = copy.name;
        let number = 2;
        while (data().exhibits.some(item => item.id === originalName + ' (' + number + ')')) number++;
        copy.name = originalName + ' (' + number + ')';
        copy.id = copy.name;
        copy.transform.position[0] += 2;
        copy.notes = [];
        copy.links = [];
        copy.revision = 0;
        edit.change(state => state.exhibits.push(copy));
        selected = copy.id;
        changed();
    },
    cancelSignature: () => {
        drafts[selected].signing = false;
        persistDrafts();
        renderComposer();
    },
    confirmNote: () => postNote(selected),
    closeComposer: () => {
        drafts[selected].open = false;
        drafts[selected].signing = false;
        persistDrafts();
        renderComposer();
    },
    noteConflict,
    status: statusDialog,
    addLink: () => editLink(),
    cancelLink: () => {
        delete linkDrafts[selected];
        renderPanel();
    },
    closeDialog,
    clear: () => {
        query = '';
        floorFilter = '';
        statusFilter = '';
        scope = 'nameFloor';
        renderSidebar();
    },
    focus: async () => {
        if (!exhibit()?.placed) { announce(t('unplaced')); return; }
        await ensureMap();
        map?.focus();
        setView('map');
        },
    editExhibit: () => structureDialog('exhibits'),
    editFloor: () => structureDialog('floors'),
    newExhibit: () => { setView('detail'); structureDialog('exhibits', true); },
    newFloor: () => structureDialog('floors', true),
    undo: () => { edit?.undo(); changed(); },
    redo: () => { edit?.redo(); changed(); },
    saveExit,
    models: modelsDialog,
    discard: () => { edit = null; persistEdit(); closeDialog(); render(); },
    forgetEditDraft: () => { localStorage.removeItem(editStorageKey); closeDialog(); },
    structureConflict
};

document.addEventListener('click', async event => {
    const element = event.target.closest('button,[data-select]');
    if (!element) return;
    try {
        if (element.dataset.floor) { changeFloor(element.dataset.floor); return; }
        if (element.dataset.trashExhibit) { removeExhibit(element.dataset.trashExhibit); return; }
        if (element.dataset.deleteNote) { deleteNoteDialog(element.dataset.deleteNote); return; }
        if (element.dataset.language) { setLanguage(element.dataset.language); render(); return; }
        if (element.dataset.select) { select(element.dataset.select); return; }
        if (element.dataset.tab) { collapseEmptyDraft(); tab = element.dataset.tab; renderInspector(); return; }
        if (element.dataset.correct) {
            const record = exhibit();
            if (drafts[record.id]?.body || drafts[record.id]?.images.length) {
                drafts[record.id].open = true;
                renderComposer();
                announce(t('draft'));
                return;
            }
            const note = record.notes.find(n => n.id === element.dataset.correct);
            if (!note || note.deleted) return;
            drafts[record.id] = newDraft(record, note);
            persistDrafts();
            renderPanel();
            $('#note-body').focus();
            return;
        }
        if (element.dataset.editLink) { editLink(element.dataset.editLink); return; }
        if (element.dataset.deleteLink) { deleteLink(element.dataset.deleteLink); return; }
        if (element.dataset.copy) {
            const link = exhibit().links.find(l => l.id === element.dataset.copy);
            try { await navigator.clipboard.writeText(link.url); announce(t('copied')); }
            catch { announce(t('copyFailed')); }
            return;
        }
        if (element.dataset.removeImage !== undefined) {
            drafts[selected].images.splice(Number(element.dataset.removeImage), 1);
            persistDrafts(); renderComposer(); return;
        }
        if (element.dataset.removeExisting) {
            drafts[selected].existingImages = drafts[selected].existingImages.filter(id => id !== element.dataset.removeExisting);
            persistDrafts(); renderComposer(); return;
        }
        if (element.dataset.captureExhibit || element.dataset.clearView) {
            const key = element.dataset.captureExhibit || element.dataset.clearView;
            if (submitStructure && !await submitStructure()) return;
            await ensureMap();
            if (!map) throw Error('mapUnavailable');
            const preset = map.captureView(key === 'top' ? 'top' : mapMode === 'top' ? 'perspective' : mapMode);
            edit.change(state => {
                const record = state.exhibits.find(e => e.id === selected);
                record.views ||= {};
                if (element.dataset.clearView) delete record.views[key];
                else record.views[key] = preset;
            });
            changed();
            return;
        }
        if (element.dataset.format) {
            if (element.dataset.format === 'link') noteLinkDialog();
            else noteEditor?.command(element.dataset.format);
            return;
        }
        if (element.dataset.previewModel) { await modelPreview(element.dataset.previewModel); return; }
        const action = element.dataset.action;
        if (action?.startsWith('view:')) { setView(action.split(':')[1]); return; }
        if (action?.startsWith('camera:')) {
            const command = action.split(':')[1];
            if (['iso', 'top', 'perspective'].includes(command)) mapMode = command;
            map?.command(command);
            syncUrl();
            renderMapUI();
            return;
        }
        if (actions[action]) await actions[action]();
    } catch (error) { announce(errorText(error)); }
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('#dialog').open && !event.target.closest('input, textarea, [contenteditable], .status-picker, .selection-menu')) select(null);
    if (event.target.matches('[data-select]') && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        select(event.target.dataset.select);
    }
});

$('#dialog').addEventListener('cancel', () => { dialogCleanup?.(); dialogCleanup = null; });
new ResizeObserver(() => {
    document.documentElement.style.setProperty('--editbar-height', $('#editbar').offsetHeight + 'px');
}).observe($('#editbar'));
const resizer = $('#resizer');
new ResizeObserver(() => {
    if (innerWidth < 861) return;
    resizer.setAttribute('aria-valuemin', '320');
    resizer.setAttribute('aria-valuemax', Math.round(innerWidth * .6));
    resizer.setAttribute('aria-valuenow', $('#inspector').clientWidth);
}).observe($('#inspector'));
let resizeStart = null;
function resizeInspector(value) {
    const width = Math.max(320, Math.min(innerWidth * .6, value));
    document.documentElement.style.setProperty('--reader', width + 'px');
}
resizer.addEventListener('pointerdown', event => {
    event.preventDefault();
    getSelection()?.removeAllRanges();
    resizeStart = { x: event.clientX, width: $('#inspector').clientWidth };
    resizer.setPointerCapture(event.pointerId);
    resizer.focus({ preventScroll: true });
    document.body.classList.add('resizing');
});
resizer.addEventListener('pointermove', event => {
    if (!resizeStart || !resizer.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    getSelection()?.removeAllRanges();
    resizeInspector(resizeStart.width + resizeStart.x - event.clientX);
});
const endResize = event => {
    if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
    resizeStart = null;
    document.body.classList.remove('resizing');
};
resizer.addEventListener('pointerup', endResize);
resizer.addEventListener('pointercancel', endResize);
resizer.addEventListener('lostpointercapture', () => {
    resizeStart = null;
    document.body.classList.remove('resizing');
});
resizer.addEventListener('dragstart', event => event.preventDefault());
resizer.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const width = $('#inspector').clientWidth + (event.key === 'ArrowLeft' ? 24 : -24);
    resizeInspector(width);
});
window.addEventListener('beforeunload', event => {
    persistDrafts(); persistEdit();
    if (edit?.changes().length) { event.preventDefault(); event.returnValue = ''; }
});
setView('list');
renderHeader();
$('#sidebar').innerHTML = '<p>' + esc(t('loading')) + '</p>';
try {
    snapshot = await api.load();
    loadDrafts();
    if (!snapshot.exhibits.some(e => e.id === selected)) selected = snapshot.exhibits[0]?.id || null;
    const params = new URLSearchParams(location.search);
    const requestedFloor = snapshot.floors.find(f => f.id === params.get('floor'));
    const requestedExhibit = snapshot.exhibits.find(e => e.id === params.get('exhibit') && (!requestedFloor || e.floorId === requestedFloor.id));
    floorId = requestedFloor?.id || requestedExhibit?.floorId || exhibit()?.floorId || snapshot.floors[0]?.id;
    selected = requestedExhibit?.id || null;
    if (['iso', 'top', 'perspective'].includes(params.get('view'))) mapMode = params.get('view');
    syncUrl();
    render();
    ensureMap();
    recoverDraft();
} catch (error) {
    $('#sidebar').innerHTML = '<div class="error">' + esc(errorText(error)) + '</div>' + button('refresh', 'refresh');
}
