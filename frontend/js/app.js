import { installControlMotion } from './control-motion.js';
import {
    Api,
    uid
} from './api.js';
import {
    EditSession,
    identity,
    STATUSES,
    normalizeStatus, validTransform, normalizeTransform
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
import { cameraMode, viewMode } from './camera.js';
import { CameraControls } from './camera-controls.js';
import { PanelMotion, inspectorContext } from './panel-motion.js';
import { editHelp, transformNumber, viewPresets, exhibitName, newExhibit, duplicateExhibit, rebaseEdit, editWasSaved } from './edit.js';
import { icon } from './icons.js';
import { colorMode, onColorModeChange } from './colors.js';
import { safeUrl, documentUrl, opensInBrowser } from './domain.js';
import { copyText } from './clipboard.js';
import { DraftStore, hasNoteDraft, hasLinkDraft, editSnapshot, restoreEditSnapshot } from './drafts.js';
import { normalizeHardwareSelection, commonTransform, hardwareSelected, wholeHardwareSelection, pickHardwareSelection } from './transform-selection.js';
import { hardwareParameters, exhibitParameters, selectionParameters } from './placement-inspector.js';
import { InspectorNavigation } from './inspector-navigation.js';
import { installNumberDrag, updateNumberFills } from './number-drag.js';
import { rememberedSignature, rememberSignature } from './signature.js';
let noteEditor = null;
installSelects();
installControlMotion();
const $ = s => document.querySelector(s),
    api = new Api();
const panelMotion = new PanelMotion($('#inspector'), $('#resizer'), $('#inspector-stack'), {
    sidebar: $('#sidebar'), editbar: $('#editbar'), underlays: $('#inspector-underlays')
});
const inspectorNavigation = new InspectorNavigation($('#inspector'));
let snapshot = null,
    selected = null,
    floorId = '0',
    activeInstance = 0,
    tab = 'notes',
    edit = null,
    map = null,
    mapPromise = null,
    mapControls = null,
    mapState = 'mapLoading',
    view = 'list',
    query = '',
    scope = 'name',
    floorFilter = '',
    statusFilter = '',
    statusSaving = false,
    mapMode = 'top',
    gizmo = '',
    axisConstraint = '',
    snap = false,
    noticeTimer, noticeClearTimer;
let creation = null, creationOpen = false, editConflict = null;
let editSelection = new Set();
let hardwareSelection = [];
let transformSpace = 'world';
let numberDrag;
let joinGeneration = 0;
let editSave = null, cancelledEdit = null;
let recoverableEdit = null;
let drafts = Object.create(null), draftStore = null, cancelledDraft = null;
let linkDrafts = Object.create(null), dialogDrafts = Object.create(null);
const linkSearches = Object.create(null), draftErrors = new Set();
function loadDrafts() {
    try {
        draftStore = new DraftStore(snapshot.datasetKey);
        draftStore.migrate(snapshot.datasetKey);
    } catch { announce(t('draftFailed')); }
    try {
        drafts = Object.assign(Object.create(null), draftStore?.read('notes') || {});
        linkDrafts = Object.assign(Object.create(null), draftStore?.read('links') || {});
        dialogDrafts = Object.assign(Object.create(null), draftStore?.read('dialogs') || {});
        const obsoleteDrafts = Object.keys(dialogDrafts).filter(key => ['changeStatus:', 'models:', 'modelPreview:'].some(prefix => key.startsWith(prefix)));
        if (obsoleteDrafts.length) {
            obsoleteDrafts.forEach(key => delete dialogDrafts[key]);
            saveDraftCategory('dialogs', dialogDrafts);
        }
        draftStore?.write('model', null);
        for (const [id, saved] of Object.entries(drafts)) {
            if (!saved || typeof saved !== 'object') { delete drafts[id]; continue; }
            const record = snapshot.exhibits.find(item => item.id === id);
            const draft = drafts[id] = { ...newDraft(record || {}), ...saved };
            for (const key of ['body', 'signature']) if (typeof draft[key] !== 'string') draft[key] = '';
            for (const key of ['images', 'existingImages']) if (!Array.isArray(draft[key])) draft[key] = [];
            draft.saving = false;
            draft.readingImages = false;
            if (draft.status === 'unset') draft.status = 'ok';
        }
        for (const [id, draft] of Object.entries(linkDrafts)) {
            if (!draft || typeof draft !== 'object') { delete linkDrafts[id]; continue; }
            for (const key of ['title', 'url', 'description']) if (typeof draft[key] !== 'string') draft[key] = '';
            draft.saving = false;
        }
    } catch {
        drafts = Object.create(null);
    }
}
const data = () => edit?.value || snapshot;
const exhibit = () => data()?.exhibits.find(e => e.id === selected);
const selectedExhibits = () => data()?.exhibits.filter(record => editSelection.has(record.id)) || [];
const isSelected = id => edit ? editSelection.has(id) : id === selected;
const floor = () => data()?.floors.find(f => f.id === floorId);
function selectionTransforms() {
    if (!edit) return [];
    if (hardwareSelection.length) return hardwareSelection.flatMap(entry => {
        const record = data().exhibits.find(record => record.id === entry.exhibitId);
        const transform = record?.models[entry.instanceIndex]?.transform;
        return transform && record.floorId === floorId ? [{ ...entry, transform }] : [];
    });
    const records = selectedExhibits();
    if (records.some(record => record.floorId !== floorId)) return [];
    return records.filter(record => record.models.length).map(record => ({ exhibitId: record.id, transform: record.transform }));
}

function fieldTargets(input) {
    if (input.hasAttribute('data-selection-delta')) return selectionTransforms();
    const record = data().exhibits.find(record => record.id === (input.dataset.exhibit || selected));
    if (!record) return [];
    const instanceIndex = input.hasAttribute('data-group-vector') ? undefined : Number(input.dataset.instance);
    const transform = instanceIndex == null ? record.transform : record.models[instanceIndex]?.transform;
    return transform ? [{ exhibitId: record.id, instanceIndex, transform }] : [];
}

function inspectorFieldTransform(input, preview = null) {
    if (input.hasAttribute('data-group-vector')) return map?.exhibitPlacement(input.dataset.exhibit || selected) || null;
    const entries = fieldTargets(input).map(entry => preview?.find(change => change.exhibitId === entry.exhibitId && change.instanceIndex === entry.instanceIndex) || entry);
    return entries.length ? commonTransform(entries) : null;
}

function commitTransforms(changes) {
    if (!edit || !changes.length) return;
    if (changes.some(change => !validTransform(change.transform))) { announce(t('invalidTransform')); return; }
    changes = changes.map(change => ({ ...change, transform: normalizeTransform(change.transform) }));
    map?.previewTransforms(changes);
    applyEdit(state => {
        for (const { exhibitId, instanceIndex, transform } of changes) {
            const record = state.exhibits.find(record => record.id === exhibitId);
            if (instanceIndex == null && record) record.transform = structuredClone(transform);
            else if (record?.models[instanceIndex]) record.models[instanceIndex].transform = structuredClone(transform);
        }
    });
    updateTransformFields();
}

function selectionFields(owner = null) {
    return selectionParameters({ owner, available: selectionTransforms().length > 1 });
}

function bindSelectionFields() {
    $('#structure-form')?.addEventListener('change', event => applyEditorField(event.target));
    $('#structure-form')?.addEventListener('submit', event => { event.preventDefault(); saveExit(); });
}

function renderSelectionInspector(hardware) {
    const records = selectedExhibits();
    const title = hardware ? `${hardwareSelection.length} ${t('hardwareComponents')}` : `${records.length} ${t('exhibits')}`;
    const problem = hardware ? '' : joinProblem(records);
    $('#inspector').innerHTML = `<div class="inspector-header"><h1>${esc(title)}</h1></div><div class="panel-content selection-panel" id="structure-panel">
        <form id="structure-form" novalidate>${selectionFields()}<div class="error" id="structure-error" role="alert" hidden></div></form></div>
        <div class="inspector-footer selection-footer"><div class="error" id="join-error" role="alert" ${problem ? '' : 'hidden'}>${esc(problem ? t(problem) : '')}</div>
        <div class="selection-actions">${button('cancel', 'cancelJoin', 'quiet')}${hardware ? '' : button('joinTogether', 'joinExhibits', 'primary', `${problem ? 'disabled' : ''} ${editHelp('joinHint')}`)}</div></div>`;
    bindSelectionFields();
    syncEditTools();
}

function selectParentExhibits(ids) {
    if (!edit || editSave?.saving) return;
    map?.cancelTransform(); numberDrag?.cancel(); joinGeneration++;
    const records = data().exhibits.filter(record => ids.includes(record.id));
    hardwareSelection = []; activeInstance = 0; editSelection = new Set(records.map(record => record.id));
    hardwareSelection = wholeHardwareSelection(editSelection, hardwareSelection, data());
    selected = editSelection.has(selected) ? selected : records[0]?.id || null;
    creationOpen = false;
    if (editConflict) editConflict.open = false;
    renderList(); renderInspector({ focusSelection: true, replaceSelection: true }); renderMapUI(); updateMap(); syncEditTools(); persistEdit(); syncUrl();
}

const titleFloor = id => data()?.floors.find(f => f.id === id)?.names[lang()] || id || t('noFloor');
onColorModeChange(() => { if (snapshot) renderList(); });
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
    if (action !== 'restoreEdit') cancelledEdit = null;
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
    cancelledDraft = null;
    cancelledEdit = null;
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

function updateDraftWarnings() {
    document.querySelectorAll('[data-draft-warning]').forEach(element => {
        element.hidden = !draftErrors.has(element.dataset.draftWarning);
    });
}

function draftWarning(name) {
    return `<p class="error" role="alert" data-draft-warning="${name}" ${draftErrors.has(name) ? '' : 'hidden'}>${esc(t('draftFailed'))}</p>`;
}

function saveDraftCategory(name, value) {
    try {
        if (!draftStore) throw Error('draftFailed');
        draftStore.write(name, value);
        draftErrors.delete(name);
        updateDraftWarnings();
        return true;
    } catch {
        if (!draftErrors.has(name)) announce(t('draftFailed'));
        draftErrors.add(name);
        updateDraftWarnings();
        return false;
    }
}

function persistDrafts() {
    return saveDraftCategory('notes', Object.fromEntries(Object.entries(drafts).filter(([, draft]) => hasNoteDraft(draft))));
}

function persistLinks() {
    return saveDraftCategory('links', Object.fromEntries(Object.entries(linkDrafts).filter(([, draft]) => hasLinkDraft(draft))));
}

function persistEdit() {
    if (!edit && recoverableEdit) return;
    saveDraftCategory('edit', edit && (edit.changes().length || creation) ? {
        base: editSnapshot(edit.base),
        value: editSnapshot(edit.value),
        creation,
        creationOpen,
        selected,
        selection: [...editSelection],
        hardwareSelection, transformSpace, axisConstraint, snap,
        floorId,
        activeInstance,
        gizmo,
        undoStack: edit.undoStack.map(editSnapshot),
        redoStack: edit.redoStack.map(editSnapshot),
        signature: editSave?.signature || '',
        requestId: editSave?.requestId || ''
    } : null);
}

function discardComposer(kind) {
    const id = selected, store = kind === 'notes' ? drafts : linkDrafts, draft = store[id];
    if (!draft || draft.saving) return;
    delete store[id];
    kind === 'notes' ? persistDrafts() : persistLinks();
    renderPanel();
    cancelledDraft = { kind, id, draft };
    announce(t('draftCancelled'), 'restoreDraft');
}

function restoreComposer() {
    const saved = cancelledDraft;
    if (!saved || edit) return;
    const store = saved.kind === 'notes' ? drafts : linkDrafts;
    const occupied = store[saved.id];
    if (saved.kind === 'notes' ? hasNoteDraft(occupied) : hasLinkDraft(occupied)) {
        announce(t('draftChanged')); return;
    }
    store[saved.id] = saved.draft;
    cancelledDraft = null;
    saved.kind === 'notes' ? persistDrafts() : persistLinks();
    tab = saved.kind === 'notes' ? 'notes' : 'documentation';
    select(saved.id);
    renderPanel();
    announce(t('draftRestored'));
}

function setView(value) {
    if (value === 'detail' && !exhibit() && !(edit && (creationOpen || editConflict?.open))) value = 'map';
    collapseEmptyDraft();
    view = value;
    document.body.dataset.view = value;
    inspectorNavigation.reveal();
    panelMotion.viewChanged();
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

function removeExhibit(id, origin = 'other') {
    if (!edit || editSave?.saving) return;
    const record = data().exhibits.find(item => item.id === id);
    if (!record) return;
    const remove = () => {
        closeDialog();
        map?.cancelTransform();
        applyEdit(state => { state.exhibits = state.exhibits.filter(item => item.id !== id); }, { rebuild: true, origin });
        announce(t('exhibitRemoved'), 'undo');
    };
    const createdAt = Date.parse(record.createdAt);
    const needsWarning = record.notes.length || record.links.length || !Number.isFinite(createdAt) || Date.now() - createdAt > 10 * 60 * 1000;
    if (!needsWarning) { remove(); return; }
    showDialog('deleteExhibit', `<p>${esc(record.name)}</p><p class="deletion-warning">${esc(t('deleteExhibitWarning'))}</p><p class="small muted deletion-hint">${esc(t('deleteOnSave'))}</p>${footer('deleteExhibit')}`, remove);
    $('#dialog button[type=submit]').className = 'danger';
}

function deleteNoteDialog(noteId) {
    const record = structuredClone(exhibit());
    const note = record.notes.find(n => n.id === noteId);
    if (!note || note.deleted) return;
    const requestId = uid();
    showDialog('deleteNote', `<p>${esc(t('noteBy'))} ${esc(note.author)} · ${esc(date(note.at))}</p><p class="muted small" style="margin:12px 0 20px">${esc(t('deleteNoteHint'))}</p>${signatureField()}${footer('deleteNote')}`, async (form, element) => {
        const signature = requireSignature(form);
        const result = await api.save({ action: 'deleteNote', exhibitId: record.id, noteId, baseRevision: record.revision, contentTag: record.contentTag, requestId, signature });
        rememberSignature(signature);
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
    const appliedStatusFilter = edit ? '' : statusFilter;
    const filtered = Boolean(query || floorFilter || appliedStatusFilter || scope !== 'name');
    const frows = [
        ['', t('allFloors')], ...data().floors.map(f => [f.id, f.names[lang()]]),
        ['unplaced', t('unplacedShort')]
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
                    <select id="scope">${options(['name', 'notes', 'documentation'].map(x => [x, t(x)]), scope)}</select>
                    <label for="floor-filter">${esc(t('floor'))}</label>
                    <select id="floor-filter">${options(frows, floorFilter)}</select>
                    ${edit ? '' : `<label for="status-filter">${esc(t('status'))}</label>
                    <select id="status-filter">${options([['', t('allStatuses')], ...STATUSES.map(x => [x, t(x)])], statusFilter)}</select>`}
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
                ${edit ? '' : `<details class="app-menu">
                    <summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('ellipsis')}</summary>
                    <div class="popover app-menu-popover">
                        ${menuButton('accessibility', 'accessibility', 'eye', `title="${esc(t('accessibilityHint'))}"`)}
                        ${menuButton('editStructure', 'enterEdit', 'pencil-line')}
                    </div>
                </details>`}
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
        $(selector)?.addEventListener('change', e => {
            setter(e.target.value);
            renderList();
        });
    }
    renderList();
}

function exhibitLabel(record, editable = false) {
    const text = displayName(record);
    const name = value => `<span class="exhibit-name" ${editable ? 'aria-hidden="true"' : ''}>${esc(value)}</span>`;
    let title = name(text);
    if (editable) {
        if (record.id === selected && editSelection.size === 1) {
            const end = text.search(/\S+$/u);
            title = `${name(text.slice(0, end))}<span class="exhibit-name-end">${name(text.slice(end))}<button type="button" class="icon-button exhibit-rename" data-rename-exhibit="${esc(record.id)}" aria-label="${esc(t('renameExhibit') + ': ' + text)}" ${editHelp('renameExhibitHint')}>${icon('pencil-line')}</button></span>`;
        }
        title = `<span class="exhibit-title-line">${title}</span>`;
    }
    return `<span class="exhibit-label">
        ${title}
        ${!edit && colorMode() !== 'default' ? `<span class="exhibit-status-name">${esc(t(record.status))}</span>` : ''}
        ${record.models.length ? '' : `<span class="unplaced-flag" title="${esc(t('unplaced'))}">${esc(t('unplacedShort'))}</span>`}
    </span>`;
}

let sidebarFrame = 0;
function fitSidebar() {
    cancelAnimationFrame(sidebarFrame);
    sidebarFrame = requestAnimationFrame(() => {
        sidebarFrame = 0;
        if (!snapshot || innerWidth <= 860) return;
        const sidebar = $('#sidebar');
        const measure = document.createElement('div');
        measure.className = 'exhibit-measure';
        measure.setAttribute('aria-hidden', 'true');
        measure.innerHTML = data().exhibits.map(record => exhibitLabel(record)).join('');
        sidebar.append(measure);
        let contentWidth = 0;
        for (const label of measure.children) contentWidth = Math.max(contentWidth, label.getBoundingClientRect().width);
        const style = getComputedStyle(sidebar);
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        measure.remove();
        // Reserve row padding, action or status space, and a scrollbar gutter.
        const width = Math.ceil(contentWidth + padding + 24 + (edit ? 106 : 32) + 16);
        document.documentElement.style.setProperty('--list-content', width + 'px');
    });
}

window.addEventListener('resize', fitSidebar, { passive: true });
document.fonts.ready.then(fitSidebar);

function renderList() {
    const q = query.trim().toLocaleLowerCase(lang());
    const appliedStatusFilter = edit ? '' : statusFilter;
    const records = data().exhibits.filter(e => {
        const matchesFloor = !floorFilter || (floorFilter === 'unplaced' ? !e.placed : e.floorId === floorFilter);
        if (!matchesFloor || appliedStatusFilter && e.status !== appliedStatusFilter) return false;
        if (!q) return true;
        const text = scope === 'notes' ? e.notes.filter(n => !n.deleted).map(n => n.body).join(' ') : scope === 'documentation' ? e.links.map(l => l.title + ' ' + l.url).join(' ') : e.name;
        return text.toLocaleLowerCase(lang()).includes(q);
    });
    const filtered = Boolean(query || floorFilter || appliedStatusFilter || scope !== 'name');
    $('.active-filters').hidden = !filtered;
    const floorDescription = floorFilter === 'unplaced' ? t('unplacedShort') : floorFilter ? titleFloor(floorFilter) : '';
    $('#filter-description').textContent = [scope !== 'name' ? t(scope) : '', floorDescription, appliedStatusFilter ? t(appliedStatusFilter) : '', query ? '“' + query + '”' : ''].filter(Boolean).join(' · ');
    $('#exhibit-list').innerHTML = records.length ? records.map(e => {
        const details = [titleFloor(e.floorId)];
        if (!e.placed) details.push(t('unplaced'));
        else if (!edit) details.push(t(e.status));
        if (edit) return `
        <div class="exhibit-entry ${isSelected(e.id) ? 'active' : ''}">
            <button type="button" class="exhibit-row ${isSelected(e.id) ? 'active' : ''}" data-select="${esc(e.id)}" aria-label="${esc(displayName(e))}" aria-pressed="${isSelected(e.id)}" title="${esc([...details, t('multiSelectHint')].join(' · '))}"></button>
            ${exhibitLabel(e, true)}
            ${e.id === selected && editSelection.size === 1 ? `<div class="item-actions exhibit-actions"><button type="button" class="icon-button" data-duplicate-exhibit="${esc(e.id)}" aria-label="${esc(t('duplicate') + ': ' + displayName(e))}" ${editHelp('duplicateExhibitHint')}>${icon('copy-plus')}</button><button type="button" class="icon-button danger" data-trash-exhibit="${esc(e.id)}" aria-label="${esc(t('deleteExhibit') + ': ' + displayName(e))}" ${editHelp('removeExhibitHint')}>${icon('trash')}</button></div>` : ''}
        </div>`;
        return `
        <div class="exhibit-entry"><button class="exhibit-row ${e.id === selected ? 'active' : ''}" data-select="${esc(e.id)}" aria-pressed="${e.id === selected}" title="${esc(details.join(' · '))}">
            <span class="status-symbol ${e.status}" ${colorMode() === 'default' ? `aria-label="${esc(t(e.status))}"` : 'aria-hidden="true"'}></span>
            ${exhibitLabel(e)}
        </button></div>`;
    }).join('') : `<p class="empty">${esc(t('noResults'))}</p>`;
    fitSidebar();
}

function updateMapHelp() {
    const canvas = $('#map-canvas canvas');
    if (!canvas) return;
    canvas.setAttribute('aria-label', t('mapKeyboardHint'));
    canvas.title = t('mapHelp');
}

function renderMapUI() {
    updateMapHelp();
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
    mapControls?.destroy();
    mapControls = new CameraControls($('#map-controls'), {
        id: 'map', mode: mapMode, getView: () => map,
        focus: () => actions.focus(),
        canFocus: () => Boolean(map?.focusObjects().length)
    });
    renderTransformToolbar();
    $('#map-message').textContent = mapState === 'mapReady' ? '' : t(mapState);
    map?.resize();
}

function renderTransformToolbar() {
    const toolbar = $('#transform-toolbar');
    const available = Boolean(edit && selectionTransforms().length && !creationOpen && !editConflict?.open);
    toolbar.hidden = !available;
    toolbar.setAttribute('aria-label', t('gizmo'));
    toolbar.innerHTML = available ? `<div class="transform-tools">${[['translate', 'move', 'move-3d', 'moveHardwareHint', 'G'], ['rotate', 'rotate', 'rotate-3d', 'rotateHardwareHint', 'R'], ['scale', 'scaleTool', 'square-upscale', 'scaleHardwareHint', 'S'], ['combined', 'combinedTransform', 'transform', 'combinedTransformHint', '']].map(([tool, label, name, help, shortcut]) => `<button type="button" class="icon-button" data-tool="${tool}" aria-label="${esc(t(label))}" ${editHelp(help)} aria-pressed="${gizmo === tool}">${icon(name)}${shortcut ? `<small class="tool-shortcut" aria-hidden="true">${shortcut}</small>` : ''}</button>`).join('')}</div><span class="toolbar-divider" aria-hidden="true"></span><details class="transform-options"><summary class="icon-button" aria-label="${esc(t('placementOptions'))}" ${editHelp('placementOptionsHint')}>${icon('sliders-horizontal')}</summary><div class="popover"><label class="check" ${editHelp('snapHint')}><input type="checkbox" id="snap" ${snap ? 'checked' : ''}>${esc(t('snap'))}</label><label for="transform-space">${esc(t('transformOrientation'))}</label><select id="transform-space">${options([['world', t('globalOrientation')], ['local', t('localOrientation')]], transformSpace)}</select><label for="axis">${esc(t('axis'))}</label><select id="axis" ${editHelp('axisHint')}>${options([['', t('allAxes')], ['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], axisConstraint)}</select></div></details>` : '';
    $('#snap')?.addEventListener('change', event => { snap = event.target.checked; syncEditTools(); persistEdit(); });
    $('#axis')?.addEventListener('change', event => { axisConstraint = event.target.value; syncEditTools(); persistEdit(); });
    $('#transform-space')?.addEventListener('change', event => { numberDrag?.cancel(); transformSpace = event.target.value; syncEditTools(); persistEdit(); });
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
            onSelect: (id, index, extend, hardware) => select(id, index, extend, hardware, 'viewport'),
            onMode: mode => { mapMode = mode; syncUrl(); mapControls?.update(); },
            onCamera: () => mapControls?.update(),
            onState: key => {
                mapState = key;
                $('#map-canvas').classList.toggle('floor-loading', key === 'mapLoading');
                $('#map-message').textContent = key === 'mapReady' ? '' : t(key);
                if (map === instance) updateTransformFields(null, { groupsOnly: true });
            },
            onTransform: commitTransforms,
            onTransformPreview: changes => updateTransformFields(changes),
            onInvalidTransform: key => announce(t(key || 'invalidTransform'))
        });
        await instance.init();
        map = instance;
        updateMapHelp();
        map.setView(mapMode);
        mapControls?.update();
        await updateMap(true);
        syncEditTools();
    } catch (e) {
        instance?.destroy();
        map = null;
        mapState = 'mapUnavailable';
        $('#map-message').textContent = t(mapState);
    }
}
async function updateMap(reset = false) {
    if (map) await map.setData(data(), floorId, selected, Boolean(edit), {
        reset, selection: edit ? [...editSelection] : selected ? [selected] : [], hardwareSelection: edit ? hardwareSelection : []
    });
    updateTransformFields(null, { groupsOnly: true });
}

async function select(id, instanceIndex = 0, extend = false, hardware = false, origin = 'other') {
    if (editSave?.saving) return;
    if (!extend && id && selected === id && !creationOpen && !editConflict?.open && (!edit || editSelection.size === 1 && (
        hardware ? hardwareSelection.length === 1 && hardwareSelection[0].instanceIndex === instanceIndex : !hardwareSelection.length || exhibit()?.models.length === 1
    ))) {
        map?.cancelTransform(); numberDrag?.cancel();
        if (matchMedia('(max-width:860px)').matches) { setView('detail'); panelMotion.settle(); }
        if (edit) inspectorNavigation.update(editSelection, hardwareSelection, { focus: true });
        return;
    }
    joinGeneration++;
    map?.cancelTransform();
    numberDrag?.cancel();
    creationOpen = false;
    if (editConflict) editConflict.open = false;
    collapseEmptyDraft();
    const previous = selected;
    const focused = document.activeElement?.closest('#exhibit-list [data-select]');
    const clicked = data().exhibits.find(x => x.id === id);
    if (edit && hardware && clicked?.models[instanceIndex]) {
        const selection = pickHardwareSelection(editSelection, hardwareSelection, data(), floorId, {
            exhibitId: id, instanceIndex, extend, viewport: origin === 'viewport'
        });
        hardwareSelection = selection.hardware;
        editSelection = selection.exhibits;
        selected = editSelection.has(id) ? id : [...editSelection][0] || null;
    } else if (edit && extend) {
        if (!clicked) return;
        hardwareSelection = [];
        if (editSelection.has(id)) editSelection.delete(id);
        else editSelection.add(id);
        selected = editSelection.has(selected) ? selected : [...editSelection][0] || null;
    } else {
        hardwareSelection = [];
        selected = clicked?.id || null;
        editSelection = new Set(selected ? [selected] : []);
    }
    if (edit) hardwareSelection = wholeHardwareSelection(editSelection, hardwareSelection, data());
    const e = data().exhibits.find(x => x.id === selected);
    if (!e) {
        selected = null;
        renderList(); renderInspector({ origin }); renderMapUI(); updateMap(); syncUrl();
        syncEditTools();
        return;
    }
    const changed = Boolean(e.floorId && floorId !== e.floorId);
    activeInstance = !extend ? instanceIndex : selected === previous ? activeInstance : 0;
    if (e.floorId) floorId = e.floorId;
    renderList();
    renderInspector({ origin, focusSelection: true, replaceSelection: !extend });
    renderMapUI();
    await updateMap(changed);
    syncEditTools();
    if (!edit) map?.focus(true);
    syncUrl();
    if (edit) persistEdit();
    if (changed) announce(t('floorChanged') + ': ' + titleFloor(floorId));
    if (!extend && matchMedia('(max-width:860px)').matches) setView('detail');
    if (focused && !focused.isConnected && document.activeElement === document.body) {
        [...document.querySelectorAll('#exhibit-list [data-select]')].find(button => button.dataset.select === focused.dataset.select)?.focus({ preventScroll: true });
    }
}

function changeFloor(id) {
    if (editSave?.saving) return;
    map?.cancelTransform();
    numberDrag?.cancel();
    creationOpen = false;
    if (editConflict) editConflict.open = false;
    collapseEmptyDraft();
    floorId = id;
    hardwareSelection = [];
    const e = exhibit();
    if (e?.floorId !== id) { selected = null; editSelection.clear(); }
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
                <div class="item-actions">
                    <details class="note-options"><summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('ellipsis')}</summary><div class="popover"><button type="button" data-correct="${esc(n.id)}">${icon('pencil-line')}<span>${esc(t('correct'))}</span></button></div></details>
                    <button type="button" class="icon-button danger" data-delete-note="${esc(n.id)}" aria-label="${esc(t('deleteNote'))}" title="${esc(t('deleteNote'))}">${icon('trash')}</button>
                </div>
            </div>
        </article>`;
}

function renderInspector({ origin = 'other', focusSelection = false, replaceSelection = false } = {}) {
    const visible = Boolean(exhibit() || edit && (creationOpen || editConflict?.open));
    document.body.classList.toggle('inspector-hidden', !visible);
    $('#inspector').inert = !visible || Boolean(editSave?.saving);
    $('#inspector').setAttribute('aria-hidden', String(!visible));
    $('#resizer').inert = !visible;
    $('#resizer').setAttribute('aria-hidden', String(!visible));
    if (!visible) {
        inspectorNavigation.reset();
        panelMotion.update(null, [], { origin });
        if (view === 'detail') setView('map');
        renderMobile();
        return;
    }
    const records = creationOpen || editConflict?.open ? [] : edit ? selectedExhibits() : [exhibit()];
    const context = inspectorContext(records, creationOpen ? 'create' : editConflict?.open ? 'conflict' : 'exhibit');
    const sameContext = context === panelMotion.context;
    const navigation = sameContext ? inspectorNavigation.capture() : null;
    const ids = creationOpen || editConflict?.open ? [] : edit ? [...editSelection] : records.map(record => record.id);
    panelMotion.prepare(context, ids, { replace: replaceSelection });
    renderInspectorContent();
    if (edit && !creationOpen && !editConflict?.open) inspectorNavigation.update(editSelection, hardwareSelection, { previous: navigation, focus: focusSelection });
    else inspectorNavigation.reset();
    if (panelMotion.update(context, ids, { origin, replace: replaceSelection })) {
        const title = $('#inspector h1')?.textContent;
        if (title) $('#inspector-update').textContent = `${t('detail')}: ${title}`;
    }
}

function renderInspectorContent() {
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
                    <button type="button" class="status-toggle" aria-label="${esc(t('changeStatus') + ': ' + t(e.status))}" aria-expanded="false" aria-controls="status-menu" aria-haspopup="menu" aria-busy="${statusSaving}" title="${esc(t(e.status))}" ${statusSaving ? 'disabled' : ''}>${statusHTML(e.status)}${icon('chevron-down', 'status-chevron')}</button>
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
        if (statusSaving) return;
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
        closeStatusPicker(true);
        changeStatus(status);
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
        ${searchable ? `<div class="searchbox link-search">
            ${icon('search', 'search-icon')}
            <input id="link-search" type="search" value="${esc(linkSearches[e.id] || '')}" placeholder="${esc(t('searchLinks'))}" aria-label="${esc(t('searchLinks'))}" aria-controls="link-results" autocomplete="off">
        </div>` : ''}
        <form class="composer link-composer ${draft.open ? 'composing' : ''}" id="link-form" novalidate>
            <input id="link-title" name="title" aria-label="${esc(t('title'))}" placeholder="${esc(t(draft.open ? 'title' : 'addLink'))}" maxlength="160" value="${esc(draft.title)}">
            <div class="link-fields" ${draft.open ? '' : 'hidden'}>
                <input id="link-url" name="url" type="text" inputmode="url" aria-label="${esc(t('url'))}" placeholder="${esc(t('url'))}" value="${esc(draft.url)}">
                <textarea id="link-description" name="description" aria-label="${esc(t('description'))}" placeholder="${esc(t('description'))}" maxlength="1000">${esc(draft.description)}</textarea>
                <div class="row between"><button type="button" class="quiet" data-action="cancelLink">${esc(t('cancel'))}</button><button type="submit" class="primary">${esc(t(draft.saving ? 'saving' : 'save'))}</button></div>
            </div>
            <p class="link-error" role="alert" ${draft.error ? '' : 'hidden'}>${draft.error ? esc(errorText({ key: draft.error })) : ''}</p>
            ${draftWarning('links')}
        </form>
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
                    <div class="item-actions">
                        <details class="note-options"><summary class="icon-button" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('ellipsis')}</summary><div class="popover"><button type="button" data-edit-link="${esc(link.id)}">${icon('pencil-line')}<span>${esc(t('edit'))}</span></button></div></details>
                        <button type="button" class="icon-button danger" data-delete-link="${esc(link.id)}" aria-label="${esc(t('remove') + ': ' + link.title)}" title="${esc(t('remove'))}">${icon('trash')}</button>
                    </div>
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
    if (draft.saving) form.querySelectorAll('input, textarea, button').forEach(input => { input.disabled = true; });
    form.addEventListener('focusin', () => {
        if (!draft.open) {
            draft.open = true;
            form.classList.add('composing');
            form.querySelector('#link-title').placeholder = t('title');
            form.querySelector('.link-fields').hidden = false;
        }
    });
    form.addEventListener('input', event => {
        if (['title', 'url', 'description'].includes(event.target.name)) draft[event.target.name] = event.target.value;
        delete draft.error;
        form.querySelector('.link-error').hidden = true;
        persistLinks();
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (draft.saving) return;
        const current = data().exhibits.find(item => item.id === e.id);
        draft.saving = true;
        form.querySelector('button[type=submit]').textContent = t('saving');
        form.querySelectorAll('input, textarea, button').forEach(input => { input.disabled = true; });
        try {
            if (!draft.title.trim()) throw Error('invalidInput');
            const url = documentUrl(draft.url);
            if (!url) throw Error('invalidUrl');
            draft.url = url;
            form.querySelector('#link-url').value = url;
            const result = await api.save({
                action: 'putLink', exhibitId: current.id, linkId: draft.id,
                title: draft.title.trim(), url, description: draft.description.trim(),
                baseRevision: current.revision, contentTag: current.contentTag, requestId: uid()
            });
            delete linkDrafts[current.id];
            persistLinks();
            acceptSnapshot(result.snapshot);
            announce(t('saved'));
        } catch (error) {
            draft.error = error.key || error.message || 'storage';
            const message = form.querySelector('.link-error');
            message.textContent = errorText(error);
            message.hidden = false;
        } finally {
            draft.saving = false;
            persistLinks();
            if (selected === e.id && tab === 'documentation' && !edit && linkDrafts[e.id] === draft) renderPanel();
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
        editor.setLink(url, String(form.get('text') || ''), link);
    }, 'noteLink:' + exhibit().id + ':' + drafts[selected].requestId);
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
                    <button class="primary post-button" type="submit">${esc(t(d.saving ? 'saving' : d.noteId ? 'save' : 'postShort'))}</button>
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
                    <div class="row signature-actions">${button('cancel', 'cancelSignature', 'quiet')}<button type="button" class="primary" data-action="confirmNote" ${d.saving || !d.signature.trim() ? 'disabled' : ''}>${esc(t(d.saving ? 'saving' : d.noteId ? 'save' : 'postShort'))}</button></div>
                </div>` : ''}
            <div id="note-error" class="error" role="alert" ${d.error ? '' : 'hidden'}>${d.error ? esc(t(d.error)) : ''}</div>
            ${draftWarning('notes')}
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
        if (!d.signature) d.signature = rememberedSignature();
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
    const signature = d.signature.trim();
    if (d.submissionSignature && d.submissionSignature !== signature) {
        d.images.forEach(image => { image.id = uid(); });
    }
    const submission = JSON.stringify([d.body, signature, d.status, d.images.map(image => image.id), d.existingImages]);
    if (d.submission && d.submission !== submission) d.requestId = uid();
    d.submission = submission;
    d.submissionSignature = signature;
    persistDrafts();
    renderComposer();
    const submit = $('#note-form button[type=submit]');
    if (submit) {
        submit.disabled = true;
        submit.textContent = t('saving');
    }
    try {
        const payload = {
            action: d.noteId ? 'correctNote' : 'note',
            exhibitId: id,
            baseRevision: d.baseRevision,
            contentTag: d.contentTag,
            requestId: d.requestId,
            signature,
            body: d.body,
            images: [...d.existingImages]
        };
        if (d.noteId) payload.noteId = d.noteId;
        else if (d.status) payload.status = d.status;
        const result = await api.postNote(payload, d.images);
        rememberSignature(signature);
        delete drafts[id];
        persistDrafts();
        acceptSnapshot(result.snapshot);
        announce(t('saved'));
    } catch (error) {
        d.error = error.key || 'storage';
        d.conflict = error.status === 409;
        persistDrafts();
        if (id === selected && tab === 'notes' && !edit && $('#composer-slot')) renderComposer();
    } finally {
        d.saving = false;
        if (drafts[id] && id === selected && tab === 'notes' && !edit && $('#composer-slot')) renderComposer();
    }
}

function acceptSnapshot(value) {
    snapshot = value;
    for (const record of value.exhibits) {
        const draft = drafts[record.id];
        if (draft && !draft.body.trim() && !draft.images.length && !draft.existingImages.length && !draft.noteId) draft.baseRevision = record.revision;
    }
    if (edit) {
        edit.value.floors = structuredClone(value.floors);
        for (const record of edit.base.exhibits) {
            const live = value.exhibits.find(item => item.id === record.id);
            if (live) { record.notes = live.notes; record.links = live.links; }
        }
        for (const record of edit.value.exhibits) {
            const live = value.exhibits.find(item => item.id === record.id);
            if (live) {
                const members = [live, ...(record.joinedFrom || []).map(id => value.exhibits.find(item => item.id === id))].filter(Boolean);
                for (const key of ['notes', 'links']) record[key] = members.flatMap(item => item[key]);
                const base = edit.base.exhibits.find(item => item.id === record.id);
                if (record.status === base?.status) {
                    record.status = live.status;
                }
            }
        }
    }
    render();
}

function renderMobile() {
    const detail = Boolean(exhibit() || edit && (creationOpen || editConflict?.open));
    $('#mobile-nav').innerHTML = [['list', 'list'], ['map', 'map'], ['detail', 'panel-right']].map(([key, name]) => `<button type="button" data-action="view:${key}" class="${view === key ? 'active' : ''}" aria-current="${view === key ? 'page' : 'false'}" ${key === 'detail' && !detail ? 'disabled' : ''}>${icon(name)}<span>${esc(t(key === 'list' ? 'exhibits' : key))}</span></button>`).join('');
}

function renderEditBar() {
    const el = $('#editbar');
    el.hidden = !edit;
    if (!edit) return;
    const signing = Boolean(editSave?.signing);
    const dirty = Boolean(edit.changes().length || creation);
    el.classList.toggle('signing', signing);
    const label = creation ? `<button type="button" class="quiet edit-session-label" data-action="resumeCreation" title="${esc(t('resumeCreation'))}">${esc(t('newExhibit'))}</button>` : `<span class="edit-session-label" ${editHelp('editDraftHint')}>${esc(t('editingShort'))}${dirty ? '<i aria-hidden="true"></i>' : ''}</span>`;
    el.innerHTML = `<div class="edit-session-heading">${label}
        <div class="edit-history">${iconButton('undo', 'undo', 'undo-2', !edit.undoStack.length || editSave?.saving ? 'disabled' : '', 'undoEditHint')}${iconButton('redo', 'redo', 'redo-2', !edit.redoStack.length || editSave?.saving ? 'disabled' : '', 'redoEditHint')}</div></div>
        ${signing ? `<label class="sr-only" for="edit-signature">${esc(t('signature'))}</label><input id="edit-signature" ${editHelp('editSignatureHint')} autocomplete="off" maxlength="120" placeholder="${esc(t('yourName'))}" value="${esc(editSave.signature)}" aria-describedby="edit-save-error">` : ''}
        <div class="edit-session-actions" role="group" aria-label="${esc(t('editStructure'))}">${button('cancel', signing ? 'cancelEditSignature' : 'cancelEdit', 'quiet', editHelp(signing ? 'cancelSignatureHint' : 'cancelEditHint'))}<button type="button" class="primary" data-action="${signing ? 'confirmEditSave' : 'saveExit'}" ${editHelp(creation ? 'finishCreation' : editConflict ? 'resolveChanges' : signing ? 'saveEditHint' : 'signEditHint')} ${editSave?.saving || creation || editConflict || !dirty || (signing && !editSave.signature.trim()) ? 'disabled' : ''}>${esc(t(editSave?.saving ? 'saving' : 'save'))}</button></div>
        <div class="error" id="edit-save-error" role="alert" ${editSave?.error ? '' : 'hidden'}><span>${esc(editSave?.error ? t(editSave.error === 'conflict' ? 'editConflictHint' : editSave.error) : '')}</span>${editSave?.error === 'conflict' ? button('resolveChanges', 'structureConflict', 'quiet') : ''}</div>`;
    el.insertAdjacentHTML('beforeend', draftWarning('edit'));
    $('#edit-signature')?.addEventListener('input', event => {
        editSave.signature = event.target.value;
        editSave.requestId = uid();
        persistEdit();
        $('[data-action=confirmEditSave]').disabled = editSave.saving || Boolean(creation || editConflict) || !edit.changes().length || !editSave.signature.trim();
    });
    $('#edit-signature')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); confirmEditSave(); }
    });
}

function editorActions(record) {
    if (!record) return '';
    return `<div class="item-actions">${iconButton('duplicate', 'duplicateExhibit', 'copy-plus', '', 'duplicateExhibitHint')}<button type="button" class="icon-button danger" data-trash-exhibit="${esc(record.id)}" aria-label="${esc(t('deleteExhibit'))}" ${editHelp('removeExhibitHint')}>${icon('trash')}</button></div>`;
}

function hasJoinDraft(id) {
    return hasNoteDraft(drafts[id]) || hasLinkDraft(linkDrafts[id]) ||
        Object.entries(dialogDrafts).some(([key, values]) => key.split(':')[1] === id &&
            Object.values(values).some(value => typeof value === 'string' && value.trim()));
}

function pendingJoinDrafts() {
    return edit?.value.exhibits.some(record => record.joinedFrom?.length &&
        [record.id, ...record.joinedFrom].some(hasJoinDraft));
}

function joinProblem(records) {
    if (creation) return 'finishCreation';
    if (records.some(record => [record.id, ...(record.joinedFrom || [])].some(hasJoinDraft))) return 'joinHasDrafts';
    const floors = new Set(records.filter(record => record.models.length && record.floorId).map(record => record.floorId));
    if (floors.size > 1) return 'joinDifferentFloors';
    if (records.reduce((count, record) => count + record.models.length, 0) > 100) return 'joinTooManyModels';
    return '';
}

function openJoinSelection() {
    if (!edit || editSave?.saving || hardwareSelection.length || editSelection.size < 2) return;
    const records = selectedExhibits(), problem = joinProblem(records);
    if (problem) { announce(t(problem)); return; }
    const session = edit, generation = joinGeneration;
    showDialog('joinTogether', `<div class="field"><label for="join-target">${esc(t('joinInto'))}</label><select id="join-target" name="target" ${editHelp('joinTargetHint')}>${options(records.map(record => [record.id, record.name]), selected)}</select></div>${footer('joinTogether')}`, async values => {
        if (edit !== session || generation !== joinGeneration) { closeDialog(); return; }
        const target = values.get('target');
        if (!editSelection.has(target)) return;
        closeDialog();
        await joinSelection(target);
    });
}

async function joinSelection(target = selected) {
    if (!edit || editSave?.saving || editSelection.size < 2) return;
    const session = edit, value = edit.value, records = selectedExhibits(), primary = selected, generation = ++joinGeneration;
    try {
        const problem = joinProblem(records);
        if (problem) throw Error(problem);
        const { joinExhibits } = await import('./join.js');
        if (edit !== session || edit.value !== value || generation !== joinGeneration || editSave?.saving || primary !== selected ||
            records.length !== editSelection.size || records.some(record => !editSelection.has(record.id))) return;
        const joined = joinExhibits(records, target);
        joined.joinedFrom = joined.joinedFrom.filter(id => session.base.exhibits.some(record => record.id === id));
        if (!joined.joinedFrom.length) delete joined.joinedFrom;
        map?.cancelTransform();
        selected = target;
        hardwareSelection = [];
        editSelection = new Set([target]);
        activeInstance = 0;
        gizmo = 'combined';
        if (joined.floorId) floorId = joined.floorId;
        applyEdit(state => {
            state.exhibits = state.exhibits.flatMap(record => record.id === target ? [joined] : records.some(source => source.id === record.id) ? [] : [record]);
        }, { rebuild: true });
        announce(t('exhibitsJoined'), 'undo');
    } catch (error) {
        if (edit !== session || generation !== joinGeneration) return;
        const element = $('#join-error');
        if (element) { element.textContent = errorText(error); element.hidden = false; }
        else announce(errorText(error));
    }
}

function editHistory(direction, origin = 'other') {
    if (!edit || editSave?.saving) return;
    map?.cancelTransform();
    numberDrag?.cancel();
    const joined = exhibit()?.joinedFrom || [];
    const before = edit.value;
    edit[direction]();
    if (edit.value === before) return;
    if (direction === 'undo') {
        const restored = joined.filter(id => edit.value.exhibits.some(record => record.id === id));
        if (restored.length) editSelection = new Set([selected, ...restored]);
    }
    editConflict = null;
    if (editSave) {
        editSave.requestId = uid();
        editSave.error = null;
        if (!edit.changes().length) editSave.signing = false;
    }
    changed(origin);
}

function renderEditInspector() {
    numberDrag?.cancel();
    if (editConflict?.open) { renderEditConflict(); return; }
    if (!creationOpen && (editSelection.size > 1 || hardwareSelection.length > 1)) { renderSelectionInspector(Boolean(hardwareSelection.length)); return; }
    const record = exhibit();
    const title = creationOpen ? t('newExhibit') : displayName(record);
    $('#inspector').innerHTML = `<div class="inspector-header edit-inspector-header"><div class="edit-exhibit-title"><h1 title="${esc(creationOpen ? '' : record?.name || '')}">${esc(title)}</h1>${record && !creationOpen ? iconButton('renameExhibit', 'renameExhibit', 'pencil-line', '', 'renameExhibitHint') : ''}</div>${creationOpen ? '' : editorActions(record)}</div><div class="panel-content" id="structure-panel"><div id="structure-slot"></div></div>`;
    if (creationOpen) { renderCreation(); return; }
    if (!record) return;
    const hardware = data().assets.filter(asset => asset.kind === 'hardware');
    const wholePlacement = record.models.length > 1 ? exhibitParameters(record, 'group', { active: !hardwareSelection.length, placement: map?.exhibitPlacement(record.id) || null }) : '';
    const content = `
        ${wholePlacement}
        <div class="field"><label for="ex-floor">${esc(t('floor'))}</label><select id="ex-floor" name="floorId" ${editHelp('floorAssignmentHint')}>${options([['', t('noFloor')], ...data().floors.map(item => [item.id, item.names[lang()]])], record.floorId || '')}</select></div>
        <div class="instance-heading row between"><h3>${esc(t('modelInstances'))}</h3><details class="hardware-picker"><summary class="icon-button" aria-label="${esc(t('addModel'))}" ${editHelp('addHardwareHint')}>${icon('plus')}</summary><div class="popover">${hardware.map(asset => `<button type="button" data-add-hardware="${esc(asset.id)}" ${editHelp('addHardwareHint')}>${esc(asset.name)}</button>`).join('') || `<p class="small muted">${esc(t('noHardware'))}</p>`}</div></details></div>
        <div id="instance-list">${record.models.map((_, index) => hardwareParameters(record, index, data().assets, index, {
            selected: hardwareSelected(record.id, index, editSelection, hardwareSelection),
            expanded: record.models.length === 1 || hardwareSelection.length === 1 && hardwareSelection.some(entry => entry.exhibitId === record.id && entry.instanceIndex === index), editable: true
        })).join('')}</div>
        ${viewPresets(record)}`;
    $('#structure-slot').innerHTML = `<form id="structure-form" novalidate>${content}<div class="error" id="structure-error" role="alert" hidden></div></form>`;
    const form = $('#structure-form');
    bindSelectionFields();
    if (record.models.length) form.querySelector('#ex-floor option[value=""]').disabled = true;
    syncEditTools();
}

function render({ origin = 'other' } = {}) {
    document.title = t('exhibits') + ' · ' + t('hub');
    document.body.classList.toggle('editing', Boolean(edit));
    $('#sidebar').inert = Boolean(editSave?.saving);
    renderHeader();
    if (!snapshot) return;
    if (!data().floors.some(f => f.id === floorId)) floorId = data().floors[0]?.id;
    if (!data().exhibits.some(e => e.id === selected)) selected = null;
    editSelection = new Set(edit ? [...editSelection].filter(id => data().exhibits.some(record => record.id === id)) : []);
    if (edit && selected && !editSelection.size) editSelection.add(selected);
    if (edit && editSelection.size && !editSelection.has(selected)) selected = [...editSelection][0];
    hardwareSelection = edit ? wholeHardwareSelection(editSelection, normalizeHardwareSelection(hardwareSelection, data(), floorId), data()) : [];
    activeInstance = Math.max(0, Math.min(activeInstance, (exhibit()?.models.length || 1) - 1));
    renderSidebar();
    renderInspector({ origin });
    renderMapUI();
    renderEditBar();
    renderMobile();
    updateMap();
    $('#resizer').setAttribute('aria-label', t('resize'));
    document.documentElement.lang = lang();
}

function closeDialog(form = null) {
    if (form && form !== $('#dialog-form')) return;
    $('#dialog').fieldController?.abort();
    $('#dialog').fieldController = null;
    $('#dialog').close();
    $('#dialog').innerHTML = '';
}

function showDialog(title, html, onSubmit = null, draftKey = title + ':' + (selected || '')) {
    closeDialog();
    const dialog = $('#dialog');
    dialog.innerHTML = `<div class="dialog-header"><h2>${esc(t(title))}</h2><button type="button" data-action="closeDialog" class="quiet" aria-label="${esc(t('close'))}" title="${esc(t('close'))}">${icon('x')}</button></div><form class="dialog-body" id="dialog-form" novalidate>${html}<div id="dialog-error" class="error" role="alert" hidden></div>${draftWarning('dialogs')}</form>`;
    const fields = [...dialog.querySelectorAll('input[name]:not([type=file]), textarea[name]')];
    fields.forEach(field => {
        if (Object.hasOwn(dialogDrafts[draftKey] || {}, field.name)) field.value = dialogDrafts[draftKey][field.name];
    });
    dialog.fieldController = new AbortController();
    dialog.addEventListener('input', () => {
        const values = Object.fromEntries(fields.map(field => [field.name, field.value]));
        if (Object.values(values).some(value => value.trim())) dialogDrafts[draftKey] = values;
        else delete dialogDrafts[draftKey];
        saveDraftCategory('dialogs', dialogDrafts);
    }, { signal: dialog.fieldController.signal });
    if (onSubmit) $('#dialog-form').addEventListener('submit', async e => {
        e.preventDefault();
        const submit = e.submitter;
        if (submit?.disabled) return;
        const fields = [...e.target.querySelectorAll('input, textarea, select')];
        try {
            const values = new FormData(e.target);
            if (submit) submit.disabled = true;
            fields.forEach(field => { field.disabled = true; });
            await onSubmit(values, e.target);
            delete dialogDrafts[draftKey];
            saveDraftCategory('dialogs', dialogDrafts);
        } catch (error) {
            const err = e.target.querySelector('#dialog-error');
            if (err?.isConnected) {
                err.textContent = errorText(error);
                err.hidden = false;
            }
        } finally {
            fields.forEach(field => { field.disabled = false; });
            if (submit?.isConnected) submit.disabled = false;
        }
    });
    dialog.showModal();
    return dialog;
}
const signatureField = () => `<div class="field"><label for="signature">${esc(t('signature'))}</label><input id="signature" name="signature" autocomplete="off" maxlength="120" value="${esc(rememberedSignature())}" required><p class="small muted">${esc(t('signatureHint'))}</p></div>`;
const footer = (key = 'save') => `<div class="dialog-footer">${button('cancel','closeDialog')}<button type="submit" class="primary">${esc(t(key))}</button></div>`;

function requireSignature(form) {
    const value = String(form.get('signature') || '').trim();
    if (!value) {
        $('#signature')?.focus();
        throw Error('signatureRequired');
    }
    return value;
}

async function changeStatus(chosenStatus) {
    const record = exhibit();
    if (!record || edit || statusSaving || chosenStatus === record.status) return;
    statusSaving = true;
    const toggle = $('.status-toggle');
    const restoreFocus = document.activeElement === toggle;
    if (toggle) {
        toggle.disabled = true;
        toggle.setAttribute('aria-busy', 'true');
    }
    try {
        const result = await api.save({
            action: 'status',
            exhibitId: record.id,
            baseRevision: record.revision,
            requestId: uid(),
            status: chosenStatus
        });
        acceptSnapshot(result.snapshot);
        announce(t('saved'));
    } catch (error) {
        if (error.status === 409) {
            try {
                acceptSnapshot(await api.load());
                announce(t('statusConflict'));
            } catch (refreshError) { announce(errorText(refreshError)); }
        } else announce(errorText(error));
    } finally {
        statusSaving = false;
        const currentToggle = $('.status-toggle');
        if (currentToggle) {
            currentToggle.disabled = false;
            currentToggle.setAttribute('aria-busy', 'false');
            if (restoreFocus && selected === record.id && document.activeElement === document.body) currentToggle.focus({ preventScroll: true });
        }
    }
}

function editLink(id = null) {
    const record = exhibit();
    const link = record.links.find(item => item.id === id);
    if (id && !link) return;
    const pending = linkDrafts[record.id];
    if (hasLinkDraft(pending)) {
        if (pending.id !== id) { announce(t('draft')); return; }
        pending.open = true;
        renderPanel();
        $('#link-title')?.focus();
        return;
    }
    linkDrafts[record.id] = { open: true, id, title: link?.title || '', url: link?.url || '', description: link?.description || '' };
    persistLinks();
    renderPanel();
    $('#link-title')?.focus();
}

function deleteLink(id) {
    const record = exhibit();
    const link = record.links.find(item => item.id === id);
    if (!link) return;
    showDialog('remove', `<p>${esc(link.title)}</p>${footer('remove')}`, async (form, element) => {
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
    hardwareSelection = [];
    editSelection = new Set(selected ? [selected] : []);
    creation = null;
    creationOpen = false;
    editSave = null;
    editConflict = null;
    gizmo = 'combined';
    persistEdit();
    render();
}

function syncEditTools() {
    const available = edit && !editSave?.saving && !creationOpen && !editConflict?.open && selectionTransforms().length;
    map?.setTool(available ? gizmo : '', snap, transformSpace, axisConstraint);
}

function changed(origin = 'other') {
    if (!edit) return;
    persistEdit();
    render({ origin });
    syncEditTools();
    syncUrl();
}

function applyEdit(change, { rebuild = false, reset = false, origin = 'other' } = {}) {
    if (!edit || editSave?.saving) return false;
    const didChange = edit.change(state => {
        change(state);
        state.exhibits.forEach(record => { record.placed = Boolean(record.floorId && record.models.length); });
    });
    if (!didChange) return false;
    hardwareSelection = normalizeHardwareSelection(hardwareSelection, data(), floorId);
    hardwareSelection = wholeHardwareSelection(editSelection, hardwareSelection, data());
    if (!edit.value.exhibits.some(record => record.id === selected)) selected = null;
    editConflict = null;
    if (editSave) editSave.error = null;
    if (editSave) editSave.requestId = uid();
    persistEdit();
    renderList();
    renderEditBar();
    if (rebuild) renderInspector({ origin });
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
    const invalid = inputs.find(input => !input.disabled && (!input.checkValidity() || input.type === 'number' && !input.value.trim()));
    if (!invalid) return true;
    structureError(invalid.type === 'number' ? 'invalidTransform' : 'invalidInput', invalid);
    return false;
}

function applyEditorField(input) {
    if (!edit || editSave?.saving) return;
    const record = data().exhibits.find(record => record.id === (input.dataset.exhibit || selected));
    if (!record) return;
    if (!input.checkValidity() || input.type === 'number' && !input.value.trim()) {
        structureError('invalidTransform', input);
        return;
    }
    if (input.hasAttribute('data-selection-delta')) {
        const value = transformNumber(Number(input.value));
        const neutral = input.dataset.vector === 'scale' ? 1 : 0;
        if (value === neutral) { input.value = neutral; return; }
        let preview;
        try {
            if (!map) throw Error('mapUnavailable');
            preview = map.beginSelectionField();
            const changes = map.previewSelectionField(preview, input.dataset.vector, input.dataset.axis === 'all' ? 'all' : Number(input.dataset.axis), value);
            commitTransforms(changes);
            if ($('#structure-error')) $('#structure-error').hidden = true;
        } catch (error) {
            if (preview) map.restoreSelectionField(preview);
            structureError(error.message, input);
        }
        input.value = input.dataset.vector === 'scale' ? 1 : 0;
        return;
    }
    if (input.hasAttribute('data-group-vector')) {
        let preview;
        try {
            if (!map) throw Error('mapUnavailable');
            const value = transformNumber(Number(input.value));
            input.value = value;
            preview = map.beginExhibitPlacement(record.id);
            const changes = map.previewExhibitPlacement(preview, input.dataset.vector, Number(input.dataset.axis), value);
            commitTransforms(changes);
            input.value = map.exhibitPlacement(record.id)?.[input.dataset.vector][Number(input.dataset.axis)] ?? value;
            if ($('#structure-error')) $('#structure-error').hidden = true;
        } catch (error) {
            if (preview) map.restoreSelectionField(preview);
            structureError(error.message, input);
        }
        return;
    }
    if (input.dataset.vector) {
        map?.cancelTransform();
        const value = transformNumber(Number(input.value));
        input.value = value;
        const changes = fieldTargets(input).map(entry => {
            const transform = structuredClone(entry.transform);
            transform[input.dataset.vector][Number(input.dataset.axis)] = value;
            return { ...entry, transform };
        });
        if (changes.some(entry => !validTransform(entry.transform))) { structureError('invalidTransform', input); return; }
        commitTransforms(changes);
        if ($('#structure-error')) $('#structure-error').hidden = true;
        return;
    }
    if ($('#structure-error')) $('#structure-error').hidden = true;
    const reset = input.id === 'ex-floor' && Boolean(input.value) && input.value !== floorId;
    const previousFloor = floorId;
    try {
        if (reset) floorId = input.value;
        applyEdit(state => {
            const target = state.exhibits.find(item => item.id === record.id);
            if (input.id === 'ex-floor') {
                if (target.models.length && !input.value) throw Error('invalidFloor');
                target.floorId = input.value || null;
            } else if (input.dataset.instanceModel !== undefined) target.models[Number(input.dataset.instanceModel)].model = input.value;
        }, { reset });
    } catch (error) { floorId = previousFloor; structureError(error.key || error.message, input); }
}

function updateTransformFields(preview = null, { groupsOnly = false } = {}) {
    $('#structure-form')?.querySelectorAll('[data-vector]').forEach(input => {
        if (groupsOnly && !input.hasAttribute('data-group-vector')) return;
        if (input.hasAttribute('data-selection-delta')) {
            if (!preview) input.value = input.dataset.vector === 'scale' ? 1 : 0;
            return;
        }
        const placement = inspectorFieldTransform(input, preview);
        if (input.hasAttribute('data-group-vector')) {
            input.disabled = !placement;
            if (placement) input.closest('[data-exhibit-placement]')?.querySelector('[data-placement-loading]')?.remove();
        }
        if (input === document.activeElement) return;
        const value = placement?.[input.dataset.vector][Number(input.dataset.axis)];
        input.value = value == null ? '' : transformNumber(value);
    });
    updateNumberFills($('#inspector'));
}

numberDrag = installNumberDrag($('#inspector'), {
    start(drag) {
        if (!edit || editSave?.saving) return false;
        map?.cancelTransform();
        if (drag.input.hasAttribute('data-selection-delta')) {
            try {
                if (!map) throw Error('mapUnavailable');
                drag.selectionPreview = map.beginSelectionField();
                return true;
            } catch (error) { structureError(error.message, drag.input); return false; }
        }
        if (drag.input.hasAttribute('data-group-vector')) {
            try {
                if (!map) throw Error('mapUnavailable');
                drag.exhibitPreview = map.beginExhibitPlacement(drag.input.dataset.exhibit || selected);
                return true;
            } catch (error) { structureError(error.message, drag.input); return false; }
        }
        drag.entries = fieldTargets(drag.input).map(entry => ({ ...entry, transform: structuredClone(entry.transform) }));
        return drag.entries.length > 0;
    },
    preview(drag, event) {
        const key = drag.input.dataset.vector, axis = drag.input.dataset.axis === 'all' ? 'all' : Number(drag.input.dataset.axis);
        const step = key === 'position' ? 1 : key === 'rotation' ? 15 : .1;
        const limit = key === 'scale' ? 1000 : 100000;
        if (drag.exhibitPreview) {
            let value = drag.exhibitPreview.placement[key][axis] + drag.delta;
            if (snap || event.ctrlKey) value = Math.round(value / step) * step;
            value = Math.max(-limit, Math.min(limit, value));
            try {
                drag.changes = map.previewExhibitPlacement(drag.exhibitPreview, key, axis, value);
                drag.error = null;
                if ($('#structure-error')) $('#structure-error').hidden = true;
            } catch (error) {
                drag.error = error.message; drag.changes = null;
                map.restoreSelectionField(drag.exhibitPreview);
                const element = $('#structure-error');
                if (element) { element.textContent = t(error.message); element.hidden = false; }
            }
            return;
        }
        if (drag.selectionPreview) {
            let value = (key === 'scale' ? 1 : 0) + drag.delta;
            if (snap || event.ctrlKey) value = Math.round(value / step) * step;
            value = Math.max(-limit, Math.min(limit, value));
            drag.input.value = transformNumber(value);
            if (transformNumber(value) === (key === 'scale' ? 1 : 0)) {
                map.restoreSelectionField(drag.selectionPreview);
                drag.changes = null; drag.error = null;
                return;
            }
            try {
                drag.changes = map.previewSelectionField(drag.selectionPreview, key, axis, value);
                drag.error = null;
                if ($('#structure-error')) $('#structure-error').hidden = true;
            } catch (error) {
                drag.error = error.message; drag.changes = null;
                map.restoreSelectionField(drag.selectionPreview);
                const element = $('#structure-error');
                if (element) { element.textContent = t(error.message); element.hidden = false; }
            }
            return;
        }
        drag.changes = drag.entries.map(entry => {
            const transform = structuredClone(entry.transform);
            let value = entry.transform[key][axis] + drag.delta;
            if (snap || event.ctrlKey) value = Math.round(value / step) * step;
            transform[key][axis] = Math.max(-limit, Math.min(limit, value));
            return { ...entry, transform };
        });
        map?.previewTransforms(drag.changes); updateTransformFields(drag.changes);
    },
    commit(drag) {
        if (drag.error) { map.restoreSelectionField(drag.selectionPreview || drag.exhibitPreview); structureError(drag.error, drag.input); }
        else if (drag.changes) commitTransforms(drag.changes);
        updateTransformFields();
    },
    cancel(drag) {
        if (drag.selectionPreview || drag.exhibitPreview) map?.restoreSelectionField(drag.selectionPreview || drag.exhibitPreview);
        else map?.previewTransforms(drag.entries);
        updateTransformFields();
    }
});

function openExhibitEditor(isNew = false, origin = 'other') {
    if (!edit || editSave?.saving) return;
    joinGeneration++;
    map?.cancelTransform();
    if (isNew) {
        if (!creation) creation = {
            previousSelected: selected, previousFloor: floorId,
            previousSelection: [...editSelection],
            record: { name: '', floorId: floorId || '' }
        };
        creationOpen = true;
        selected = null;
        editSelection.clear();
    } else {
        creationOpen = false;
    }
    if (editConflict) editConflict.open = false;
    persistEdit();
    renderEditBar();
    renderInspector({ origin });
    renderList();
    renderMapUI();
    updateMap();
    syncEditTools();
    syncUrl();
    setView('detail');
    if (creationOpen) $('#creation-form input')?.focus({ preventScroll: true });
}

function renameExhibit(id = selected, origin = 'other') {
    const record = data()?.exhibits.find(item => item.id === id);
    if (!edit || !record || editSave?.saving) return;
    showDialog('renameExhibit', `<div class="field"><label for="exhibit-name">${esc(t('name'))}</label><input id="exhibit-name" name="name" value="${esc(record.name)}" maxlength="160" required autocomplete="off"></div>${footer('apply')}`, form => {
        const name = exhibitName(String(form.get('name') || ''));
        if (data().exhibits.some(item => item.id !== record.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
            throw Error('duplicateName');
        }
        closeDialog();
        applyEdit(state => { state.exhibits.find(item => item.id === record.id).name = name; }, { rebuild: true, origin });
    }, 'renameExhibit:' + record.id);
    $('#exhibit-name').focus();
    $('#exhibit-name').select();
}

function renderCreation() {
    const record = creation.record;
    const fields = `
        <div class="field"><label for="ex-name">${esc(t('name'))}</label><input id="ex-name" ${editHelp('exhibitNameHint')} data-create-field="name" maxlength="160" required value="${esc(record.name)}" autocomplete="off"></div>
        <div class="field"><label for="ex-floor">${esc(t('floor'))}</label><select id="ex-floor" data-create-field="floorId" ${editHelp('floorAssignmentHint')}>${options([['', t('noFloor')], ...data().floors.map(item => [item.id, item.names[lang()]])], record.floorId)}</select></div>`;
    $('#structure-slot').innerHTML = `<form id="creation-form" novalidate>${fields}<div class="error" id="structure-error" role="alert" hidden></div><div class="creation-actions">${button('cancel', 'cancelCreation', 'quiet', editHelp('cancelCreationHint'))}<button type="submit" class="primary" ${editHelp('createExhibitHint')}>${esc(t('create'))}</button></div></form>`;
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
        const record = newExhibit(raw.name, raw.floorId);
        if (data().exhibits.some(item => [item.id, item.name, ...(item.joinedFrom || [])].some(value => value.toLocaleLowerCase() === record.id.toLocaleLowerCase()))) throw Error('duplicateName');
        edit.change(state => state.exhibits.push(record));
        creation = null;
        creationOpen = false;
        selected = record.id;
        editSelection = new Set([record.id]);
        hardwareSelection = [];
        if (record.floorId) floorId = record.floorId;
        activeInstance = 0;
        changed();
        panelMotion.afterEnter(() => {
            const picker = $('.hardware-picker');
            if (selected === record.id && record.floorId && !$('#dialog').open &&
                !$('#inspector').contains(document.activeElement) && picker?.querySelector('[data-add-hardware]')) picker.open = true;
        });
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
    editSelection = new Set(previous.previousSelection || (selected ? [selected] : []));
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
    hardwareSelection = [{ exhibitId: record.id, instanceIndex: activeInstance }];
    gizmo = 'combined';
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
        hardwareSelection = hardwareSelection.filter(entry => entry.exhibitId !== record.id || entry.instanceIndex !== index).map(entry => entry.exhibitId === record.id && entry.instanceIndex > index ? { ...entry, instanceIndex: entry.instanceIndex - 1 } : entry);
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
    hardwareSelection = [{ exhibitId: record.id, instanceIndex: activeInstance }];
    applyEdit(state => state.exhibits.find(item => item.id === record.id).models.push(copy), { rebuild: true });
}

function cancelEdit() {
    if (!edit) return;
    joinGeneration++;
    map?.cancelTransform();
    numberDrag?.cancel();
    cancelledEdit = { edit, creation, creationOpen, selected, selection: [...editSelection], hardwareSelection: structuredClone(hardwareSelection), transformSpace, axisConstraint, snap, floorId, activeInstance, gizmo, signature: editSave?.signature || '', requestId: editSave?.requestId || '' };
    const dirty = edit.changes().length || creation;
    edit = null;
    creation = null;
    creationOpen = false;
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
    const signature = cancelledEdit.signature;
    const requestId = cancelledEdit.requestId;
    editSelection = new Set(cancelledEdit.selection || (cancelledEdit.selected ? [cancelledEdit.selected] : []));
    hardwareSelection = cancelledEdit.hardwareSelection || [];
    transformSpace = cancelledEdit.transformSpace || 'world';
    axisConstraint = cancelledEdit.axisConstraint || '';
    snap = Boolean(cancelledEdit.snap);
    ({ edit, creation, creationOpen, selected, floorId, activeInstance, gizmo } = cancelledEdit);
    cancelledEdit = null;
    editSave = signature ? { signature, requestId, signing: false, saving: false } : null;
    editConflict = null;
    changed();
    announce(t('editsRestored'));
}

async function saveExit() {
    if (!edit || editSave?.saving) return;
    if (pendingJoinDrafts()) { announce(t('joinHasDrafts')); return; }
    if (editConflict) { actions.structureConflict(); return; }
    map?.cancelTransform();
    numberDrag?.cancel();
    if (creation) {
        creationOpen = true;
        renderInspector(); renderMapUI(); syncEditTools(); setView('detail');
        $('#creation-form input')?.focus();
        return;
    }
    if (!validEditorFields()) return;
    if (!edit.changes().length) { cancelEdit(); return; }
    editSave = { signing: true, signature: editSave?.signature || rememberedSignature(), saving: false, error: null, requestId: editSave?.requestId || uid() };
    persistEdit();
    renderEditBar();
    $('#edit-signature').focus();
}

function moveRenamedDrafts(session, saved) {
    const renames = new Map(session.changes().filter(change => change.op === 'put' && change.id !== change.record.name)
        .map(change => [change.id, change.record.name]));
    if (!renames.size) return;
    const noteIds = new Map();
    for (const [source, target] of renames) {
        const before = session.base.exhibits.find(record => record.id === source);
        const after = saved.exhibits.find(record => record.id === target);
        if (!after) continue;
        for (const note of before?.notes || []) {
            const renamed = after.notes.find(item => item.file === note.file);
            if (note.file && renamed) noteIds.set(note.id, renamed.id);
        }
        const draft = drafts[source];
        if (draft) {
            if (draft.noteId) draft.noteId = noteIds.get(draft.noteId) || draft.noteId;
            if (draft.baseRevision === before?.revision) draft.baseRevision = after.revision;
        }
        const link = linkDrafts[source];
        if (link?.id) {
            const original = before?.links.find(item => item.id === link.id);
            link.id = after.links.find(item => item.title === original?.title)?.id || link.id;
        }
    }
    for (const store of [drafts, linkDrafts, linkSearches]) {
        const entries = Object.entries(store);
        for (const key of Object.keys(store)) delete store[key];
        for (const [key, value] of entries) store[renames.get(key) || key] = value;
    }
    dialogDrafts = Object.assign(Object.create(null), Object.fromEntries(Object.entries(dialogDrafts).map(([key, value]) => {
        const parts = key.split(':');
        parts[1] = renames.get(parts[1]) || parts[1];
        if (parts[0] === 'deleteNote') parts[2] = noteIds.get(parts[2]) || parts[2];
        return [parts.join(':'), value];
    })));
    selected = renames.get(selected) || selected;
    persistDrafts();
    persistLinks();
    saveDraftCategory('dialogs', dialogDrafts);
}

function finishEditSave(session, saved) {
    moveRenamedDrafts(session, saved);
    edit = null;
    creation = null;
    creationOpen = false;
    editConflict = null;
    editSave = null;
    cancelledEdit = null;
    gizmo = '';
    persistEdit();
    acceptSnapshot(saved);
    syncUrl();
    syncEditTools();
    announce(t('saved'));
}

async function confirmEditSave() {
    if (!edit || !editSave?.signing || editSave.saving || !editSave.signature.trim()) return;
    if (editConflict) { actions.structureConflict(); return; }
    if (creation || !validEditorFields()) return;
    if (pendingJoinDrafts()) { announce(t('joinHasDrafts')); return; }
    map?.cancelTransform();
    const session = edit, save = editSave, changes = session.changes(), signature = save.signature.trim();
    save.controller = new AbortController();
    save.saving = true;
    save.error = null;
    closeMenus();
    $('#sidebar').inert = true;
    $('#inspector').inert = true;
    renderEditBar();
    syncEditTools();
    try {
        const result = await api.save({ action: 'structure', baseRevision: session.base.structureRevision, requestId: save.requestId, signature, changes }, { signal: save.controller.signal });
        if (edit !== session) return;
        rememberSignature(signature);
        finishEditSave(session, result.snapshot);
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
    editSave = { signature: save.signature, requestId: save.requestId, signing: false, saving: false };
    persistEdit();
    $('#sidebar').inert = false;
    $('#inspector').inert = false;
    renderEditBar();
    syncEditTools();
    if (save.saving) reconcileCancelledSave(edit, save.requestId);
}

async function editSaveApplied(session, live, requestId) {
    if (!editWasSaved(session, live)) return false;
    return !session.changes().some(change => change.joins?.length) || Boolean(requestId && await api.receipt(requestId));
}

async function reconcileCancelledSave(session, requestId) {
    try {
        const live = await api.load();
        if (edit !== session) return;
        if (await editSaveApplied(session, live, requestId)) finishEditSave(session, live);
    } catch { announce(t('offline')); }
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
    if (await editSaveApplied(session, live, expectedSave?.requestId || editSave?.requestId)) { finishEditSave(session, live); return; }
    const result = rebaseEdit(session, live);
    if (!result.conflicts.length) {
        snapshot = live;
        edit = result.session;
        editConflict = null;
        if (editSave) { editSave.error = null; editSave.saving = false; editSave.requestId = uid(); if (!edit.changes().length) editSave.signing = false; }
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
    if (value.joinMembers) return value.joinMembers.map(record => record.name + '\n' +
        t('modelInstances') + ': ' + record.models.length + ' · ' + t('notes') + ': ' + record.notes.length + ' · ' + t('documentation') + ': ' + record.links.length).join('\n\n');
    if (Array.isArray(value)) return value.map(instance =>
        (data().assets.find(asset => asset.id === instance.model)?.name || instance.model) + '\n' +
        ['position', 'rotation', 'scale'].map(key => t(key) + ': ' + instance.transform[key].map(transformNumber).join(', ')).join('\n')
    ).join('\n\n');
    if (value.position && value.rotation && value.scale) return ['position', 'rotation', 'scale'].map(key => t(key) + ': ' + value[key].map(transformNumber).join(', ')).join('\n');
    if (value.position && value.target) return t('savedView');
    return value.name || value.id || t('savedView');
}

function renderEditConflict() {
    const labels = { name: 'name', floorId: 'floor', models: 'modelInstances', transform: 'placement', 'views.2D': 'view2D', 'views.3D': 'view3D', record: 'editExhibit', join: 'join' };
    const ready = editConflict.conflicts.every(item => editConflict.choices[item.key]);
    $('#inspector').innerHTML = `<div class="inspector-header"><h1>${esc(t('resolveChanges'))}</h1></div><div class="panel-content"><form id="conflict-form" novalidate>${editConflict.conflicts.map((item, index) => `<article class="conflict-card"><h3>${esc(item.id)}</h3>${item.yours === null && item.current ? `<p class="deletion-warning">${esc(t('deleteExhibitWarning'))}</p>` : ''}<p class="small muted">${esc(t(labels[item.field] || 'placement'))}</p>${item.field === 'join' ? `<p class="small muted">${esc(t(item.unavailable ? 'joinMissing' : 'joinConflictHint'))}</p>` : ''}<div class="conflict-values"><div><span class="small muted">${esc(t('current'))}</span><p>${esc(conflictValue(item.current))}</p></div><div><span class="small muted">${esc(t('yours'))}</span><p>${esc(conflictValue(item.yours))}</p></div></div><label class="sr-only" for="conflict-${index}">${esc(t('chooseVersion'))}</label><select id="conflict-${index}" data-conflict-key="${esc(item.key)}">${options([['', t('chooseVersion')], ['current', t('keepCurrent')], ...(item.unavailable ? [] : [['mine', t('useMine')]])], editConflict.choices[item.key] || '')}</select></article>`).join('')}<div class="creation-actions">${button('cancel', 'cancelConflict', 'quiet')}<button type="submit" class="primary" id="resolve-edit" ${ready ? '' : 'disabled'}>${esc(t('resolveChanges'))}</button></div></form></div>`;
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
        if (editSave) { editSave.error = null; editSave.saving = false; editSave.requestId = uid(); if (!edit.changes().length) editSave.signing = false; }
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

let fileRefreshInFlight = false;
function canRefreshFromFiles() {
    return !document.hidden && !edit && !statusSaving && !$('#dialog').open &&
        !document.activeElement?.closest('#note-form, #link-form, #link-search');
}

async function refreshFromFiles() {
    if (fileRefreshInFlight || !canRefreshFromFiles()) return;
    fileRefreshInFlight = true;
    const previous = snapshot;
    try {
        const current = await api.load();
        if (!canRefreshFromFiles() || snapshot !== previous) return;
        const stamp = value => JSON.stringify([value.revision, value.structureRevision, value.exhibits.map(item => [item.id, item.revision, item.contentTag])]);
        if (!snapshot || stamp(current) !== stamp(snapshot)) acceptSnapshot(current);
    } catch {
        // A later refresh can read the files after an external editor finishes saving.
    } finally {
        fileRefreshInFlight = false;
    }
}

setInterval(refreshFromFiles, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshFromFiles(); });

function recoverDraft() {
    try {
        const saved = draftStore?.read('edit');
        if (!saved?.base || !saved.value) return;
        saved.base = restoreEditSnapshot(saved.base, snapshot);
        saved.value = restoreEditSnapshot(saved.value, snapshot);
        if (typeof saved.creation?.record?.name !== 'string') saved.creation = null;
        const session = new EditSession(saved.base);
        session.value = saved.value;
        if (!session.changes().length && !saved.creation) { saveDraftCategory('edit', null); return; }
        recoverableEdit = saved;
        announce(t('unsavedEdits'), 'recoverEdit', 'recover');
    } catch { saveDraftCategory('edit', null); }
}

function recoverEdit() {
    const saved = recoverableEdit;
    if (!saved) return;
    edit = new EditSession(saved.base);
    saved.value.exhibits.forEach(record => { record.status = normalizeStatus(record.status); });
    edit.value = saved.value;
    edit.undoStack = (saved.undoStack || []).map(value => restoreEditSnapshot(value, snapshot));
    edit.redoStack = (saved.redoStack || []).map(value => restoreEditSnapshot(value, snapshot));
    creation = saved.creation || null;
    creationOpen = Boolean(saved.creationOpen && creation);
    selected = creationOpen ? null : saved.selected || selected;
    editSelection = new Set(saved.selection || (selected ? [selected] : []));
    floorId = saved.floorId || floorId;
    activeInstance = saved.activeInstance || 0;
    gizmo = saved.gizmo ?? 'combined';
    hardwareSelection = normalizeHardwareSelection(saved.hardwareSelection, data(), floorId);
    transformSpace = saved.transformSpace === 'local' ? 'local' : 'world';
    axisConstraint = ['X', 'Y', 'Z'].includes(saved.axisConstraint) ? saved.axisConstraint : '';
    snap = Boolean(saved.snap);
    editSave = saved.signature ? { signature: saved.signature, requestId: saved.requestId || '', signing: false, saving: false } : null;
    recoverableEdit = null;
    changed();
    announce(t('editsRestored'));
}

function duplicateSelected(id = selected, origin = 'other') {
    if (!edit || editSave?.saving) return;
    const record = data().exhibits.find(item => item.id === id);
    if (!record) return;
    map?.cancelTransform();
    const copy = duplicateExhibit(record, data().exhibits);
    selected = copy.id;
    hardwareSelection = [];
    editSelection = new Set([copy.id]);
    creationOpen = false;
    applyEdit(state => state.exhibits.push(copy), { rebuild: true, origin });
    if (matchMedia('(max-width:860px)').matches) setView('detail');
}

function setEditTool(tool) {
    if (!edit || !selectionTransforms().length || editSave?.saving) return;
    map?.cancelTransform();
    gizmo = gizmo === tool ? '' : tool;
    persistEdit();
    syncEditTools();
    renderMapUI();
    $(`[data-tool="${tool}"]`)?.focus({ preventScroll: true });
}

const actions = {
    accessibility: () => {
        const url = new URL('accessibility.html', location.href);
        url.searchParams.set('return', location.pathname + location.search + location.hash);
        location.assign(url.href);
    },
    refresh,
    enterEdit,
    resumeNote: () => { drafts[selected].readOnly = false; renderPanel(); },
    backToNote: () => { drafts[selected].readOnly = true; persistDrafts(); renderPanel(); },
    discardDraft: () => discardComposer('notes'),
    restoreDraft: restoreComposer,
    cancelCreation,
    cancelEdit,
    cancelEditSignature,
    confirmEditSave,
    restoreEdit,
    recoverEdit,
    resumeCreation: () => openExhibitEditor(true),
    duplicateExhibit: () => duplicateSelected(),
    renameExhibit,
    cancelJoin: () => select(selected),
    joinExhibits: openJoinSelection,
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
    addLink: () => editLink(),
    cancelLink: () => discardComposer('links'),
    closeDialog,
    clear: () => {
        query = '';
        floorFilter = '';
        if (!edit) statusFilter = '';
        scope = 'name';
        renderSidebar();
    },
    focus: async () => {
        await ensureMap();
        if (!map?.focusObjects().length) { announce(t('unplaced')); return; }
        setView('map');
        map.focus();
        },
    editExhibit: ({ origin = 'other' } = {}) => openExhibitEditor(false, origin),
    newExhibit: ({ origin = 'other' } = {}) => openExhibitEditor(true, origin),
    undo: ({ origin = 'other' } = {}) => editHistory('undo', origin),
    redo: ({ origin = 'other' } = {}) => editHistory('redo', origin),
    saveExit,
    structureConflict: () => {
        if (!editConflict) return structureConflict();
        editConflict.open = true;
        renderInspector(); renderMapUI(); syncEditTools(); setView('detail');
    }
};

$('#inspector').addEventListener('toggle', event => {
    const section = event.target;
    if (!edit || editSave?.saving || !section.isConnected || !section.open) return;
    if (section.dataset.hardwarePlacement !== undefined) {
        const id = section.dataset.exhibit, index = Number(section.dataset.hardwarePlacement);
        if (!hardwareSelected(id, index, editSelection, hardwareSelection)) select(id, index, false, true);
    }
}, true);

document.addEventListener('click', async event => {
    const element = event.target.closest('button,[data-select]');
    if (!element) return;
    const origin = element.closest('#sidebar, #editbar') ? 'sidebar' : element.closest('#inspector') ? 'inspector' : 'other';
    try {
        if (element.dataset.floor) { changeFloor(element.dataset.floor); return; }
        if (element.dataset.renameExhibit) { renameExhibit(element.dataset.renameExhibit, origin); return; }
        if (element.dataset.trashExhibit) { removeExhibit(element.dataset.trashExhibit, origin); return; }
        if (element.dataset.deleteNote) { deleteNoteDialog(element.dataset.deleteNote); return; }
        if (element.dataset.language) { setLanguage(element.dataset.language); render(); return; }
        if (element.dataset.select) { select(element.dataset.select, 0, event.shiftKey, false, origin); return; }
        if (element.dataset.tab) { collapseEmptyDraft(); tab = element.dataset.tab; renderInspector(); return; }
        if (element.dataset.correct) {
            const record = exhibit();
            if (hasNoteDraft(drafts[record.id])) {
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
            try { await copyText(link.url); announce(t('copied')); }
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
            const record = exhibit();
            const key = element.dataset.setView || element.dataset.resetView || element.dataset.previewView;
            await ensureMap();
            if (!map || !record) throw Error('mapUnavailable');
            if (element.dataset.previewView) {
                const mode = viewMode(key);
                map.applyView(record.views?.[key] || map.fallbackView([record.id], mode), mode);
                setView('map');
                return;
            }
            const preset = element.dataset.setView ? map.captureView(viewMode(key)) : null;
            applyEdit(state => {
                const target = state.exhibits.find(item => item.id === record.id);
                target.views ||= {};
                if (preset) target.views[key] = preset;
                else delete target.views[key];
            }, { rebuild: true });
            $('#inspector .view-presets').open = true;
            return;
        }
        if (element.dataset.tool) { setEditTool(element.dataset.tool); return; }
        if (element.dataset.duplicateExhibit) { duplicateSelected(element.dataset.duplicateExhibit, origin); return; }
        if (element.dataset.addHardware) { addHardware(element.dataset.addHardware); return; }
        if (element.hasAttribute('data-select-parent-exhibits')) { selectParentExhibits([...new Set(hardwareSelection.map(entry => entry.exhibitId))]); return; }
        if (element.dataset.selectParent) { selectParentExhibits([element.dataset.selectParent]); return; }
        if (element.dataset.editInstance !== undefined) {
            select(element.dataset.exhibit || selected, Number(element.dataset.editInstance), event.shiftKey, true); return;
        }
        if (element.dataset.removeInstance !== undefined) { removeHardware(Number(element.dataset.removeInstance)); return; }
        if (element.dataset.duplicateInstance !== undefined) { duplicateHardware(Number(element.dataset.duplicateInstance)); return; }
        if (element.dataset.format) {
            if (element.dataset.format === 'link') noteLinkDialog();
            else noteEditor?.command(element.dataset.format);
            return;
        }
        const action = element.dataset.action;
        if (action?.startsWith('view:')) { setView(action.split(':')[1]); return; }
        if (['newExhibit', 'editExhibit', 'undo', 'redo'].includes(action)) await actions[action]({ origin });
        else if (actions[action]) await actions[action]();
    } catch (error) {
        announce(errorText(error));
    }
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
    if (edit && event.target.matches('input[data-vector]') && ['Enter', 'Escape'].includes(event.key)) {
        event.preventDefault();
        const input = event.target;
        if (event.key === 'Escape') {
            const value = input.hasAttribute('data-selection-delta') ? input.dataset.vector === 'scale' ? 1 : 0 : inspectorFieldTransform(input)?.[input.dataset.vector][Number(input.dataset.axis)];
            input.value = value == null ? '' : transformNumber(value);
        } else {
            applyEditorField(input);
            if (!input.checkValidity() || !input.value.trim()) return;
        }
        input.blur();
        updateNumberFills($('#inspector'));
        return;
    }
    if (!typing && edit && map?.transformKey(event)) { event.preventDefault(); return; }
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
            actions[key === 'y' || event.shiftKey ? 'redo' : 'undo']({ origin: event.target.closest('#sidebar, #editbar') ? 'sidebar' : 'other' });
        } else if (!event.metaKey && !event.ctrlKey && !event.altKey && ['g', 'r', 's'].includes(key)) {
            event.preventDefault();
            const tool = { g: 'translate', r: 'rotate', s: 'scale' }[key];
            if (selectionTransforms().length && !creationOpen && !editConflict?.open) {
                gizmo = tool; syncEditTools(); renderTransformToolbar(); map?.beginTransform(tool); persistEdit();
            }
        }
    }
    if (event.target.matches('[data-select]') && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        select(event.target.dataset.select, 0, event.shiftKey, false, 'sidebar');
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
    panelMotion.settle();
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
    panelMotion.settle();
    event.preventDefault();
    const width = $('#inspector').clientWidth + (event.key === 'ArrowLeft' ? 24 : -24);
    resizeInspector(width);
});
window.addEventListener('pagehide', () => {
    if (document.activeElement?.closest('#structure-form')) applyEditorField(document.activeElement);
    persistDrafts(); persistLinks(); persistEdit();
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
