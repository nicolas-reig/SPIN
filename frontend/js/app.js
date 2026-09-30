import {
    Api,
    uid
} from './api.js';
import {
    EditSession,
    identity,
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
import { installSelects, closeMenus } from './select.js';
import { cameraMode } from './camera.js';
import { vectorFields, viewPresets, newExhibit, duplicateExhibit, rebaseEdit } from './edit.js';
import { icon } from './icons.js';
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
    noticeTimer, noticeClearTimer, dialogCleanup = null;
let creation = null, creationOpen = false, editingFloor = null, editConflict = null;
let editSave = null, cancelledEdit = null;
let recoverableEdit = null;
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
for (const [status, value] of Object.entries(STATUS_COLORS)) document.documentElement.style.setProperty('--status-' + status, value);
const statusHTML = status => `<span class="status-badge"><span class="status-symbol ${status}" aria-hidden="true"></span>${esc(t(status))}</span>`;
const button = (label, action, cls = '', extra = '') => `<button type="button" data-action="${action}" class="${cls}" ${extra}>${esc(t(label))}</button>`;
const menuButton = (label, action, name, extra = '') => `<button type="button" data-action="${action}" class="quiet menu-action" ${extra}>${icon(name)}<span>${esc(t(label))}</span></button>`;
const options = (rows, value) => rows.map(([id, label]) => `<option value="${esc(id)}" ${id===value?'selected':''}>${esc(label)}</option>`).join('');
const statusOptions = (value, keep = false) => options([...(keep ? [
    ['', t('keepStatus')]
] : []), ...STATUSES.map(s => [s, t(s)])], value);

function announce(message, action = null, label = 'undo') {
    clearTimeout(noticeTimer);
    clearTimeout(noticeClearTimer);
    const notice = $('#notice');
    notice.classList.remove('is-exiting');
    notice.inert = false;
    notice.innerHTML = `<span>${esc(message)}</span>${action ? button(label, action, 'quiet') : ''}`;
    noticeTimer = setTimeout(dismissNotice, action ? 10000 : 6500);
}

function clearNotice() {
    clearTimeout(noticeClearTimer);
    const notice = $('#notice');
    notice.replaceChildren();
    notice.classList.remove('is-exiting');
    notice.inert = false;
}

function dismissNotice() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        clearNotice();
        return;
    }
    const notice = $('#notice');
    notice.classList.add('is-exiting');
    notice.inert = true;
    noticeClearTimer = setTimeout(clearNotice, 220);
}

$('#notice').addEventListener('animationend', event => {
    if (event.animationName === 'notice-out' && $('#notice').classList.contains('is-exiting')) clearNotice();
});

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
            value: edit.value,
            creation,
            creationOpen,
            editingFloor,
            selected,
            floorId,
            activeInstance,
            gizmo,
            undoStack: edit.undoStack,
            redoStack: edit.redoStack
        }));
        else if (editStorageKey) localStorage.removeItem(editStorageKey);
    } catch {
        announce(t('draftFailed'));
    }
}

function setView(value) {
    if (value === 'detail' && !exhibit() && !(edit && (creationOpen || editingFloor || editConflict?.open))) value = 'map';
    collapseEmptyDraft();
    view = value;
    document.body.dataset.view = value;
    renderMobile();
    map?.resize();
}


function iconButton(label, action, name, extra = '') {
    return `<button type="button" class="icon-button" data-action="${action}" aria-label="${esc(t(label))}" title="${esc(t(label))}" ${extra}>${icon(name)}</button>`;
}

function displayName(record) {
    return record?.name || '';
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
    if (!edit || editSave?.saving) return;
    const record = data().exhibits.find(item => item.id === id);
    if (!record) return;
    if (record.notes.length || record.links.length) { announce(t('notEmpty')); return; }
    showDialog('deleteExhibit', `<p>${esc(record.name)}</p><p class="small muted deletion-hint">${esc(t('deleteOnSave'))}</p>${footer('deleteExhibit')}`, async () => {
        closeDialog();
        map?.cancelTransform();
        applyEdit(state => { state.exhibits = state.exhibits.filter(item => item.id !== id); }, { rebuild: true });
    });
    $('#dialog button[type=submit]').className = 'danger';
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
        <div class="sidebar-title row between"><h2>${esc(t('exhibits'))}</h2>${edit ? iconButton('newExhibit', 'newExhibit', 'plus') : ''}</div>
        <div class="search-row">
            <div class="searchbox">
                ${icon('search', 'search-icon')}
                <input id="search" type="search" value="${esc(query)}" placeholder="${esc(t('searchShort'))}" aria-label="${esc(t('search'))}" autocomplete="off">
            </div>
            <details class="filter-menu">
                <summary class="icon-button ${filtered ? 'active' : ''}" title="${esc(t('filters'))}" aria-label="${esc(t('filters'))}">${icon('funnel')}${filtered ? '<i class="filter-dot"></i>' : ''}</summary>
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
            <span id="filter-description"></span>${iconButton('clear', 'clear', 'x')}
        </div>
        <div class="exhibit-list" id="exhibit-list"></div>
        <div class="sidebar-footer">
            <div class="row between">
                <div class="language" aria-label="${esc(t('language'))}">
                    <button data-language="de" class="${lang() === 'de' ? 'active' : ''}" lang="de" aria-pressed="${lang() === 'de'}">DE</button>
                    <button data-language="en" class="${lang() === 'en' ? 'active' : ''}" lang="en" aria-pressed="${lang() === 'en'}">EN</button>
                </div>
                <details class="app-menu">
                    <summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('ellipsis')}</summary>
                    <div class="popover">
                        ${edit ? (creation ? menuButton('resumeCreation', 'resumeCreation', 'pencil-line') : '') + menuButton('editFloor', 'editFloor', 'layers') + menuButton('newFloor', 'newFloor', 'layers-plus') + menuButton('models', 'models', 'library') : menuButton('editStructure', 'enterEdit', 'pencil-line')}
                        ${menuButton('refresh', 'refresh', 'refresh-cw')}
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
        </button>${edit && e.id === selected ? `<details class="exhibit-options"><summary class="icon-button" aria-label="${esc(t('more') + ': ' + displayName(e))}">${icon('ellipsis')}</summary><div class="popover"><button type="button" data-duplicate-exhibit="${esc(e.id)}">${icon('copy-plus')}<span>${esc(t('duplicate'))}</span></button><button type="button" class="danger" data-trash-exhibit="${esc(e.id)}" ${e.notes.length || e.links.length ? `disabled title="${esc(t('notEmpty'))}"` : ''}>${icon('trash')}<span>${esc(t('deleteExhibit'))}</span></button></div></details>` : ''}</div>`).join('') : `<p class="empty">${esc(t('noResults'))}</p>`;
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
            <div class="view-toggle" role="group" aria-label="${esc(t('cameraView'))}">
                ${['top', 'perspective'].map(mode => `<button type="button" class="icon-button" data-action="camera:${mode}" aria-label="${esc(t(mode))}" title="${esc(t(mode))}" aria-pressed="${mapMode === mode}">${icon(mode === 'top' ? 'grid-2x2' : 'box')}</button>`).join('')}
            </div>
            <span class="toolbar-divider"></span>
            ${iconButton('focus', 'focus', 'crosshair', !selected ? 'disabled' : '')}
            ${iconButton('zoomOut', 'camera:zoomOut', 'minus') + iconButton('zoomIn', 'camera:zoomIn', 'plus')}
            ${edit && exhibit()?.models.length && !creationOpen && !editingFloor && !editConflict?.open ? `<span class="toolbar-divider"></span><div class="transform-controls"><div class="transform-tools" role="group" aria-label="${esc(t('gizmo'))}">${[['translate', 'move', 'G', 'move'], ['rotate', 'rotate', 'R', 'rotate-cw'], ['scale', 'scaleTool', 'S', 'scaling']].map(([tool, label, key, name]) => `<button type="button" class="icon-button" data-tool="${tool}" aria-label="${esc(t(label))}" title="${esc(t(label) + ' (' + key + ')')}" aria-pressed="${gizmo === tool}">${icon(name)}</button>`).join('')}</div><details class="transform-options"><summary class="icon-button" aria-label="${esc(t('placementOptions'))}" title="${esc(t('placementOptions'))}">${icon('sliders-horizontal')}</summary><div class="popover"><label class="check"><input type="checkbox" id="snap" ${snap ? 'checked' : ''}>${esc(t('snap'))}</label><label for="axis">${esc(t('axis'))}</label><select id="axis">${options([['', t('allAxes')], ['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], axisConstraint)}</select></div></details></div>` : ''}
            <details class="camera-menu">
                <summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('ellipsis')}</summary>
                <div class="popover">
                    <div class="camera-actions">${iconButton('fit', 'camera:fit', 'maximize')}${iconButton('rotate', 'camera:rotate', 'rotate-cw', mapMode === 'top' ? 'disabled' : '')}</div>
                    <div class="row camera-pan">${[['panLeft', 'arrow-left'], ['panUp', 'arrow-up'], ['panDown', 'arrow-down'], ['panRight', 'arrow-right']].map(([action, name]) => iconButton(action, 'camera:' + action, name)).join('')}</div>
                    <p class="small muted">${esc(t('mapHelp'))}</p>
                </div>
            </details>
        </div>`;
    $('#snap')?.addEventListener('change', event => { snap = event.target.checked; syncEditTools(); });
    $('#axis')?.addEventListener('change', event => { axisConstraint = event.target.value; syncEditTools(); });
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
                applyEdit(s => {
                    const e = s.exhibits.find(x => x.id === id);
                    if (e?.models[index]) e.models[index].transform = transform;
                });
                updateTransformFields();
            },
            onInvalidTransform: () => announce(t('invalidTransform'))
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
    if (editSave?.saving) return;
    map?.cancelTransform();
    creationOpen = false;
    editingFloor = null;
    if (editConflict) editConflict.open = false;
    collapseEmptyDraft();
    const e = data().exhibits.find(x => x.id === id);
    if (!e) {
        selected = null;
        renderList(); renderInspector(); renderMapUI(); updateMap(); syncUrl();
        syncEditTools();
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
    syncEditTools();
    if (!edit) map?.focus(true);
    syncUrl();
    if (changed) announce(t('floorChanged') + ': ' + titleFloor(floorId));
    if (matchMedia('(max-width:860px)').matches) setView('detail');
}

function changeFloor(id) {
    if (editSave?.saving) return;
    map?.cancelTransform();
    creationOpen = false;
    if (editingFloor) editingFloor = id;
    if (editConflict) editConflict.open = false;
    collapseEmptyDraft();
    floorId = id;
    const e = exhibit();
    if (e?.floorId !== id) selected = null;
    renderMapUI();
    renderList();
    renderInspector();
    updateMap(true);
    syncEditTools();
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
                <details class="note-options"><summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('ellipsis')}</summary><div class="popover"><button type="button" data-correct="${esc(n.id)}">${icon('pencil-line')}<span>${esc(t('correct'))}</span></button><button type="button" class="danger" data-delete-note="${esc(n.id)}">${icon('trash')}<span>${esc(t('deleteNote'))}</span></button></div></details>
            </div>
        </article>`;
}

function renderInspector() {
    const visible = Boolean(exhibit() || edit && (creationOpen || editingFloor || editConflict?.open));
    document.body.classList.toggle('inspector-hidden', !visible);
    $('#inspector').inert = !visible || Boolean(editSave?.saving);
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
                    <button type="button" class="status-toggle" aria-label="${esc(t('changeStatus') + ': ' + t(e.status))}" aria-expanded="false" aria-controls="status-menu" aria-haspopup="menu" title="${esc(t(e.status))}">${statusHTML(e.status)}${icon('chevron-down', 'status-chevron')}</button>
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
            ${icon('search', 'search-icon')}
            <input id="link-search" type="search" value="${esc(linkSearches[e.id] || '')}" placeholder="${esc(t('searchLinks'))}" aria-label="${esc(t('searchLinks'))}" aria-controls="link-results" autocomplete="off">
        </div>` : ''}
        <div id="link-results">${e.links.map(link => `
            <article class="link-card">
                <a class="document-open" href="${esc(link.url)}" ${opensInBrowser(link.url) ? 'target="_blank"' : ''} rel="noopener noreferrer" title="${esc(link.url)}"><span>${esc(link.title)}</span>${icon('link')}</a>
                ${link.description ? `<p>${esc(link.description)}</p>` : ''}
                <div class="link-actions">
                    <button type="button" class="icon-button" data-copy="${esc(link.id)}" aria-label="${esc(t('copy') + ': ' + link.title)}" title="${esc(t('copy'))}">${icon('copy')}</button>
                    <details class="note-options"><summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('ellipsis')}</summary><div class="popover"><button type="button" data-edit-link="${esc(link.id)}">${icon('pencil-line')}<span>${esc(t('edit'))}</span></button><button type="button" class="danger" data-delete-link="${esc(link.id)}">${icon('trash')}<span>${esc(t('remove'))}</span></button></div></details>
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
        $('#composer-slot').innerHTML = iconButton('continueEdit', 'resumeNote', 'pencil-line');
        return;
    }
    const active = d.open || Boolean(d.body || d.images.length || d.noteId);
    $('#composer-slot').innerHTML = `
        <form class="composer ${active ? 'composing' : ''}" id="note-form" novalidate>
            ${d.noteId ? `<div class="composer-correction row between">${iconButton('backToNote', 'backToNote', 'arrow-left')}${button('cancel', 'discardDraft', 'quiet')}</div>` : ''}
            <div id="note-editor" class="note-body"></div>
            <div class="composer-expanded" ${active ? '' : 'hidden'}>
                <div class="attachments">
                    ${d.existingImages.map(id => `<div class="attachment"><img src="api.php?action=asset&kind=image&id=${encodeURIComponent(id)}" alt="${esc(t('image'))}"><button type="button" data-remove-existing="${esc(id)}" aria-label="${esc(t('remove'))}" title="${esc(t('remove'))}">${icon('x')}</button></div>`).join('')}
                    ${d.images.map((im, i) => `<div class="attachment"><img src="${esc(im.data)}" alt="${esc(im.name)}"><button type="button" data-remove-image="${i}" aria-label="${esc(t('remove'))}" title="${esc(t('remove'))}">${icon('x')}</button></div>`).join('')}
                </div>
                <div class="composer-tools" ${d.signing ? 'hidden' : ''}>
                    <div class="toolbar">
                        ${[['bold', 'bold'], ['italic', 'italic'], ['heading', 'heading'], ['list', 'list-ordered'], ['link', 'link']].map(([key, name]) => `<button type="button" class="icon-button" data-format="${key}" aria-label="${esc(t(key === 'list' ? 'numberedList' : key))}" title="${esc(t(key === 'list' ? 'numberedList' : key))}">${icon(name)}</button>`).join('')}
                        <button type="button" class="icon-button photo-button" id="add-note-image" aria-label="${esc(t('photo'))}" title="${esc(t('photoHint'))}">${icon('image-plus')}</button>
                        <input type="file" id="note-image" hidden accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple>
                    </div>
                    <button class="primary post-button" type="submit">${esc(t(d.saving ? 'saving' : 'postShort'))}</button>
                </div>
                <div class="composer-secondary" ${d.signing ? 'hidden' : ''}>
                    <span class="draft-label" title="${esc(t('draftScope'))}">${esc(t('draftShort'))}</span>
                    <details class="note-options"><summary class="icon-button" title="${esc(t('more'))}" aria-label="${esc(t('more'))}">${icon('ellipsis')}</summary><div class="popover">${d.noteId ? '' : `<label for="note-status">${esc(t('status'))}</label><select id="note-status">${statusOptions(d.status, true)}</select>`}${button('discardDraft', 'discardDraft', 'quiet danger')}</div></details>
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
    const detail = Boolean(exhibit() || edit && (creationOpen || editingFloor || editConflict?.open));
    $('#mobile-nav').innerHTML = [['list', 'list'], ['map', 'map'], ['detail', 'panel-right']].map(([key, name]) => `<button type="button" data-action="view:${key}" class="${view === key ? 'active' : ''}" aria-current="${view === key ? 'page' : 'false'}" ${key === 'detail' && !detail ? 'disabled' : ''}>${icon(name)}<span>${esc(t(key === 'list' ? 'exhibits' : key))}</span></button>`).join('');
}

function renderEditBar() {
    const el = $('#editbar');
    el.hidden = !edit;
    if (!edit) return;
    const signing = Boolean(editSave?.signing);
    const dirty = Boolean(edit.changes().length || creation);
    el.classList.toggle('signing', signing);
    const label = creation ? `<button type="button" class="quiet edit-session-label" data-action="resumeCreation" title="${esc(t('resumeCreation'))}">${esc(t(creation.kind === 'floors' ? 'newFloor' : 'newExhibit'))}</button>` : `<span class="edit-session-label" title="${esc(t(dirty ? 'editing' : 'editStructure'))}">${esc(t('editingShort'))}${dirty ? '<i aria-hidden="true"></i>' : ''}</span>`;
    el.innerHTML = `<div class="edit-session-heading">${label}
        <div class="edit-history">${iconButton('undo', 'undo', 'undo-2', !edit.undoStack.length || editSave?.saving ? 'disabled' : '')}${iconButton('redo', 'redo', 'redo-2', !edit.redoStack.length || editSave?.saving ? 'disabled' : '')}</div></div>
        ${signing ? `<label class="sr-only" for="edit-signature">${esc(t('signature'))}</label><input id="edit-signature" autocomplete="off" maxlength="120" placeholder="${esc(t('yourName'))}" value="${esc(editSave.signature)}" aria-describedby="edit-save-error">` : ''}
        <div class="edit-session-actions" role="group" aria-label="${esc(t('editStructure'))}">${button('cancel', signing ? 'cancelEditSignature' : 'cancelEdit', 'quiet', `title="${esc(t(signing ? 'continueEdit' : 'cancelEditing'))}"`)}<button type="button" class="primary" data-action="${signing ? 'confirmEditSave' : 'saveExit'}" title="${esc(t(creation ? 'finishCreation' : editConflict ? 'resolveChanges' : 'signSave'))}" ${editSave?.saving || creation || editConflict || !dirty || (signing && !editSave.signature.trim()) ? 'disabled' : ''}>${esc(t(editSave?.saving ? 'saving' : 'save'))}</button></div>
        <div class="error" id="edit-save-error" role="alert" ${editSave?.error ? '' : 'hidden'}><span>${esc(editSave?.error ? t(editSave.error === 'conflict' ? 'editConflictHint' : editSave.error) : '')}</span>${editSave?.error === 'conflict' ? button('resolveChanges', 'structureConflict', 'quiet') : ''}</div>`;
    $('#edit-signature')?.addEventListener('input', event => {
        editSave.signature = event.target.value;
        $('[data-action=confirmEditSave]').disabled = editSave.saving || Boolean(creation || editConflict) || !edit.changes().length || !editSave.signature.trim();
    });
    $('#edit-signature')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); confirmEditSave(); }
    });
}

function editorMenu(record) {
    if (!record || editingFloor) return '';
    return `<details class="editor-menu"><summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('ellipsis')}</summary><div class="popover">${menuButton('duplicate', 'duplicateExhibit', 'copy-plus')}<button type="button" class="quiet danger" data-trash-exhibit="${esc(record.id)}" ${record.notes.length || record.links.length ? `disabled title="${esc(t('notEmpty'))}"` : ''}>${icon('trash')}<span>${esc(t('deleteExhibit'))}</span></button></div></details>`;
}

function renderEditInspector() {
    if (editConflict?.open) { renderEditConflict(); return; }
    const record = editingFloor ? data().floors.find(item => item.id === editingFloor) : exhibit();
    const title = creationOpen ? t(creation.kind === 'floors' ? 'newFloor' : 'newExhibit') :
        editingFloor ? titleFloor(editingFloor) : displayName(record);
    $('#inspector').innerHTML = `<div class="inspector-header edit-inspector-header"><h1 title="${esc(creationOpen ? '' : editingFloor ? editingFloor : record?.name || '')}">${esc(title)}</h1>${creationOpen ? '' : editorMenu(record)}</div><div class="panel-content" id="structure-panel"><div id="structure-slot"></div></div>`;
    if (creationOpen) { renderCreation(); return; }
    if (!record) return;
    const hardware = data().assets.filter(asset => asset.kind === 'hardware');
    const content = editingFloor ? `
        <div class="grid2"><div class="field"><label for="floor-name-de">${esc(t('nameDe'))}</label><input id="floor-name-de" data-floor-name="de" maxlength="200" value="${esc(record.names.de)}" placeholder="${esc(record.id)}"></div><div class="field"><label for="floor-name-en">${esc(t('nameEn'))}</label><input id="floor-name-en" data-floor-name="en" maxlength="200" value="${esc(record.names.en)}" placeholder="${esc(record.id)}"></div></div>
        ${viewPresets(record)}` : `
        <div class="field"><label for="ex-floor">${esc(t('floor'))}</label><select id="ex-floor" name="floorId">${options([['', t('noFloor')], ...data().floors.map(item => [item.id, item.names[lang()]])], record.floorId || '')}</select></div>
        <div class="instance-heading row between"><h3>${esc(t('modelInstances'))}</h3><details class="hardware-picker"><summary class="icon-button" aria-label="${esc(t('addModel'))}" title="${esc(t('addModel'))}">${icon('plus')}</summary><div class="popover">${hardware.map(asset => `<button type="button" data-add-hardware="${esc(asset.id)}">${esc(asset.name)}</button>`).join('') || `<p class="small muted">${esc(t('noHardware'))}</p>`}${button('models', 'models', 'quiet')}</div></details></div>
        <div id="instance-list">${record.models.map((instance, index) => {
            const asset = hardware.find(item => item.id === instance.model);
            return `<article class="model-instance ${index === activeInstance ? 'active' : ''}">
                <div class="instance-header"><button type="button" class="quiet instance-name" data-edit-instance="${index}" aria-pressed="${index === activeInstance}" title="${esc(t('selectModel'))}">${esc(asset?.name || instance.model)}${record.models.filter(item => item.model === instance.model).length > 1 ? `<small>${index + 1}</small>` : ''}</button>
                    <details class="instance-menu"><summary class="icon-button" aria-label="${esc(t('more') + ': ' + (asset?.name || instance.model))}">${icon('ellipsis')}</summary><div class="popover"><button type="button" data-duplicate-instance="${index}">${icon('copy-plus')}<span>${esc(t('duplicate'))}</span></button><button type="button" class="danger" data-remove-instance="${index}">${icon('trash')}<span>${esc(t('remove'))}</span></button></div></details></div>
                <details class="instance-placement"><summary>${esc(t('placement'))}</summary><label class="sr-only" for="instance-model-${index}">${esc(t('model'))}</label><select id="instance-model-${index}" data-instance-model="${index}">${options(hardware.map(item => [item.id, item.name]), instance.model)}</select>${vectorFields(instance.transform, `data-instance="${index}"`, index)}</details>
            </article>`;
        }).join('')}</div>
        ${record.models.length ? `<details class="exhibit-transform"><summary>${esc(t('exhibitTransform'))}</summary>${vectorFields(record.transform, 'data-group-vector')}</details>` : ''}
        ${viewPresets(record)}`;
    $('#structure-slot').innerHTML = `<form id="structure-form" novalidate>${content}<div class="error" id="structure-error" role="alert" hidden></div></form>`;
    const form = $('#structure-form');
    form.addEventListener('submit', event => { event.preventDefault(); saveExit(); });
    form.addEventListener('change', event => applyEditorField(event.target));
    if (!editingFloor && record.models.length) form.querySelector('#ex-floor option[value=""]').disabled = true;
    map?.setActiveInstance(activeInstance);
    syncEditTools();
}

function render() {
    document.body.classList.toggle('editing', Boolean(edit));
    $('#sidebar').inert = Boolean(editSave?.saving);
    renderHeader();
    if (!snapshot) return;
    if (!data().floors.some(f => f.id === floorId)) floorId = data().floors[0]?.id;
    if (editingFloor && !data().floors.some(f => f.id === editingFloor)) editingFloor = null;
    if (!data().exhibits.some(e => e.id === selected)) selected = null;
    activeInstance = Math.max(0, Math.min(activeInstance, (exhibit()?.models.length || 1) - 1));
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
    dialog.innerHTML = `<div class="dialog-header"><h2>${esc(t(title))}</h2><button type="button" data-action="closeDialog" class="quiet" aria-label="${esc(t('close'))}" title="${esc(t('close'))}">${icon('x')}</button></div><form class="dialog-body" id="dialog-form" novalidate>${html}<div id="dialog-error" class="error" role="alert" hidden></div></form>`;
    if (onSubmit) $('#dialog-form').addEventListener('submit', async e => {
        e.preventDefault();
        const submit = e.submitter;
        if (submit?.disabled) return;
        try {
            if (submit) submit.disabled = true;
            await onSubmit(new FormData(e.target), e.target);
        } catch (error) {
            const err = e.target.querySelector('#dialog-error');
            if (err?.isConnected) {
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
    if (recoverableEdit) { recoverEdit(); return; }
    edit = new EditSession(snapshot);
    creation = null;
    creationOpen = false;
    editingFloor = null;
    editSave = null;
    editConflict = null;
    gizmo = '';
    persistEdit();
    render();
}

function syncEditTools() {
    const available = edit && !editSave?.saving && !creationOpen && !editingFloor && !editConflict?.open && exhibit()?.models.length;
    map?.setTool(available ? gizmo : '', snap);
    map?.setAxis(axisConstraint);
}

function changed() {
    if (!edit) return;
    persistEdit();
    render();
    syncEditTools();
    syncUrl();
}

function applyEdit(change, { rebuild = false, reset = false } = {}) {
    if (!edit || editSave?.saving) return false;
    const didChange = edit.change(state => {
        change(state);
        state.exhibits.forEach(record => { record.placed = Boolean(record.floorId && record.models.length); });
    });
    if (!didChange) return false;
    if (!edit.value.exhibits.some(record => record.id === selected)) selected = null;
    editConflict = null;
    if (editSave) editSave.error = null;
    if (editSave) editSave.requestId = uid();
    persistEdit();
    renderList();
    renderEditBar();
    if (rebuild) renderInspector();
    renderMapUI();
    updateMap(reset);
    syncEditTools();
    syncUrl();
    return true;
}

function structureError(key, input = null) {
    const error = $('#structure-error');
    if (error) { error.hidden = false; error.textContent = t(key); }
    for (let parent = input?.parentElement; parent; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    (input?.nextElementSibling?.matches('.select-button') ? input.nextElementSibling : input)?.focus();
}

function validEditorFields() {
    const inputs = [...($('#structure-form')?.querySelectorAll('input') || [])];
    const invalid = inputs.find(input => !input.checkValidity() || input.type === 'number' && !input.value.trim());
    if (!invalid) return true;
    structureError(invalid.type === 'number' ? 'invalidTransform' : 'invalidInput', invalid);
    return false;
}

function applyEditorField(input) {
    if (!edit || editSave?.saving) return;
    const record = editingFloor ? data().floors.find(item => item.id === editingFloor) : exhibit();
    if (!record) return;
    if (!input.checkValidity() || input.type === 'number' && !input.value.trim()) {
        structureError('invalidTransform', input);
        return;
    }
    if ($('#structure-error')) $('#structure-error').hidden = true;
    const reset = input.id === 'ex-floor' && Boolean(input.value) && input.value !== floorId;
    const previousFloor = floorId;
    try {
        if (reset) floorId = input.value;
        applyEdit(state => {
            const target = state[editingFloor ? 'floors' : 'exhibits'].find(item => item.id === record.id);
            if (input.dataset.floorName) target.names[input.dataset.floorName] = input.value.trim() || target.id;
            else if (input.id === 'ex-floor') {
                if (target.models.length && !input.value) throw Error('invalidFloor');
                target.floorId = input.value || null;
            } else if (input.dataset.instanceModel !== undefined) target.models[Number(input.dataset.instanceModel)].model = input.value;
            else if (input.dataset.vector) {
                const transform = input.hasAttribute('data-group-vector') ? target.transform : target.models[Number(input.dataset.instance)]?.transform;
                if (!transform) return;
                let value = Number(input.value);
                if (snap && input.dataset.vector === 'position') value = Math.round(value);
                if (snap && input.dataset.vector === 'rotation') value = Math.round(value / 15) * 15;
                transform[input.dataset.vector][Number(input.dataset.axis)] = value;
                input.value = value;
            }
        }, { reset });
    } catch (error) { floorId = previousFloor; structureError(error.key || error.message, input); }
}

function updateTransformFields() {
    const record = exhibit();
    if (!record) return;
    $('#structure-form')?.querySelectorAll('[data-vector]').forEach(input => {
        if (input === document.activeElement) return;
        const transform = input.hasAttribute('data-group-vector') ? record.transform : record.models[Number(input.dataset.instance)]?.transform;
        if (transform) input.value = Number(transform[input.dataset.vector][Number(input.dataset.axis)].toFixed(4));
    });
}

function structureDialog(kind, isNew = false) {
    if (!edit || editSave?.saving) return;
    map?.cancelTransform();
    if (isNew) {
        if (creation && creation.kind !== kind) announce(t('finishCreation'));
        if (!creation) creation = {
            kind, previousSelected: selected, previousFloor: floorId,
            record: kind === 'floors' ? { number: '', de: '', en: '' } : { name: '', floorId: floorId || '' }
        };
        creationOpen = true;
        editingFloor = null;
        selected = null;
    } else {
        creationOpen = false;
        editingFloor = kind === 'floors' ? floorId : null;
        if (editingFloor) selected = null;
    }
    if (editConflict) editConflict.open = false;
    persistEdit();
    renderEditBar();
    renderInspector();
    renderList();
    renderMapUI();
    updateMap();
    syncEditTools();
    syncUrl();
    setView('detail');
    if (creationOpen) $('#creation-form input')?.focus();
}

function renderCreation() {
    const record = creation.record;
    const isFloor = creation.kind === 'floors';
    const fields = isFloor ? `
        <div class="field"><label for="floor-number">${esc(t('floorNumber'))}</label><input id="floor-number" data-create-field="number" type="number" step="1" required value="${esc(record.number)}"></div>
        <div class="grid2"><div class="field"><label for="floor-name-de">${esc(t('nameDe'))}</label><input id="floor-name-de" data-create-field="de" maxlength="200" value="${esc(record.de)}"></div><div class="field"><label for="floor-name-en">${esc(t('nameEn'))}</label><input id="floor-name-en" data-create-field="en" maxlength="200" value="${esc(record.en)}"></div></div>` : `
        <div class="field"><label for="ex-name">${esc(t('name'))}</label><input id="ex-name" data-create-field="name" maxlength="160" required value="${esc(record.name)}" autocomplete="off"></div>
        <div class="field"><label for="ex-floor">${esc(t('floor'))}</label><select id="ex-floor" data-create-field="floorId">${options([['', t('noFloor')], ...data().floors.map(item => [item.id, item.names[lang()]])], record.floorId)}</select></div>`;
    $('#structure-slot').innerHTML = `<form id="creation-form" novalidate>${fields}<div class="error" id="structure-error" role="alert" hidden></div><div class="creation-actions">${button('cancel', 'cancelCreation', 'quiet')}<button type="submit" class="primary">${esc(t('create'))}</button></div></form>`;
    $('#creation-form').addEventListener('input', event => {
        if (!event.target.dataset.createField) return;
        record[event.target.dataset.createField] = event.target.value;
        persistEdit();
        renderEditBar();
    });
    $('#creation-form').addEventListener('change', event => {
        if (event.target.dataset.createField) { record[event.target.dataset.createField] = event.target.value; persistEdit(); }
    });
    $('#creation-form').addEventListener('submit', event => { event.preventDefault(); commitCreation(); });
}

function commitCreation() {
    if (!creation || !edit) return true;
    try {
        const raw = creation.record;
        let record;
        if (creation.kind === 'floors') {
            const id = raw.number.trim();
            if (!/^(0|-?[1-9][0-9]*)$/.test(id) || !Number.isSafeInteger(Number(id))) throw Error('invalidFloorNumber');
            record = { id, names: { de: raw.de.trim() || id, en: raw.en.trim() || id }, order: Number(id), modelId: null, transform: identity(), views: {}, revision: null };
        } else record = newExhibit(raw.name, raw.floorId);
        const kind = creation.kind;
        if (data()[kind].some(item => item.id.toLocaleLowerCase() === record.id.toLocaleLowerCase())) throw Error('duplicateName');
        edit.change(state => state[kind].push(record));
        creation = null;
        creationOpen = false;
        if (kind === 'floors') { floorId = record.id; selected = null; editingFloor = record.id; }
        else { selected = record.id; editingFloor = null; if (record.floorId) floorId = record.floorId; }
        activeInstance = 0;
        changed();
        if (kind === 'floors') updateMap(true);
        return true;
    } catch (error) {
        creationOpen = true;
        renderInspector();
        structureError(error.message, $('#creation-form input'));
        return false;
    }
}

function cancelCreation() {
    if (!creation) return;
    const previous = creation;
    creation = null;
    creationOpen = false;
    selected = data().exhibits.some(record => record.id === previous.previousSelected) ? previous.previousSelected : null;
    floorId = data().floors.some(record => record.id === previous.previousFloor) ? previous.previousFloor : floorId;
    changed();
}

function addHardware(model) {
    const record = exhibit();
    if (!record || !edit || editSave?.saving) return;
    if (!data().assets.some(asset => asset.id === model && asset.kind === 'hardware')) return;
    if (!record.floorId) { structureError('chooseFloorFirst', $('#ex-floor')); return; }
    if (record.models.length >= 100) { structureError('invalidModel'); return; }
    map?.cancelTransform();
    const transform = identity();
    const previous = record.models[activeInstance];
    transform.position = previous ? [previous.transform.position[0] + 1.5, previous.transform.position[1], previous.transform.position[2]] : map?.placementPosition(record.transform) || [0, 0, 0];
    activeInstance = record.models.length;
    gizmo = 'translate';
    applyEdit(state => state.exhibits.find(item => item.id === record.id).models.push({ model, transform }), { rebuild: true });
}

function removeHardware(index) {
    const record = exhibit();
    const instance = record?.models[index];
    if (!instance) return;
    const name = data().assets.find(asset => asset.id === instance.model)?.name || instance.model;
    showDialog('removeHardware', `<p>${esc(name)}</p><p class="small muted deletion-hint">${esc(t('deleteOnSave'))}</p>${footer('remove')}`, async () => {
        closeDialog();
        map?.cancelTransform();
        activeInstance = Math.max(0, Math.min(activeInstance, record.models.length - 2));
        applyEdit(state => state.exhibits.find(item => item.id === record.id).models.splice(index, 1), { rebuild: true });
    });
    $('#dialog button[type=submit]').className = 'danger';
}

function duplicateHardware(index) {
    const record = exhibit();
    if (!record?.models[index] || record.models.length >= 100) return;
    map?.cancelTransform();
    const copy = structuredClone(record.models[index]);
    copy.transform.position[0] += 1.5;
    activeInstance = record.models.length;
    applyEdit(state => state.exhibits.find(item => item.id === record.id).models.push(copy), { rebuild: true });
}

function cancelEdit() {
    if (!edit) return;
    map?.cancelTransform();
    cancelledEdit = { edit, creation, creationOpen, editingFloor, selected, floorId, activeInstance, gizmo };
    const dirty = edit.changes().length || creation;
    edit = null;
    creation = null;
    creationOpen = false;
    editingFloor = null;
    editSave = null;
    editConflict = null;
    recoverableEdit = null;
    gizmo = '';
    persistEdit();
    render();
    syncEditTools();
    syncUrl();
    if (dirty) announce(t('editsCancelled'), 'restoreEdit');
}

function restoreEdit() {
    if (edit || !cancelledEdit) return;
    ({ edit, creation, creationOpen, editingFloor, selected, floorId, activeInstance, gizmo } = cancelledEdit);
    cancelledEdit = null;
    editSave = null;
    editConflict = null;
    changed();
    announce(t('editsRestored'));
}

async function saveExit() {
    if (!edit || editSave?.saving) return;
    if (editConflict) { actions.structureConflict(); return; }
    map?.cancelTransform();
    if (creation) {
        creationOpen = true;
        editingFloor = null;
        renderInspector(); renderMapUI(); syncEditTools(); setView('detail');
        $('#creation-form input')?.focus();
        return;
    }
    if (!validEditorFields()) return;
    if (!edit.changes().length) { cancelEdit(); return; }
    editSave = { signing: true, signature: editSave?.signature || '', saving: false, error: null, requestId: uid() };
    renderEditBar();
    $('#edit-signature').focus();
}

async function confirmEditSave() {
    if (!edit || !editSave?.signing || editSave.saving || !editSave.signature.trim()) return;
    if (editConflict) { actions.structureConflict(); return; }
    if (creation || !validEditorFields()) return;
    map?.cancelTransform();
    const session = edit, save = editSave, changes = session.changes();
    save.controller = new AbortController();
    save.saving = true;
    save.error = null;
    closeMenus();
    $('#sidebar').inert = true;
    $('#inspector').inert = true;
    renderEditBar();
    syncEditTools();
    try {
        const result = await api.save({ action: 'structure', baseRevision: session.base.structureRevision, requestId: save.requestId, signature: save.signature.trim(), changes }, { signal: save.controller.signal });
        if (edit !== session) return;
        edit = null;
        creation = null;
        creationOpen = false;
        editingFloor = null;
        editConflict = null;
        editSave = null;
        cancelledEdit = null;
        gizmo = '';
        persistEdit();
        acceptSnapshot(result.snapshot);
        syncEditTools();
        announce(t('saved'));
    } catch (error) {
        if (error.name === 'AbortError' || edit !== session || editSave !== save) return;
        save.error = error.key || error.message || 'storage';
        if (error.key === 'conflict') {
            try { await structureConflict(save); }
            catch (refreshError) { save.error = refreshError.key || refreshError.message || 'offline'; }
        }
    } finally {
        if (editSave === save) {
            save.saving = false;
            $('#sidebar').inert = false;
            $('#inspector').inert = false;
            renderEditBar();
            syncEditTools();
        }
    }
}

function cancelEditSignature() {
    if (!editSave) return;
    const save = editSave;
    save.controller?.abort();
    editSave = null;
    $('#sidebar').inert = false;
    $('#inspector').inert = false;
    renderEditBar();
    syncEditTools();
    if (save.saving) reconcileCancelledSave(edit);
}

async function reconcileCancelledSave(session) {
    try {
        const live = await api.load();
        if (edit !== session) return;
        const saved = session.changes().every(change => {
            const record = live[change.kind].find(item => item.id === change.id);
            return change.op === 'delete' ? !record : record && JSON.stringify(structural(record, change.kind)) === JSON.stringify(change.record);
        });
        if (saved) {
            edit = null;
            creation = null;
            creationOpen = false;
            editingFloor = null;
            gizmo = '';
            persistEdit();
            acceptSnapshot(live);
            syncEditTools();
            announce(t('saved'));
        }
    } catch { announce(t('offline')); }
}

async function modelsDialog() {
    const rows = data().assets.filter(asset => asset.kind === 'hardware').map(asset => `
        <div class="model-row">
            <div class="model-text"><strong title="${esc(asset.file)}">${esc(asset.name)}</strong></div>
            <button type="button" class="icon-button" data-preview-model="${esc(asset.id)}" aria-label="${esc(t('preview') + ': ' + asset.name)}" title="${esc(t('preview'))}">${icon('eye')}</button>
        </div>`).join('');
    let closed = false;
    const controller = new AbortController();
    showDialog('models', `
        <div class="model-grid">${rows || `<p class="small muted">${esc(t('noHardware'))}</p>`}</div>
        <div class="field model-import"><label for="model-file">${esc(t('chooseFile'))}</label><input type="file" name="model" id="model-file" accept=".glb,model/gltf-binary"></div>
        ${footer()}`, async form => {
        const file = form.get('model');
        if (!file?.size) throw Error('invalidModel');
        if (file.size > 32 * 1024 * 1024) throw Error('fileTooLarge');
        const { inspectModel } = await import('./map.js');
        const dimensions = await inspectModel(file);
        if (closed) return;
        try {
            await api.upload(file, 'model', '', uid(), dimensions, null, { signal: controller.signal });
            const live = await api.load();
            if (edit) {
                edit.value.assets = structuredClone(live.assets);
                edit.base.assets = structuredClone(live.assets);
            }
            if (!closed) closeDialog();
            acceptSnapshot(live);
            announce(t('saved'));
        } catch (error) {
            if (error.name !== 'AbortError') throw error;
        }
    });
    dialogCleanup = () => { closed = true; controller.abort(); };
    const submit = $('#dialog button[type=submit]');
    submit.disabled = true;
    $('#model-file').addEventListener('change', event => { submit.disabled = !event.target.files.length; });
}

async function modelPreview(id) {
    const asset = data().assets.find(item => item.id === id);
    if (!asset) return;
    let closed = false;
    let preview = null;
    showDialog('modelPreview', `<h3>${esc(asset.name)}</h3><div class="preview-stage" id="asset-preview"></div><p id="preview-error" role="status"></p><div class="dialog-footer">${button('models', 'models', 'quiet')}${button('close', 'closeDialog')}</div>`);
    dialogCleanup = () => { closed = true; preview?.destroy(); };
    try {
        const { MapView } = await import('./map.js');
        if (closed) return;
        preview = new MapView($('#asset-preview'));
        await preview.init();
        if (closed) { preview.destroy(); return; }
        await preview.preview(asset);
    } catch {
        if (!closed && $('#preview-error')) $('#preview-error').textContent = t('mapUnavailable');
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

async function structureConflict(expectedSave = null) {
    if (!edit) return;
    const session = edit;
    const live = await api.load();
    if (edit !== session || expectedSave && editSave !== expectedSave) return;
    const result = rebaseEdit(session, live);
    if (!result.conflicts.length) {
        snapshot = live;
        edit = result.session;
        editConflict = null;
        if (editSave) { editSave.error = null; editSave.saving = false; editSave.requestId = uid(); }
        changed();
        announce(t('newerMerged'));
        return;
    }
    editConflict = { live, conflicts: result.conflicts, choices: {}, open: true };
    creationOpen = false;
    renderInspector();
    renderMapUI();
    syncEditTools();
    setView('detail');
}

function conflictValue(value) {
    if (value == null) return t('deletedRecord');
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return value.map(instance =>
        (data().assets.find(asset => asset.id === instance.model)?.name || instance.model) + '\n' +
        ['position', 'rotation', 'scale'].map(key => t(key) + ': ' + instance.transform[key].join(', ')).join('\n')
    ).join('\n\n');
    if (value.position && value.rotation && value.scale) return ['position', 'rotation', 'scale'].map(key => t(key) + ': ' + value[key].join(', ')).join('\n');
    if (value.position && value.target) return t('savedView');
    return value.name || value.id || t('savedView');
}

function renderEditConflict() {
    const labels = { floorId: 'floor', status: 'status', models: 'modelInstances', transform: 'placement', 'views.top': 'view2D', 'views.three': 'view3D', 'names.de': 'nameDe', 'names.en': 'nameEn', record: 'editExhibit' };
    const ready = editConflict.conflicts.every(item => editConflict.choices[item.key]);
    $('#inspector').innerHTML = `<div class="inspector-header"><h1>${esc(t('resolveChanges'))}</h1></div><div class="panel-content"><form id="conflict-form" novalidate>${editConflict.conflicts.map((item, index) => `<article class="conflict-card"><h3>${esc(item.id)}</h3><p class="small muted">${esc(t(labels[item.field] || 'placement'))}</p><div class="conflict-values"><div><span class="small muted">${esc(t('current'))}</span><p>${esc(conflictValue(item.current))}</p></div><div><span class="small muted">${esc(t('yours'))}</span><p>${esc(conflictValue(item.yours))}</p></div></div><label class="sr-only" for="conflict-${index}">${esc(t('chooseVersion'))}</label><select id="conflict-${index}" data-conflict-key="${esc(item.key)}">${options([['', t('chooseVersion')], ['current', t('keepCurrent')], ['mine', t('useMine')]], editConflict.choices[item.key] || '')}</select></article>`).join('')}<div class="creation-actions">${button('cancel', 'cancelConflict', 'quiet')}<button type="submit" class="primary" id="resolve-edit" ${ready ? '' : 'disabled'}>${esc(t('resolveChanges'))}</button></div></form></div>`;
    $('#conflict-form').addEventListener('change', event => {
        if (!event.target.dataset.conflictKey) return;
        editConflict.choices[event.target.dataset.conflictKey] = event.target.value;
        $('#resolve-edit').disabled = editConflict.conflicts.some(item => !editConflict.choices[item.key]);
    });
    $('#conflict-form').addEventListener('submit', event => {
        event.preventDefault();
        const result = rebaseEdit(edit, editConflict.live, editConflict.choices);
        if (result.conflicts.length) return;
        snapshot = editConflict.live;
        edit = result.session;
        editConflict = null;
        if (editSave) { editSave.error = null; editSave.saving = false; editSave.requestId = uid(); }
        changed();
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
    try {
        const saved = JSON.parse(localStorage.getItem(editStorageKey) || 'null');
        if (!saved?.base || !saved.value) return;
        const session = new EditSession(saved.base);
        session.value = saved.value;
        if (!session.changes().length && !saved.creation) { localStorage.removeItem(editStorageKey); return; }
        recoverableEdit = saved;
        announce(t('unsavedEdits'), 'recoverEdit', 'recover');
    } catch { localStorage.removeItem(editStorageKey); }
}

function recoverEdit() {
    const saved = recoverableEdit;
    if (!saved) return;
    edit = new EditSession(saved.base);
    saved.value.exhibits.forEach(record => { record.status = normalizeStatus(record.status); });
    edit.value = saved.value;
    edit.undoStack = saved.undoStack || [];
    edit.redoStack = saved.redoStack || [];
    creation = saved.creation || null;
    creationOpen = Boolean(saved.creationOpen && creation);
    editingFloor = saved.editingFloor || null;
    selected = creationOpen ? null : saved.selected || selected;
    floorId = saved.floorId || floorId;
    activeInstance = saved.activeInstance || 0;
    gizmo = saved.gizmo || '';
    editSave = null;
    recoverableEdit = null;
    changed();
    announce(t('editsRestored'));
}

function duplicateSelected(id = selected) {
    if (!edit || editSave?.saving) return;
    const record = data().exhibits.find(item => item.id === id);
    if (!record) return;
    map?.cancelTransform();
    const copy = duplicateExhibit(record, data().exhibits);
    selected = copy.id;
    creationOpen = false;
    editingFloor = null;
    applyEdit(state => state.exhibits.push(copy), { rebuild: true });
    if (matchMedia('(max-width:860px)').matches) setView('detail');
}

function setEditTool(tool) {
    if (!edit || !exhibit()?.models.length || editSave?.saving) return;
    map?.cancelTransform();
    gizmo = gizmo === tool ? '' : tool;
    syncEditTools();
    renderMapUI();
    $(`[data-tool="${tool}"]`)?.focus({ preventScroll: true });
}

const actions = {
    refresh,
    enterEdit,
    resumeNote: () => { drafts[selected].readOnly = false; renderPanel(); },
    backToNote: () => { drafts[selected].readOnly = true; persistDrafts(); renderPanel(); },
    discardDraft: () => { delete drafts[selected]; persistDrafts(); renderPanel(); },
    cancelCreation,
    cancelEdit,
    cancelEditSignature,
    confirmEditSave,
    restoreEdit,
    recoverEdit,
    resumeCreation: () => structureDialog(creation.kind, true),
    duplicateExhibit: () => duplicateSelected(),
    cancelConflict: () => { editConflict.open = false; renderInspector(); renderMapUI(); syncEditTools(); },
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
    undo: () => { if (editSave?.saving) return; map?.cancelTransform(); edit?.undo(); editConflict = null; changed(); },
    redo: () => { if (editSave?.saving) return; map?.cancelTransform(); edit?.redo(); editConflict = null; changed(); },
    saveExit,
    models: modelsDialog,
    structureConflict: () => {
        if (!editConflict) return structureConflict();
        editConflict.open = true;
        renderInspector(); renderMapUI(); syncEditTools(); setView('detail');
    }
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
        if (element.dataset.setView || element.dataset.resetView || element.dataset.previewView) {
            if (!edit || editSave?.saving) return;
            const record = editingFloor ? data().floors.find(item => item.id === editingFloor) : exhibit();
            const key = element.dataset.setView || element.dataset.resetView || element.dataset.previewView;
            await ensureMap();
            if (!map || !record) throw Error('mapUnavailable');
            if (element.dataset.previewView) {
                const mode = key === 'top' ? 'top' : 'perspective';
                const ids = editingFloor ? data().exhibits.filter(item => item.floorId === record.id).map(item => item.id) : [record.id];
                map.applyView(record.views?.[key] || map.fallbackView(ids, mode));
                setView('map');
                return;
            }
            const preset = element.dataset.setView ? map.captureView(key === 'top' ? 'top' : 'perspective') : null;
            applyEdit(state => {
                const target = state[editingFloor ? 'floors' : 'exhibits'].find(item => item.id === record.id);
                target.views ||= {};
                if (preset) target.views[key] = preset;
                else delete target.views[key];
            }, { rebuild: true });
            $('#inspector .view-presets').open = true;
            return;
        }
        if (element.dataset.tool) { setEditTool(element.dataset.tool); return; }
        if (element.dataset.duplicateExhibit) { duplicateSelected(element.dataset.duplicateExhibit); return; }
        if (element.dataset.addHardware) { addHardware(element.dataset.addHardware); return; }
        if (element.dataset.editInstance !== undefined) {
            map?.cancelTransform();
            activeInstance = Number(element.dataset.editInstance);
            map?.setActiveInstance(activeInstance);
            renderInspector(); renderMapUI(); syncEditTools();
            return;
        }
        if (element.dataset.removeInstance !== undefined) { removeHardware(Number(element.dataset.removeInstance)); return; }
        if (element.dataset.duplicateInstance !== undefined) { duplicateHardware(Number(element.dataset.duplicateInstance)); return; }
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
            const modeChange = ['top', 'perspective'].includes(command);
            if (modeChange && command === mapMode) return;
            if (modeChange) mapMode = command;
            await ensureMap();
            map?.command(command);
            syncUrl();
            renderMapUI();
            if (modeChange) $('#map-controls').querySelector(`[data-action="camera:${command}"]`).focus({ preventScroll: true });
            return;
        }
        if (actions[action]) await actions[action]();
    } catch (error) { announce(errorText(error)); }
});

document.addEventListener('keydown', event => {
    if ($('#dialog').open || event.defaultPrevented) return;
    const typing = event.target.closest('input, textarea, [contenteditable]');
    if (edit && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (editSave?.saving) return;
        if (event.target.matches('#structure-form input')) applyEditorField(event.target);
        editSave?.signing ? confirmEditSave() : saveExit();
        return;
    }
    if (event.key === 'Escape') {
        if (map?.cancelTransform()) { event.preventDefault(); return; }
        if (editSave?.signing) { event.preventDefault(); cancelEditSignature(); return; }
        if (creationOpen) { event.preventDefault(); cancelCreation(); return; }
        if (editConflict?.open) { event.preventDefault(); actions.cancelConflict(); return; }
        if (edit && gizmo) { event.preventDefault(); gizmo = ''; syncEditTools(); renderMapUI(); return; }
        if (!typing && !event.target.closest('.status-picker, .selection-menu')) select(null);
    }
    if (edit && !typing && !editSave?.saving) {
        const key = event.key.toLowerCase();
        if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(key)) {
            event.preventDefault();
            actions[key === 'y' || event.shiftKey ? 'redo' : 'undo']();
        } else if (!event.metaKey && !event.ctrlKey && !event.altKey && ['g', 'r', 's'].includes(key)) {
            event.preventDefault();
            setEditTool({ g: 'translate', r: 'rotate', s: 'scale' }[key]);
        }
    }
    if (event.target.matches('[data-select]') && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        select(event.target.dataset.select);
    }
});

$('#dialog').addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
new ResizeObserver(() => {
    document.documentElement.style.setProperty('--editbar-height', $('#editbar').offsetHeight + 'px');
    if (edit) requestAnimationFrame(() => $('#exhibit-list .exhibit-row.active')?.scrollIntoView({ block: 'nearest' }));
}).observe($('#editbar'));
new ResizeObserver(() => {
    const height = $('#map-controls').offsetHeight;
    if (height) document.documentElement.style.setProperty('--map-controls-height', height + 'px');
}).observe($('#map-controls'));
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
window.addEventListener('beforeunload', () => {
    persistDrafts(); persistEdit();
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
    if (params.has('view')) mapMode = cameraMode(params.get('view'));
    syncUrl();
    render();
    ensureMap();
    recoverDraft();
} catch (error) {
    $('#sidebar').innerHTML = '<div class="error">' + esc(errorText(error)) + '</div>' + button('refresh', 'refresh');
}
