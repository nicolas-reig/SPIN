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
import { editHelp, vectorFields, viewPresets, newExhibit, duplicateExhibit, rebaseEdit } from './edit.js';
import { icon } from './icons.js';
import { safeUrl, documentUrl, opensInBrowser } from './domain.js';
import { copyText } from './clipboard.js';
import { DraftStore } from './drafts.js';
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
let cancelledDraft = null;
let drafts = {}, draftStore = null, localDraftError = false;
let linkDrafts = {}, dialogDrafts = {}, modelDraft = null, editorFields = {};
let dialogDraftKey = null;
const linkSearches = {};
async function loadDrafts() {
    draftStore = new DraftStore(snapshot.datasetKey);
    const legacy = (name, fallback) => {
        try { return JSON.parse(localStorage.getItem(name + snapshot.datasetKey) || 'null') || fallback; }
        catch { return fallback; }
    };
    drafts = legacy('hub-drafts-', {});
    recoverableEdit = legacy('hub-edit-', null);
    try {
        await draftStore.open();
        const saved = await Promise.all(['notes', 'links', 'dialogs', 'model', 'edit'].map(key => draftStore.read(key)));
        drafts = saved[0] || drafts;
        linkDrafts = saved[1] || {};
        dialogDrafts = saved[2] || {};
        modelDraft = saved[3] || null;
        recoverableEdit = saved[4] || recoverableEdit;
        Object.values(drafts).forEach(draft => {
            draft.saving = false;
            draft.readingImages = false;
            if (draft.status === 'unset') draft.status = 'ok';
            draft.localId ||= draft.requestId;
        });
        Object.values(linkDrafts).forEach(draft => { draft.saving = false; });
        const migrated = await Promise.all([persistDrafts(), persistEdit()]);
        if (migrated[0]) localStorage.removeItem('hub-drafts-' + snapshot.datasetKey);
        if (migrated[1]) localStorage.removeItem('hub-edit-' + snapshot.datasetKey);
    } catch {
        localDraftFailure();
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
    if (action !== 'restoreDraft') cancelledDraft = null;
    const notice = $('#notice');
    notice.classList.remove('is-exiting');
    notice.inert = false;
    notice.innerHTML = `<span>${esc(message)}</span>${action ? button(label, action, 'quiet') : ''}`;
    noticeTimer = setTimeout(dismissNotice, action ? 10000 : 6500);
}

function clearNotice() {
    clearTimeout(noticeTimer);
    clearTimeout(noticeClearTimer);
    cancelledDraft = null;
    const notice = $('#notice');
    notice.replaceChildren();
    notice.classList.remove('is-exiting');
    notice.inert = false;
}

function dismissNotice() {
    clearTimeout(noticeTimer);
    cancelledDraft = null;
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

function localDraftFailure() {
    if (!localDraftError) {
        localDraftError = true;
        announce(t('draftFailed'));
    }
}

function saveLocalDraft(name, value) {
    if (!draftStore) return Promise.resolve(false);
    return draftStore.write(name, value).then(() => true, () => {
        localDraftFailure();
        return false;
    });
}

function persistDrafts() {
    const saved = Object.fromEntries(Object.entries(drafts).map(([id, draft]) => {
        const value = { ...draft };
        delete value.saving;
        delete value.readingImages;
        return [id, value];
    }));
    return saveLocalDraft('notes', saved);
}

function persistLinks() {
    return saveLocalDraft('links', Object.fromEntries(Object.entries(linkDrafts).map(([id, draft]) => {
        const value = { ...draft };
        delete value.saving;
        return [id, value];
    })));
}

function persistDialogs() {
    return saveLocalDraft('dialogs', dialogDrafts);
}

function touchNoteDraft(draft, signatureChanged = false) {
    draft.localId ||= draft.requestId;
    draft.requestId = uid();
    if (signatureChanged) draft.images.filter(image => !image.uploaded).forEach(image => { image.id = uid(); });
}

function discardComposerDraft(kind) {
    const id = selected;
    const store = kind === 'notes' ? drafts : linkDrafts;
    const draft = store[id];
    if (!draft || draft.saving) return;
    delete store[id];
    if (kind === 'notes') persistDrafts();
    else persistLinks();
    renderPanel();
    cancelledDraft = { kind, id, draft, replacement: store[id] };
    announce(t(kind === 'notes' ? 'noteDraftDiscarded' : 'linkDraftCancelled'), 'restoreDraft');
}

function invalidateDraftUndo(kind, id) {
    if (cancelledDraft?.kind === kind && cancelledDraft.id === id) dismissNotice();
}

async function restoreDraft() {
    const saved = cancelledDraft;
    if (!saved) return;
    const store = saved.kind === 'notes' ? drafts : linkDrafts;
    if (store[saved.id] !== saved.replacement) {
        dismissNotice();
        return;
    }
    cancelledDraft = null;
    store[saved.id] = saved.draft;
    saved.draft.open = true;
    if (saved.kind === 'notes') persistDrafts();
    else persistLinks();
    if (!edit && data().exhibits.some(record => record.id === saved.id)) {
        tab = saved.kind;
        if (selected !== saved.id) await select(saved.id);
        else renderInspector();
        if (matchMedia('(max-width:860px)').matches) setView('detail');
        if (saved.kind === 'notes') (saved.draft.signing ? $('#note-signature') : $('#note-body'))?.focus();
        else $('#link-title')?.focus();
    }
    announce(t('draftRestored'));
}

function persistEdit() {
    return saveLocalDraft('edit', edit ? {
        base: edit.base,
        value: edit.value,
        creation,
        creationOpen,
        editingFloor,
        selected,
        floorId,
        activeInstance,
        gizmo,
        snap,
        axisConstraint,
        editorFields,
        editConflict,
        editSave: editSave ? {
            signing: editSave.signing, signature: editSave.signature,
            requestId: editSave.requestId, error: editSave.error
        } : null,
        undoStack: edit.undoStack,
        redoStack: edit.redoStack
    } : recoverableEdit);
}

function setView(value) {
    if (value === 'detail' && !exhibit() && !(edit && (creationOpen || editingFloor || editConflict?.open))) value = 'map';
    collapseEmptyDraft();
    view = value;
    document.body.dataset.view = value;
    renderMobile();
    map?.resize();
}


function iconButton(label, action, name, extra = '', help = null) {
    return `<button type="button" class="icon-button" data-action="${action}" aria-label="${esc(t(label))}" ${help ? editHelp(help) : `title="${esc(t(label))}"`} ${extra}>${icon(name)}</button>`;
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
    showDialog('deleteNote', `<p>${esc(t('noteBy'))} ${esc(note.author)} · ${esc(date(note.at))}</p><p class="muted small" style="margin:12px 0 20px">${esc(t('deleteNoteHint'))}</p>${signatureField()}${footer('deleteNote')}`, async (form, element) => {
        const result = await api.save({ action: 'deleteNote', exhibitId: record.id, noteId, baseRevision: record.revision, contentTag: record.contentTag, requestId, signature: requireSignature(form) });
        if (drafts[record.id]?.noteId === noteId) delete drafts[record.id];
        persistDrafts();
        closeDialog(element);
        acceptSnapshot(result.snapshot);
        announce(t('saved'));
    }, 'deleteNote:' + record.id + ':' + noteId);
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
        </button>${edit && e.id === selected ? `<details class="exhibit-options"><summary class="icon-button" aria-label="${esc(t('more') + ': ' + displayName(e))}" title="${esc(t('more') + ': ' + displayName(e))}">${icon('ellipsis')}</summary><div class="popover"><button type="button" data-duplicate-exhibit="${esc(e.id)}" ${editHelp('duplicateExhibitHint')}>${icon('copy-plus')}<span>${esc(t('duplicate'))}</span></button><button type="button" class="danger" data-trash-exhibit="${esc(e.id)}" ${editHelp(e.notes.length || e.links.length ? 'notEmpty' : 'removeExhibitHint')} ${e.notes.length || e.links.length ? 'disabled' : ''}>${icon('trash')}<span>${esc(t('deleteExhibit'))}</span></button></div></details>` : ''}</div>`).join('') : `<p class="empty">${esc(t('noResults'))}</p>`;
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
            ${edit && exhibit()?.models.length && !creationOpen && !editingFloor && !editConflict?.open ? `<span class="toolbar-divider"></span><div class="transform-controls"><div class="transform-tools" role="group" aria-label="${esc(t('gizmo'))}">${[['translate', 'move', 'move', 'moveHardwareHint'], ['rotate', 'rotate', 'rotate-cw', 'rotateHardwareHint'], ['scale', 'scaleTool', 'scaling', 'scaleHardwareHint']].map(([tool, label, name, help]) => `<button type="button" class="icon-button" data-tool="${tool}" aria-label="${esc(t(label))}" ${editHelp(help)} aria-pressed="${gizmo === tool}">${icon(name)}</button>`).join('')}</div><details class="transform-options"><summary class="icon-button" aria-label="${esc(t('placementOptions'))}" ${editHelp('placementOptionsHint')}>${icon('sliders-horizontal')}</summary><div class="popover"><label class="check" ${editHelp('snapHint')}><input type="checkbox" id="snap" ${editHelp('snapHint')} ${snap ? 'checked' : ''}>${esc(t('snap'))}</label><label for="axis">${esc(t('axis'))}</label><select id="axis" ${editHelp('axisHint')}>${options([['', t('allAxes')], ['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], axisConstraint)}</select></div></details></div>` : ''}
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
    const shortDate = date(n.at);
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
    const draft = linkDrafts[e.id] ||= newLinkDraft(e);
    const searchable = e.links.length > 6;
    if (!searchable) delete linkSearches[e.id];
    element.innerHTML = `
        <form class="composer link-composer ${draft.open ? 'composing' : ''}" id="link-form" novalidate>
            <input id="link-title" name="title" aria-label="${esc(t('title'))}" placeholder="${esc(t(draft.open ? 'title' : 'addLink'))}" maxlength="160" value="${esc(draft.title)}">
            <div class="link-fields" ${draft.open ? '' : 'hidden'}>
                <input id="link-url" name="url" type="text" inputmode="url" aria-label="${esc(t('url'))}" placeholder="${esc(t('url'))}" value="${esc(draft.url)}">
                <textarea id="link-description" name="description" aria-label="${esc(t('description'))}" placeholder="${esc(t('description'))}" maxlength="1000">${esc(draft.description)}</textarea>
                <div class="row between"><button type="button" class="quiet" data-action="cancelLink">${esc(t('cancel'))}</button><button type="submit" class="primary">${esc(t('save'))}</button></div>
            </div>
            <p class="link-error" role="alert" ${draft.error ? '' : 'hidden'}>${draft.error ? esc(errorText({ key: draft.error })) : ''}</p>
            ${draft.conflict ? button('reviewConflict', 'linkConflict', 'quiet') : ''}
        </form>
        ${searchable ? `<div class="searchbox link-search">
            ${icon('search', 'search-icon')}
            <input id="link-search" type="search" value="${esc(linkSearches[e.id] || '')}" placeholder="${esc(t('searchLinks'))}" aria-label="${esc(t('searchLinks'))}" aria-controls="link-results" autocomplete="off">
        </div>` : ''}
        <div id="link-results">${e.links.map(link => `
            <article class="link-card">
                <a class="document-open" href="${esc(link.url)}" ${opensInBrowser(link.url) ? 'target="_blank"' : ''} rel="noopener noreferrer" title="${esc(link.url)}">
                    <span class="document-label">
                        <span class="document-title">${esc(link.title)}</span>
                        <small class="document-url">${esc(link.url)}</small>
                    </span>
                    ${icon('link')}
                </a>
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
            form.querySelector('#link-title').placeholder = t('title');
            form.querySelector('.link-fields').hidden = false;
            persistLinks();
        }
    });
    form.addEventListener('input', event => {
        if (['title', 'url', 'description'].includes(event.target.name)) {
            invalidateDraftUndo('documentation', e.id);
            draft[event.target.name] = event.target.value;
            draft.requestId = uid();
            persistLinks();
        }
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (draft.saving) return;
        const current = exhibit();
        const submitted = { ...draft };
        draft.saving = true;
        persistLinks();
        form.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = true; });
        try {
            if (!draft.title.trim()) throw Error('invalidInput');
            const url = documentUrl(draft.url);
            if (!url) throw Error('invalidUrl');
            draft.url = url;
            form.querySelector('#link-url').value = url;
            persistLinks();
            const result = await api.save({
                action: 'putLink', exhibitId: current.id, linkId: submitted.id,
                title: submitted.title.trim(), url, description: submitted.description.trim(),
                baseRevision: submitted.baseRevision, contentTag: submitted.contentTag, requestId: submitted.requestId
            });
            if (linkDrafts[current.id] === draft) delete linkDrafts[current.id];
            persistLinks();
            acceptSnapshot(result.snapshot);
            announce(t('saved'));
        } catch (error) {
            draft.error = error.key || error.message || 'storage';
            draft.conflict = error.status === 409;
            persistLinks();
        } finally {
            draft.saving = false;
            if (linkDrafts[current.id] === draft && selected === current.id && tab === 'documentation' && !edit) renderPanel();
        }
    });
    if (draft.saving) form.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = true; });
}

function newLinkDraft(record, link = null) {
    return {
        open: Boolean(link), id: link?.id || null,
        title: link?.title || '', url: link?.url || '', description: link?.description || '',
        baseRevision: record.revision, contentTag: record.contentTag, requestId: uid()
    };
}

async function linkConflict() {
    const id = selected, draft = linkDrafts[id];
    if (!draft || draft.saving) return;
    const live = await api.load();
    const current = live.exhibits.find(record => record.id === id);
    if (!current) throw Error('notFound');
    const link = current.links.find(item => item.id === draft.id);
    if (draft.id && !link) throw Error('notFound');
    const text = value => [value.title, value.url, value.description].filter(Boolean).join('\n');
    showDialog('reviewConflict', `<h3>${esc(t('current'))}</h3><div class="diff">${esc(link ? text(link) : current.links.map(text).join('\n\n'))}</div><h3 style="margin-top:20px">${esc(t('yours'))}</h3><div class="diff">${esc(text(draft))}</div>${footer('rebase')}`, async () => {
        draft.baseRevision = current.revision;
        draft.contentTag = current.contentTag;
        draft.requestId = uid();
        delete draft.conflict;
        delete draft.error;
        persistLinks();
        closeDialog();
        acceptSnapshot(live);
    });
}

function noteLinkDialog() {
    if (!noteEditor) return;
    const editor = noteEditor, link = editor.link();
    const key = 'noteLink:' + selected + ':' + drafts[selected].localId;
    showDialog('link', `<div class="field"><label for="note-link-url">URL</label><input id="note-link-url" name="url" type="text" inputmode="url" value="${esc(link.url)}" placeholder="${esc(t('url'))}"></div>${link.text ? '' : `<div class="field"><label for="note-link-text">${esc(t('title'))}</label><input id="note-link-text" name="text"></div>`}${footer('apply')}`, async form => {
        const url = String(form.get('url')).trim();
        if (url && !safeUrl(url)) throw Error('invalidUrl');
        closeDialog();
        editor.setLink(url, String(form.get('text') || ''));
    }, key);
}

function newDraft(e, n = null) {
    return {
        body: n?.body || '',
        signature: '',
        images: [],
        existingImages: n?.images || [],
        status: '',
        localId: uid(),
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
        onChange: value => { invalidateDraftUndo('notes', e.id); touchNoteDraft(d); d.body = value; delete d.error; persistDrafts(); },
        onFocus: () => {
            d.open = true;
            form.classList.add('composing');
            form.querySelector('.composer-expanded').hidden = false;
            persistDrafts();
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
        invalidateDraftUndo('notes', e.id);
        if (d.signature !== ev.target.value) touchNoteDraft(d, true);
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
        invalidateDraftUndo('notes', e.id);
        touchNoteDraft(d);
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
    invalidateDraftUndo('notes', id);
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
            if (drafts[id] !== draft && cancelledDraft?.draft !== draft) return;
            touchNoteDraft(draft);
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
        const imageIds = [...d.existingImages, ...d.images.filter(image => image.uploaded).map(image => image.uploaded)];
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
        const result = await api.postNote(payload, d.images.filter(image => !image.uploaded));
        if (drafts[id] === d) delete drafts[id];
        persistDrafts();
        acceptSnapshot(result.snapshot);
        announce(t('saved'));
    } catch (error) {
        d.error = error.key || 'storage';
        d.conflict = error.status === 409;
        persistDrafts();
        if (id === selected && tab === 'notes' && !edit) renderComposer();
    } finally {
        d.saving = false;
        if (drafts[id] && id === selected && tab === 'notes' && !edit) renderComposer();
    }
}

function acceptSnapshot(value) {
    snapshot = value;
    for (const record of value.exhibits) {
        const draft = drafts[record.id];
        if (draft && !draft.body.trim() && !draft.images.length && !draft.existingImages.length && !draft.noteId) draft.baseRevision = record.revision;
        const link = linkDrafts[record.id];
        if (link && !link.id && !link.title.trim() && !link.url.trim() && !link.description.trim()) {
            link.baseRevision = record.revision;
            link.contentTag = record.contentTag;
        }
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
    const dirty = Boolean(edit.changes().length || creation || Object.keys(editorFields).length);
    el.classList.toggle('signing', signing);
    const label = creation ? `<button type="button" class="quiet edit-session-label" data-action="resumeCreation" title="${esc(t('resumeCreation'))}">${esc(t(creation.kind === 'floors' ? 'newFloor' : 'newExhibit'))}</button>` : `<span class="edit-session-label" ${editHelp('editDraftHint')}>${esc(t('editingShort'))}${dirty ? '<i aria-hidden="true"></i>' : ''}</span>`;
    el.innerHTML = `<div class="edit-session-heading">${label}
        <div class="edit-history">${iconButton('undo', 'undo', 'undo-2', !edit.undoStack.length || editSave?.saving ? 'disabled' : '', 'undoEditHint')}${iconButton('redo', 'redo', 'redo-2', !edit.redoStack.length || editSave?.saving ? 'disabled' : '', 'redoEditHint')}</div></div>
        ${signing ? `<label class="sr-only" for="edit-signature">${esc(t('signature'))}</label><input id="edit-signature" ${editHelp('editSignatureHint')} autocomplete="off" maxlength="120" placeholder="${esc(t('yourName'))}" value="${esc(editSave.signature)}" aria-describedby="edit-save-error">` : ''}
        <div class="edit-session-actions" role="group" aria-label="${esc(t('editStructure'))}">${button('cancel', signing ? 'cancelEditSignature' : 'cancelEdit', 'quiet', editHelp(signing ? 'cancelSignatureHint' : 'cancelEditHint'))}<button type="button" class="primary" data-action="${signing ? 'confirmEditSave' : 'saveExit'}" ${editHelp(creation ? 'finishCreation' : editConflict ? 'resolveChanges' : signing ? 'saveEditHint' : 'signEditHint')} ${editSave?.saving || creation || editConflict || !dirty || (signing && !editSave.signature.trim()) ? 'disabled' : ''}>${esc(t(editSave?.saving ? 'saving' : 'save'))}</button></div>
        <div class="error" id="edit-save-error" role="alert" ${editSave?.error ? '' : 'hidden'}><span>${esc(editSave?.error ? t(editSave.error === 'conflict' ? 'editConflictHint' : editSave.error) : '')}</span>${editSave?.error === 'conflict' ? button('resolveChanges', 'structureConflict', 'quiet') : ''}</div>`;
    $('#edit-signature')?.addEventListener('input', event => {
        editSave.signature = event.target.value;
        $('[data-action=confirmEditSave]').disabled = editSave.saving || Boolean(creation || editConflict) || !edit.changes().length || !editSave.signature.trim();
        persistEdit();
    });
    $('#edit-signature')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); confirmEditSave(); }
    });
}

function editorMenu(record) {
    if (!record || editingFloor) return '';
    return `<details class="editor-menu"><summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('ellipsis')}</summary><div class="popover">${menuButton('duplicate', 'duplicateExhibit', 'copy-plus', editHelp('duplicateExhibitHint'))}<button type="button" class="quiet danger" data-trash-exhibit="${esc(record.id)}" ${editHelp(record.notes.length || record.links.length ? 'notEmpty' : 'removeExhibitHint')} ${record.notes.length || record.links.length ? 'disabled' : ''}>${icon('trash')}<span>${esc(t('deleteExhibit'))}</span></button></div></details>`;
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
        <div class="grid2"><div class="field"><label for="floor-name-de">${esc(t('nameDe'))}</label><input id="floor-name-de" ${editHelp('floorNameHint')} data-floor-name="de" maxlength="200" value="${esc(record.names.de)}" placeholder="${esc(record.id)}"></div><div class="field"><label for="floor-name-en">${esc(t('nameEn'))}</label><input id="floor-name-en" ${editHelp('floorNameHint')} data-floor-name="en" maxlength="200" value="${esc(record.names.en)}" placeholder="${esc(record.id)}"></div></div>
        ${viewPresets(record)}` : `
        <div class="field"><label for="ex-floor">${esc(t('floor'))}</label><select id="ex-floor" name="floorId" ${editHelp('floorAssignmentHint')}>${options([['', t('noFloor')], ...data().floors.map(item => [item.id, item.names[lang()]])], record.floorId || '')}</select></div>
        <div class="instance-heading row between"><h3>${esc(t('modelInstances'))}</h3><details class="hardware-picker"><summary class="icon-button" aria-label="${esc(t('addModel'))}" ${editHelp('addHardwareHint')}>${icon('plus')}</summary><div class="popover">${hardware.map(asset => `<button type="button" data-add-hardware="${esc(asset.id)}" ${editHelp('addHardwareHint')}>${esc(asset.name)}</button>`).join('') || `<p class="small muted">${esc(t('noHardware'))}</p>`}${button('models', 'models', 'quiet')}</div></details></div>
        <div id="instance-list">${record.models.map((instance, index) => {
            const asset = hardware.find(item => item.id === instance.model);
            return `<article class="model-instance ${index === activeInstance ? 'active' : ''}">
                <div class="instance-header"><button type="button" class="quiet instance-name" data-edit-instance="${index}" aria-pressed="${index === activeInstance}" ${editHelp('selectHardwareHint')}>${esc(asset?.name || instance.model)}${record.models.filter(item => item.model === instance.model).length > 1 ? `<small>${index + 1}</small>` : ''}</button>
                    <details class="instance-menu"><summary class="icon-button" aria-label="${esc(t('more') + ': ' + (asset?.name || instance.model))}" title="${esc(t('more') + ': ' + (asset?.name || instance.model))}">${icon('ellipsis')}</summary><div class="popover"><button type="button" data-duplicate-instance="${index}" ${editHelp('duplicateHardwareHint')}>${icon('copy-plus')}<span>${esc(t('duplicate'))}</span></button><button type="button" class="danger" data-remove-instance="${index}" ${editHelp('removeHardwareHint')}>${icon('trash')}<span>${esc(t('remove'))}</span></button></div></details></div>
                <details class="instance-placement"><summary ${editHelp('instancePlacementHint')}>${esc(t('placement'))}</summary><label class="sr-only" for="instance-model-${index}">${esc(t('model'))}</label><select id="instance-model-${index}" data-instance-model="${index}" ${editHelp('replaceHardwareHint')}>${options(hardware.map(item => [item.id, item.name]), instance.model)}</select>${vectorFields(instance.transform, `data-instance="${index}"`, index)}</details>
            </article>`;
        }).join('')}</div>
        ${record.models.length ? `<details class="exhibit-transform"><summary ${editHelp('groupTransformHint')}>${esc(t('exhibitTransform'))}</summary>${vectorFields(record.transform, 'data-group-vector')}</details>` : ''}
        ${viewPresets(record)}`;
    $('#structure-slot').innerHTML = `<form id="structure-form" novalidate>${content}<div class="error" id="structure-error" role="alert" hidden></div></form>`;
    const form = $('#structure-form');
    const fieldsKey = (editingFloor ? 'floors:' : 'exhibits:') + record.id;
    const fields = editorFields[fieldsKey] || {};
    form.querySelectorAll('input, select').forEach(input => {
        if (fields[input.id] !== undefined) input.value = fields[input.id];
    });
    form.addEventListener('input', event => {
        if (!event.target.id) return;
        (editorFields[fieldsKey] ||= {})[event.target.id] = event.target.value;
        persistEdit();
        renderEditBar();
    });
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

function closeDialog(form = null) {
    if (form && !form.isConnected) return;
    captureDialogDraft();
    dialogDraftKey = null;
    dialogCleanup?.();
    dialogCleanup = null;
    $('#dialog').close();
    $('#dialog').innerHTML = '';
}

function captureDialogDraft() {
    if (!dialogDraftKey) return;
    const draft = dialogDrafts[dialogDraftKey];
    const form = $('#dialog-form');
    if (!draft || !form) return;
    draft.fields = Object.fromEntries([...form.querySelectorAll('input:not([type=file]), textarea, select')].map(input => [input.name || input.id, input.type === 'checkbox' ? input.checked : input.value]));
    persistDialogs();
}

function showDialog(title, html, onSubmit = null, draftKey = null) {
    closeDialog();
    const dialog = $('#dialog');
    dialog.innerHTML = `<div class="dialog-header"><h2>${esc(t(title))}</h2><button type="button" data-action="closeDialog" class="quiet" aria-label="${esc(t('close'))}" title="${esc(t('close'))}">${icon('x')}</button></div><form class="dialog-body" id="dialog-form" novalidate>${html}<div id="dialog-error" class="error" role="alert" hidden></div></form>`;
    const draft = draftKey ? dialogDrafts[draftKey] = structuredClone(dialogDrafts[draftKey] || { fields: {} }) : null;
    dialogDraftKey = draftKey;
    if (draft) {
        $('#dialog-form').querySelectorAll('input:not([type=file]), textarea, select').forEach(input => {
            const value = draft.fields?.[input.name || input.id];
            if (value === undefined) return;
            if (input.type === 'checkbox') input.checked = Boolean(value);
            else input.value = value;
        });
        $('#dialog-form').addEventListener('input', captureDialogDraft);
        $('#dialog-form').addEventListener('change', captureDialogDraft);
    }
    if (onSubmit) $('#dialog-form').addEventListener('submit', async e => {
        e.preventDefault();
        const submit = e.submitter;
        if (submit?.disabled) return;
        try {
            if (submit) submit.disabled = true;
            if (draftKey === dialogDraftKey) captureDialogDraft();
            const fields = JSON.stringify(draft?.fields);
            const saved = await onSubmit(new FormData(e.target), e.target);
            if (draftKey && saved !== false && dialogDrafts[draftKey] === draft && JSON.stringify(draft.fields) === fields) {
                delete dialogDrafts[draftKey];
                persistDialogs();
            }
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
        key = 'status:' + e.id;
    const draft = dialogDrafts[key] ||= { fields: {}, status: chosenStatus, requestId: uid() };
    if (arguments.length) draft.status = chosenStatus;
    else chosenStatus = draft.status;
    persistDialogs();
    showDialog('changeStatus', `<p style="margin-bottom:18px">${esc(e.name)}</p><p class="chosen-status">${statusHTML(chosenStatus)}</p>${signatureField()}${footer()}`, async (form, element) => {
        const signature = requireSignature(form);
        const result = await api.save({
            action: 'status',
            exhibitId: e.id,
            baseRevision: e.revision,
            requestId: draft.requestId,
            signature,
            status: chosenStatus
        });
        closeDialog(element);
        acceptSnapshot(result.snapshot);
        announce(t('saved'));
    }, key);
}

function editLink(id = null) {
    const record = exhibit();
    const link = record.links.find(item => item.id === id);
    if (id && !link) return;
    invalidateDraftUndo('documentation', record.id);
    const pending = linkDrafts[record.id];
    if (pending && (pending.title.trim() || pending.url.trim() || pending.description.trim() || pending.id)) {
        pending.open = true;
        renderPanel();
        $('#link-title')?.focus();
        announce(t('draft'));
        return;
    }
    linkDrafts[record.id] = newLinkDraft(record, link);
    linkDrafts[record.id].open = true;
    persistLinks();
    renderPanel();
    $('#link-title')?.focus();
}

function deleteLink(id) {
    const record = exhibit();
    const link = record.links.find(item => item.id === id);
    if (!link) return;
    showDialog('remove', `<p>${esc(link.title)}</p>${footer('remove')}`, async (_form, element) => {
        const result = await api.save({
            action: 'deleteLink', exhibitId: record.id, linkId: id,
            baseRevision: record.revision, contentTag: record.contentTag, requestId: uid()
        });
        closeDialog(element);
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
    editorFields = {};
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
    const inputs = [...($('#structure-form')?.querySelectorAll('input, select') || [])];
    const invalid = inputs.find(input => !input.checkValidity() || input.type === 'number' && !input.value.trim());
    if (invalid) {
        structureError(invalid.type === 'number' ? 'invalidTransform' : 'invalidInput', invalid);
        return false;
    }
    const record = editingFloor ? data().floors.find(item => item.id === editingFloor) : exhibit();
    const key = (editingFloor ? 'floors:' : 'exhibits:') + record?.id;
    const fields = editorFields[key] || {};
    for (const input of inputs.filter(input => fields[input.id] !== undefined)) {
        if (!applyEditorField(input)) return false;
    }
    if (record) delete editorFields[key];
    for (const pending of Object.keys(editorFields)) {
        const separator = pending.indexOf(':');
        const kind = pending.slice(0, separator), id = pending.slice(separator + 1);
        const target = data()[kind]?.find(item => item.id === id);
        if (!target) { delete editorFields[pending]; continue; }
        if (kind === 'floors') floorId = id;
        else {
            selected = id;
            if (target.floorId) floorId = target.floorId;
        }
        structureDialog(kind);
        return validEditorFields();
    }
    persistEdit();
    return true;
}

function applyEditorField(input) {
    if (!edit || editSave?.saving) return false;
    const record = editingFloor ? data().floors.find(item => item.id === editingFloor) : exhibit();
    if (!record) return false;
    if (!input.checkValidity() || input.type === 'number' && !input.value.trim()) {
        structureError('invalidTransform', input);
        return false;
    }
    if ($('#structure-error')) $('#structure-error').hidden = true;
    const reset = input.id === 'ex-floor' && Boolean(input.value) && input.value !== floorId;
    const previousFloor = floorId;
    const fieldsKey = (editingFloor ? 'floors:' : 'exhibits:') + record.id;
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
        if (editorFields[fieldsKey]) {
            delete editorFields[fieldsKey][input.id];
            if (!Object.keys(editorFields[fieldsKey]).length) delete editorFields[fieldsKey];
            persistEdit();
        }
        return true;
    } catch (error) { floorId = previousFloor; structureError(error.key || error.message, input); }
    return false;
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
        <div class="field"><label for="floor-number">${esc(t('floorNumber'))}</label><input id="floor-number" ${editHelp('floorNumberHint')} data-create-field="number" type="number" step="1" required value="${esc(record.number)}"></div>
        <div class="grid2"><div class="field"><label for="floor-name-de">${esc(t('nameDe'))}</label><input id="floor-name-de" ${editHelp('floorNameHint')} data-create-field="de" maxlength="200" value="${esc(record.de)}"></div><div class="field"><label for="floor-name-en">${esc(t('nameEn'))}</label><input id="floor-name-en" ${editHelp('floorNameHint')} data-create-field="en" maxlength="200" value="${esc(record.en)}"></div></div>` : `
        <div class="field"><label for="ex-name">${esc(t('name'))}</label><input id="ex-name" ${editHelp('exhibitNameHint')} data-create-field="name" maxlength="160" required value="${esc(record.name)}" autocomplete="off"></div>
        <div class="field"><label for="ex-floor">${esc(t('floor'))}</label><select id="ex-floor" data-create-field="floorId" ${editHelp('floorAssignmentHint')}>${options([['', t('noFloor')], ...data().floors.map(item => [item.id, item.names[lang()]])], record.floorId)}</select></div>`;
    $('#structure-slot').innerHTML = `<form id="creation-form" novalidate>${fields}<div class="error" id="structure-error" role="alert" hidden></div><div class="creation-actions">${button('cancel', 'cancelCreation', 'quiet', editHelp('cancelCreationHint'))}<button type="submit" class="primary" ${editHelp(isFloor ? 'createFloorHint' : 'createExhibitHint')}>${esc(t('create'))}</button></div></form>`;
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
    cancelledEdit = { edit, creation, creationOpen, editingFloor, selected, floorId, activeInstance, gizmo, editorFields, editSave, editConflict };
    const dirty = edit.changes().length || creation || Object.keys(editorFields).length || edit.undoStack.length || edit.redoStack.length;
    edit = null;
    creation = null;
    creationOpen = false;
    editingFloor = null;
    editSave = null;
    editConflict = null;
    recoverableEdit = null;
    editorFields = {};
    gizmo = '';
    persistEdit();
    render();
    syncEditTools();
    syncUrl();
    if (dirty) announce(t('editsCancelled'), 'restoreEdit');
}

function restoreEdit() {
    if (edit || !cancelledEdit) return;
    ({ edit, creation, creationOpen, editingFloor, selected, floorId, activeInstance, gizmo, editorFields, editSave, editConflict } = cancelledEdit);
    cancelledEdit = null;
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
    persistEdit();
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
        editorFields = {};
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
            persistEdit();
        }
    }
}

function cancelEditSignature() {
    if (!editSave) return;
    const save = editSave;
    save.controller?.abort();
    editSave = { signing: false, saving: false, signature: save.signature, requestId: save.requestId, error: null };
    persistEdit();
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
        <div class="field model-import"><button type="button" id="choose-model-file" class="quiet" title="${esc(t('chooseFile'))}">${icon('plus')}<span>${esc(modelDraft?.file?.name || t('chooseFile'))}</span></button><input type="file" name="model" id="model-file" accept=".glb,model/gltf-binary" hidden></div>
        ${footer()}`, async () => {
        const pending = modelDraft;
        const file = pending?.file;
        if (!file?.size) throw Error('invalidModel');
        if (file.size > 32 * 1024 * 1024) throw Error('fileTooLarge');
        $('#choose-model-file').disabled = true;
        try {
            const { inspectModel } = await import('./map.js');
            const dimensions = await inspectModel(file);
            if (closed) return false;
            await api.upload(file, 'model', '', pending.requestId, dimensions, null, { signal: controller.signal });
            const live = await api.load();
            if (edit) {
                edit.value.assets = structuredClone(live.assets);
                edit.base.assets = structuredClone(live.assets);
                persistEdit();
            }
            if (modelDraft === pending) {
                modelDraft = null;
                saveLocalDraft('model', null);
            }
            if (!closed) closeDialog();
            acceptSnapshot(live);
            announce(t('saved'));
        } catch (error) {
            if (error.name !== 'AbortError') throw error;
            return false;
        } finally {
            if (!closed) $('#choose-model-file').disabled = false;
        }
    });
    dialogCleanup = () => { closed = true; controller.abort(); };
    const submit = $('#dialog button[type=submit]');
    submit.disabled = !modelDraft?.file;
    $('#choose-model-file').addEventListener('click', () => $('#model-file').click());
    $('#model-file').addEventListener('change', event => {
        const file = event.target.files[0];
        if (!file) return;
        modelDraft = { file, requestId: uid() };
        saveLocalDraft('model', modelDraft);
        $('#choose-model-file span').textContent = file.name;
        submit.disabled = false;
    });
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
    persistEdit();
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
        persistEdit();
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
        const saved = recoverableEdit;
        if (!saved?.base || !saved.value) return;
        const session = new EditSession(saved.base);
        session.value = saved.value;
        if (!session.changes().length && !saved.creation && !Object.keys(saved.editorFields || {}).length && !saved.undoStack?.length && !saved.redoStack?.length) {
            recoverableEdit = null;
            persistEdit();
            return;
        }
        recoverableEdit = saved;
        announce(t('unsavedEdits'), 'recoverEdit', 'recover');
    } catch { recoverableEdit = null; persistEdit(); }
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
    editorFields = saved.editorFields || {};
    snap = Boolean(saved.snap);
    axisConstraint = saved.axisConstraint || '';
    editSave = saved.editSave ? { ...saved.editSave, saving: false } : null;
    editConflict = saved.editConflict || null;
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
    resumeNote: () => { drafts[selected].readOnly = false; persistDrafts(); renderPanel(); },
    backToNote: () => { drafts[selected].readOnly = true; persistDrafts(); renderPanel(); },
    discardDraft: () => discardComposerDraft('notes'),
    restoreDraft,
    cancelCreation,
    cancelEdit,
    cancelEditSignature,
    confirmEditSave,
    restoreEdit,
    recoverEdit,
    resumeCreation: () => structureDialog(creation.kind, true),
    duplicateExhibit: () => duplicateSelected(),
    cancelConflict: () => { editConflict.open = false; persistEdit(); renderInspector(); renderMapUI(); syncEditTools(); },
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
    linkConflict,
    status: statusDialog,
    addLink: () => editLink(),
    cancelLink: () => discardComposerDraft('documentation'),
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
    undo: () => { if (editSave?.saving || !edit?.undoStack.length) return; map?.cancelTransform(); edit.undo(); editorFields = {}; editConflict = null; changed(); },
    redo: () => { if (editSave?.saving || !edit?.redoStack.length) return; map?.cancelTransform(); edit.redo(); editorFields = {}; editConflict = null; changed(); },
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
            invalidateDraftUndo('notes', record.id);
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
            try { await copyText(link.url); announce(t('copied')); }
            catch { announce(t('copyFailed')); }
            return;
        }
        if (element.dataset.removeImage !== undefined) {
            touchNoteDraft(drafts[selected]);
            drafts[selected].images.splice(Number(element.dataset.removeImage), 1);
            persistDrafts(); renderComposer(); return;
        }
        if (element.dataset.removeExisting) {
            touchNoteDraft(drafts[selected]);
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
    captureDialogDraft(); persistDrafts(); persistLinks(); persistEdit();
});
setView('list');
renderHeader();
$('#sidebar').innerHTML = '<p>' + esc(t('loading')) + '</p>';
try {
    snapshot = await api.load();
    await loadDrafts();
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
