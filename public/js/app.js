import {
    Api,
    uid
} from './api.js';
import {
    EditSession,
    identity,
    MapPlacement,
    STATUSES,
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
const $ = s => document.querySelector(s),
    api = new Api();
let snapshot = null,
    selected = 'charging',
    floorId = 'source-level',
    tab = 'notes',
    edit = null,
    map = null,
    mapState = 'mapLoading',
    view = 'list',
    expanded = false,
    flat = matchMedia('(max-width:860px)').matches,
    query = '',
    scope = 'nameLocation',
    floorFilter = '',
    statusFilter = '',
    mapMode = 'iso',
    gizmo = '',
    snap = false,
    noticeTimer, dialogCleanup = null;
let drafts = {};
try {
    drafts = JSON.parse(localStorage.getItem('hub-drafts') || '{}');
    Object.values(drafts).forEach(draft => { draft.saving = false; });
} catch {}
const data = () => edit?.value || snapshot;
const exhibit = () => data()?.exhibits.find(e => e.id === selected);
const floor = () => data()?.floors.find(f => f.id === floorId);
const titleFloor = id => data()?.floors.find(f => f.id === id)?.names[lang()] || id;
const icon = {
    ok: '✓',
    problem: '!',
    retired: '⏻'
};
const statusHTML = status => `<span class="status-badge"><span class="status-symbol ${status}" aria-hidden="true">${icon[status]}</span>${esc(t(status))}</span>`;
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
        localStorage.setItem('hub-drafts', JSON.stringify(drafts, (key, value) => key === 'saving' ? undefined : value));
        return true;
    } catch {
        announce(t('draftFailed'));
        return false;
    }
}

function persistEdit() {
    try {
        if (edit) localStorage.setItem('hub-edit', JSON.stringify({
            base: edit.base,
            value: edit.value
        }));
        else localStorage.removeItem('hub-edit');
    } catch {
        announce(t('draftFailed'));
    }
}

function setView(value) {
    view = value;
    document.body.dataset.view = value;
    renderMobile();
    map?.resize();
}


function iconButton(label, action, symbol, extra = '') {
    return `<button type="button" class="icon-button" data-action="${action}" aria-label="${esc(t(label))}" title="${esc(t(label))}" ${extra}>${symbol}</button>`;
}

function displayName(record) {
    return ['mini-ar', 'reserve'].includes(record.id) ? record.name.replace(' · Demo', '') : record.name;
}

function floorLabel(record) {
    return ['source-level', 'demo-gallery'].includes(record.id) ? record.names[lang()].split(' · ')[0] : record.names[lang()];
}

function renderHeader() {
    $('#header').innerHTML = '';
}

function renderSidebar() {
    const filtered = Boolean(query || floorFilter || statusFilter || scope !== 'nameLocation');
    const frows = [
        ['', t('allFloors')], ...data().floors.map(f => [f.id, f.names[lang()]])
    ];
    $('#sidebar').setAttribute('aria-label', t('exhibits'));
    $('#sidebar').innerHTML = `
        <div class="sidebar-title"><h2>${esc(t('exhibits'))}</h2></div>
        <div class="search-row">
            <div class="searchbox">
                <span class="search-icon" aria-hidden="true">⌕</span>
                <input id="search" type="search" value="${esc(query)}" placeholder="${esc(t('searchShort'))}" aria-label="${esc(t('search'))}" autocomplete="off">
            </div>
            <details class="filter-menu">
                <summary class="icon-button ${filtered ? 'active' : ''}" title="${esc(t('filters'))}" aria-label="${esc(t('filters'))}">☷${filtered ? '<i class="filter-dot"></i>' : ''}</summary>
                <div class="popover">
                    <label for="scope">${esc(t('scope'))}</label>
                    <select id="scope">${options(['nameLocation', 'notes', 'documentation'].map(x => [x, t(x)]), scope)}</select>
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
            <span class="sample-label" title="${esc(t('demo'))}">${esc(t('sampleShort'))}</span>
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
        const text = scope === 'notes' ? e.notes.map(n => n.body).join(' ') : scope === 'documentation' ? e.links.map(l => l.title + ' ' + l.url).join(' ') : e.name + ' ' + e.location + ' ' + titleFloor(e.floorId);
        return text.toLocaleLowerCase(lang()).includes(q);
    });
    const filtered = Boolean(query || floorFilter || statusFilter || scope !== 'nameLocation');
    $('.active-filters').hidden = !filtered;
    $('#filter-description').textContent = [scope !== 'nameLocation' ? t(scope) : '', floorFilter ? titleFloor(floorFilter) : '', statusFilter ? t(statusFilter) : '', query ? '“' + query + '”' : ''].filter(Boolean).join(' · ');
    $('#exhibit-list').innerHTML = records.length ? records.map(e => `
        <button class="exhibit-row ${e.id === selected ? 'active' : ''}" data-select="${esc(e.id)}" aria-pressed="${e.id === selected}" title="${esc(titleFloor(e.floorId) + ' · ' + e.location + ' · ' + t(e.placed ? e.status : 'unplaced'))}">
            <span class="exhibit-name">${esc(displayName(e))}</span>
            <span class="status-symbol ${e.status}" aria-label="${esc(t(e.status))}">${icon[e.status]}</span>
        </button>`).join('') : `<p class="empty">${esc(t('noResults'))}</p>`;
}

function renderMapUI() {
    $('#map-heading').innerHTML = `
        <div class="floor-pill" title="${esc(floor()?.names[lang()] || '')}">
            <span aria-hidden="true">▱</span>
            <select id="map-floor" aria-label="${esc(t('floor'))}">
                ${options(data().floors.map(f => [f.id, floorLabel(f)]), floorId)}
            </select>
        </div>`;
    $('#map-floor').addEventListener('change', e => changeFloor(e.target.value));
    $('#map-controls').innerHTML = `
        <div class="map-toolbar" aria-label="${esc(t('keyboardMap'))}">
            <select id="camera-view" aria-label="${esc(t('cameraView'))}" title="${esc(t('cameraView'))}">
                ${options([['flat', '2D'], ['iso', t('iso')], ['top', t('top')], ['perspective', t('perspective')]], flat ? 'flat' : mapMode)}
            </select>
            <span class="toolbar-divider"></span>
            ${iconButton('focus', 'focus', '⌖')}
            ${iconButton('home', 'camera:home', '⌂')}
            ${!flat ? iconButton('zoomOut', 'camera:zoomOut', '−') + iconButton('zoomIn', 'camera:zoomIn', '+') : ''}
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
        flat = value === 'flat';
        if (!flat) {
            mapMode = value;
            await ensureMap();
            map?.setView(value);
        }
        renderMapUI();
    });
    $('#map-canvas').hidden = flat;
    $('#flat-map').hidden = !flat;
    $('#map-message').textContent = flat || mapState === 'mapReady' ? '' : t(mapState);
    renderFlat();
    map?.resize();
}

function renderFlat() {
    const records = data().exhibits.filter(e => e.floorId === floorId && e.placed);
    const xs = records.map(e => e.transform.position[0]),
        zs = records.map(e => e.transform.position[2]);
    const minX = Math.min(-15, ...xs) - 5,
        maxX = Math.max(15, ...xs) + 5,
        minZ = Math.min(-15, ...zs) - 5,
        maxZ = Math.max(15, ...zs) + 5;
    const w = maxX - minX,
        h = maxZ - minZ;
    $('#flat-map').innerHTML = `<svg viewBox="${minX} ${minZ-8} ${w} ${h+24}" role="group" aria-label="${esc(t('map'))}"><defs><pattern id="grid" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M 5 0 L 0 0 0 5" fill="none" stroke="#c8d3dc" stroke-width=".06"/></pattern></defs><rect x="${minX}" y="${minZ}" width="${w}" height="${h}" fill="url(#grid)"/>${records.map(e=>{const x=e.transform.position[0],z=e.transform.position[2];return `<g class="flat-marker" role="button" tabindex="0" data-select="${esc(e.id)}" aria-label="${esc(e.name+' · '+t(e.status))}" transform="translate(${x} ${z})"><circle r="${selected===e.id?1:0.7}" fill="${({ok:'#227247',problem:'#b03d3e',retired:'#5a6572'})[e.status]}" stroke="${selected===e.id?'#086aca':'white'}" stroke-width=".25"/><text y="2.5" text-anchor="middle" style="font-size:1.1px;stroke-width:.25px">${esc(e.name)}</text></g>`;}).join('')}</svg>`;
}
async function ensureMap() {
    if (map) return;
    try {
        const {
            MapView
        } = await import('./map.js');
        const instance = new MapView($('#map-canvas'), {
            onSelect: select,
            onState: key => {
                mapState = key;
                $('#map-message').textContent = flat || key === 'mapReady' ? '' : t(key);
            },
            onTransform: (id, transform) => {
                if (!edit) return;
                edit.change(s => {
                    const e = s.exhibits.find(x => x.id === id);
                    if (e) e.transform = transform;
                });
                persistEdit();
                renderEditBar();
                renderFlat();
            }
        });
        await instance.init();
        map = instance;
        await updateMap(true);
        map.setView(mapMode);
    } catch (e) {
        mapState = 'mapUnavailable';
        $('#map-message').textContent = t(mapState);
    }
}
async function updateMap(reset = false) {
    if (map) await map.setData(data(), floorId, selected, Boolean(edit), {
        reset
    });
    renderFlat();
}

function select(id) {
    const e = data().exhibits.find(x => x.id === id);
    if (!e) return;
    const changed = floorId !== e.floorId;
    selected = id;
    floorId = e.floorId;
    renderList();
    renderInspector();
    renderMapUI();
    updateMap(changed);
    if (changed) announce(t('floorChanged') + ': ' + titleFloor(floorId));
    if (matchMedia('(max-width:860px)').matches) setView('detail');
}

function changeFloor(id) {
    floorId = id;
    const e = exhibit();
    if (e?.floorId !== id) selected = data().exhibits.find(x => x.floorId === id)?.id || null;
    renderMapUI();
    renderList();
    renderInspector();
    updateMap(true);
}


function noteHTML(n) {
    const author = n.id.startsWith('sample-') ? n.author.replace(' · Demo', '') : n.author;
    const body = n.id === 'sample-repair' ? n.body.replace('**Beispielnotiz — keine Betriebsdaten.**\n\n', '') : n.body;
    const shortDate = new Intl.DateTimeFormat(lang() === 'de' ? 'de-DE' : 'en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit'
    }).format(new Date(n.at));
    return `
        <article class="note">
            <div class="note-meta">
                <span class="note-author">${esc(author)}</span>
                <time class="note-date" datetime="${esc(n.at)}" title="${esc(date(n.at, true))}">${esc(shortDate)}</time>
            </div>
            <div class="note-body">${markdown(body)}</div>
            ${n.images.map(id => `<a href="api.php?action=asset&kind=image&id=${encodeURIComponent(id)}" target="_blank" rel="noopener"><img class="note-image" src="api.php?action=asset&kind=image&id=${encodeURIComponent(id)}" alt="${esc(t('image'))}" loading="lazy"></a>`).join('')}
            <div class="note-footer">
                <span class="muted small" title="${n.corrections?.length ? esc(n.corrections.at(-1).signature + ' · ' + date(n.corrections.at(-1).at)) : ''}">${n.corrections?.length ? esc(t('edited')) : ''}</span>
                <button class="icon-button note-edit" data-correct="${esc(n.id)}" aria-label="${esc(t('correct'))}" title="${esc(t('correct'))}">✎</button>
            </div>
        </article>`;
}

function renderInspector() {
    const e = exhibit();
    if (!e) {
        $('#inspector').innerHTML = `<div class="panel-content empty">${esc(t('noSelection'))}</div>`;
        return;
    }
    $('#inspector').innerHTML = `
        <div class="inspector-header">
            <div class="inspector-tools">
                <h1 title="${esc(e.location + ' · ' + titleFloor(e.floorId))}">${esc(displayName(e))}</h1>
                ${iconButton(expanded ? 'collapse' : 'expand', 'expand', expanded ? '↙' : '↗')}
            </div>
            <button class="compact-status" data-action="status" aria-label="${esc(t('changeStatus') + ': ' + t(e.status))}" title="${esc(e.statusChanged.signature + ' · ' + date(e.statusChanged.at))}">
                ${statusHTML(e.status)}<span aria-hidden="true">⌄</span>
            </button>
        </div>
        <div class="tabs" role="tablist" aria-label="${esc(t('detail'))}">
            ${['notes', 'documentation'].map(key => `<button role="tab" id="tab-${key}" aria-controls="inspector-content" aria-selected="${tab === key}" tabindex="${tab === key ? 0 : -1}" data-tab="${key}">${esc(t(key))}</button>`).join('')}
        </div>
        <div class="panel-content" id="inspector-content" role="tabpanel" aria-labelledby="tab-${tab}"></div>`;
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

function renderPanel() {
    const e = exhibit();
    if (!e) return;
    const el = $('#inspector-content');
    if (tab === 'notes') {
        el.innerHTML = `<div id="composer-slot"></div>${e.notes.map(noteHTML).join('')}`;
        if (!drafts[e.id]) {
            drafts[e.id] = newDraft(e);
            drafts[e.id].open = false;
        }
        renderComposer();
    } else {
        el.innerHTML = `
            <button class="add-link" data-action="addLink"><span aria-hidden="true">+</span>${esc(t('addLink'))}</button>
            ${e.links.length ? e.links.map(l => `
                <article class="link-card">
                    <a class="document-open" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.url)}"><span class="file-symbol" aria-hidden="true">↗</span><span>${esc(l.title)}</span></a>
                    ${l.description ? `<p>${esc(l.description)}</p>` : ''}
                    <div class="link-actions">
                        <button class="quiet" data-copy="${esc(l.id)}" title="${esc(l.url)}">${esc(t('copy'))}</button>
                        <button class="icon-button" data-edit-link="${esc(l.id)}" aria-label="${esc(t('edit'))}" title="${esc(t('edit'))}">✎</button>
                    </div>
                </article>`).join('') : `<p class="empty">${esc(t('noLinksHint'))}</p>`}`;
    }
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
        open: true,
        noteId: n?.id || null
    };
}


function renderComposer() {
    const e = exhibit(),
        d = drafts[e.id];
    if (!d) return;
    const active = d.open || Boolean(d.body || d.images.length || d.noteId);
    $('#composer-slot').innerHTML = `
        <form class="composer ${active ? 'composing' : ''}" id="note-form" novalidate>
            ${d.noteId ? `<div class="composer-correction">${esc(t('correct'))}</div>` : ''}
            <label class="sr-only" for="note-body">${esc(t('noteBody'))}</label>
            <textarea id="note-body" rows="2" placeholder="${esc(t('writeNote'))}" ${d.preview ? 'hidden' : ''}>${esc(d.body)}</textarea>
            <div class="note-body" id="note-preview" ${d.preview ? '' : 'hidden'}>${markdown(d.body)}</div>
            <div class="composer-expanded" ${active ? '' : 'hidden'}>
                <div class="attachments">
                    ${d.existingImages.map(id => `<div class="attachment"><img src="api.php?action=asset&kind=image&id=${encodeURIComponent(id)}" alt="${esc(t('image'))}"><button type="button" data-remove-existing="${esc(id)}" aria-label="${esc(t('remove'))}">×</button></div>`).join('')}
                    ${d.images.map((im, i) => `<div class="attachment"><img src="${esc(im.data)}" alt="${esc(im.name)}"><button type="button" data-remove-image="${i}" aria-label="${esc(t('remove'))}">×</button></div>`).join('')}
                </div>
                <div class="composer-tools">
                    <div class="toolbar">
                        <button type="button" class="icon-button" data-format="bold" aria-label="${esc(t('bold'))}" title="${esc(t('bold'))}"><strong>B</strong></button>
                        <button type="button" class="icon-button" data-format="list" aria-label="${esc(t('list'))}" title="${esc(t('list'))}">≡</button>
                        <button type="button" class="icon-button" data-action="notePreview" aria-label="${esc(t(d.preview ? 'write' : 'preview'))}" title="${esc(t(d.preview ? 'write' : 'preview'))}">◉</button>
                        <label class="icon-button photo-button" for="note-image" title="${esc(t('photoHint'))}"><span aria-hidden="true">⊕</span><span class="sr-only">${esc(t('photo'))}</span></label>
                        <input class="file-input" type="file" id="note-image" aria-label="${esc(t('photo'))}" accept="image/png,image/jpeg,image/webp" multiple>
                    </div>
                    <button class="primary post-button" type="submit">${esc(t(d.saving ? 'saving' : 'postShort'))}</button>
                </div>
                <div class="composer-secondary">
                    <span class="draft-label" title="${esc(t('draftScope'))}">${esc(t('draftShort'))}</span>
                    <details class="note-options"><summary class="icon-button" title="${esc(t('more'))}" aria-label="${esc(t('more'))}">···</summary><div class="popover">${d.noteId ? '' : `<label for="note-status">${esc(t('status'))}</label><select id="note-status">${statusOptions(d.status, true)}</select>`}${button('close', 'closeComposer', 'quiet')}</div></details>
                </div>
            </div>
            ${d.signing ? `
                <div class="signature-step">
                    <label for="note-signature">${esc(t('signature'))}</label>
                    <input id="note-signature" autocomplete="off" maxlength="120" value="${esc(d.signature)}" aria-describedby="note-error" placeholder="${esc(t('yourName'))}">
                    <div class="row signature-actions">${button('cancel', 'cancelSignature', 'quiet')}<button type="button" class="primary" data-action="confirmNote" ${d.saving ? 'disabled' : ''}>${esc(t(d.saving ? 'saving' : 'publish'))}</button></div>
                </div>` : ''}
            <div id="note-error" class="error" role="alert" ${d.error ? '' : 'hidden'}>${d.error ? esc(t(d.error)) : ''}</div>
            ${d.conflict ? button('reviewConflict', 'noteConflict', 'quiet') : ''}
        </form>`;
    const form = $('#note-form');
    if (d.saving) form.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = true; });
    $('#note-body').addEventListener('focus', () => {
        d.open = true;
        form.classList.add('composing');
        form.querySelector('.composer-expanded').hidden = false;
    });
    $('#note-body').addEventListener('input', ev => {
        d.body = ev.target.value;
        delete d.error;
        persistDrafts();
    });
    $('#note-signature')?.addEventListener('input', ev => {
        d.signature = ev.target.value;
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
    $('#note-image').addEventListener('change', ev => addImages([...ev.target.files], e.id));
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
    const d = drafts[id];
    for (const file of files) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            d.error = 'invalidImage';
            break;
        }
        if (file.size > 8 * 1024 * 1024) {
            d.error = 'fileTooLarge';
            break;
        }
        if (d.images.length + d.existingImages.length >= 8) {
            d.error = 'invalidImage';
            break;
        }
        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        d.images.push({
            name: file.name,
            data,
            id: uid()
        });
    }
    persistDrafts();
    if (selected === id) renderComposer();
}
async function postNote(id) {
    const d = drafts[id];
    if (d.saving) return;
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
                const r = await api.upload(file, 'image', d.signature, image.id);
                image.uploaded = r.id;
                persistDrafts();
            }
            imageIds.push(image.uploaded);
        }
        const payload = {
            action: d.noteId ? 'correctNote' : 'note',
            exhibitId: id,
            baseRevision: d.baseRevision,
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
    if (edit) {
        for (const kind of ['exhibits', 'floors'])
            for (const r of edit.value[kind]) {
                const live = value[kind].find(x => x.id === r.id);
                if (live && kind === 'exhibits') {
                    for (const k of ['notes', 'links', 'status', 'statusChanged']) r[k] = structuredClone(live[k]);
                }
            }
    }
    render();
}

function renderMobile() {
    $('#mobile-nav').innerHTML = ['list', 'map', 'detail'].map(key => button(key === 'list' ? 'exhibits' : key, 'view:' + key, view === key ? 'active' : '', `aria-current="${view===key?'page':'false'}"`)).join('');
}

function renderEditBar() {
    const el = $('#editbar');
    el.hidden = !edit;
    if (!edit) return;
    const count = edit.changes().length;
    el.innerHTML = `<span class="edit-label">${esc(t('editing'))} · ${count} ${esc(t('changes'))}</span><div class="row">${button('editExhibit','editExhibit','',exhibit()?'':'disabled')}${button('editFloor','editFloor')}${button('newExhibit','newExhibit')}${button('newFloor','newFloor')}${button('undo','undo','',edit.undoStack.length?'':'disabled')}${button('redo','redo','',edit.redoStack.length?'':'disabled')}${button('trash','trash')}${button('models','models')}<select id="gizmo" aria-label="${esc(t('gizmo'))}" style="width:auto;max-width:140px;min-height:36px">${options([['',t('gizmo')],['translate',t('move')],['rotate',t('rotate')],['scale',t('scaleTool')]],gizmo)}</select><label class="check small" style="margin:0"><input type="checkbox" id="snap" ${snap?'checked':''}>${esc(t('snap'))}</label>${button('saveExit','saveExit','primary')}</div>`;
    $('#gizmo').addEventListener('change', e => {
        gizmo = e.target.value;
        map?.setTool(gizmo, snap);
    });
    $('#snap').addEventListener('change', e => {
        snap = e.target.checked;
        map?.setTool(gizmo, snap);
    });
}

function render() {
    renderHeader();
    if (!snapshot) return;
    if (!data().floors.some(f => f.id === floorId)) floorId = data().floors[0]?.id;
    if (!data().exhibits.some(e => e.id === selected)) selected = data().exhibits.find(e => e.floorId === floorId)?.id || null;
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

function statusDialog() {
    const e = structuredClone(exhibit()),
        requestId = uid();
    showDialog('changeStatus', `<p style="margin-bottom:18px">${esc(e.name)}</p><div class="field"><label for="new-status">${esc(t('status'))}</label><select id="new-status" name="status">${statusOptions(e.status)}</select></div>${signatureField()}${footer()}`, async form => {
        const signature = requireSignature(form);
        const result = await api.save({
            action: 'status',
            exhibitId: e.id,
            baseRevision: e.revision,
            requestId,
            signature,
            status: form.get('status')
        });
        closeDialog();
        acceptSnapshot(result.snapshot);
        announce(t('saved'));
    });
}

function linkDialog(id = null) {
    const e = structuredClone(exhibit()),
        link = e.links.find(l => l.id === id),
        requestId = uid();
    showDialog(link ? 'edit' : 'addLink', `<p class="small muted" style="margin-bottom:18px">${esc(t('nasHint'))}</p><div class="field"><label for="link-title">${esc(t('title'))}</label><input id="link-title" name="title" value="${esc(link?.title||'')}" maxlength="200"></div><div class="field"><label for="link-url">${esc(t('url'))}</label><input type="url" id="link-url" name="url" value="${esc(link?.url||'')}" placeholder="https://nas.example.invalid/file.pdf"></div><div class="field"><label for="link-description">${esc(t('description'))}</label><textarea id="link-description" name="description" style="min-height:80px">${esc(link?.description||'')}</textarea></div>${signatureField()}${link?`<label class="check"><input type="checkbox" name="remove">${esc(t('remove'))}</label>`:''}${footer()}`, async form => {
        const signature = requireSignature(form);
        let links = e.links.filter(l => l.id !== id);
        if (!form.has('remove')) {
            const url = String(form.get('url')).trim();
            let u;
            try {
                u = new URL(url);
            } catch {
                throw Error('invalidUrl');
            }
            if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('invalidUrl');
            const title = String(form.get('title')).trim();
            if (!title) throw Error('invalidInput');
            links.push({
                id: id || uid(),
                title,
                url,
                description: form.get('description')
            });
        }
        const result = await api.save({
            action: 'links',
            exhibitId: e.id,
            baseRevision: e.revision,
            requestId,
            signature,
            links
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
    renderEditBar();
    renderHeader();
    updateMap();
}

function changed() {
    persistEdit();
    render();
    map?.setTool(gizmo, snap);
}

function structureDialog(kind, isNew = false) {
    if (!edit) return;
    const source = kind === 'floors' ? floor() : exhibit();
    if (!source && !isNew) return;
    const record = isNew ? (kind === 'floors' ? {
        id: uid(),
        names: {
            de: '',
            en: ''
        },
        order: data().floors.length,
        elevation: 0,
        modelId: data().assets.find(a => a.id === 'demo-gallery')?.id,
        transform: identity(),
        camera: {
            ...identity(),
            position: [28, 27, 33]
        },
        revision: 0
    } : {
        id: uid(),
        name: '',
        location: '',
        floorId,
        modelId: null,
        transform: identity(),
        placed: false,
        status: 'retired',
        statusChanged: {
            signature: '',
            at: new Date().toISOString()
        },
        revision: 0,
        notes: [],
        links: []
    }) : structuredClone(source);
    const isFloor = kind === 'floors';
    let transform = structuredClone(record.transform);
    let locked = true;
    const modelOptions = options([...(isFloor ? [] : [
        ['', t('noModel')]
    ]), ...data().assets.map(a => [a.id, a.name])], record.modelId || '');
    showDialog(isNew ? (isFloor ? 'newFloor' : 'newExhibit') : (isFloor ? 'editFloor' : 'editExhibit'), `
 ${isFloor?`<p class="small muted" style="margin-bottom:16px">${esc(t('floorAlignHint'))}</p><div class="grid2"><div class="field"><label for="name-de">${esc(t('nameDe'))}</label><input name="nameDe" id="name-de" value="${esc(record.names.de)}"></div><div class="field"><label for="name-en">${esc(t('nameEn'))}</label><input name="nameEn" id="name-en" value="${esc(record.names.en)}"></div></div><div class="grid2"><div class="field"><label for="order">${esc(t('order'))}</label><input type="number" name="order" id="order" value="${record.order}"></div><div class="field"><label for="elevation">${esc(t('elevation'))}</label><input type="number" name="elevation" id="elevation" step="any" value="${record.elevation}"></div></div>`:`<div class="field"><label for="ex-name">${esc(t('name'))}</label><input id="ex-name" name="name" maxlength="200" value="${esc(record.name)}"></div><div class="field"><label for="ex-location">${esc(t('location'))}</label><input id="ex-location" name="location" value="${esc(record.location)}"></div><div class="field"><label for="ex-floor">${esc(t('floor'))}</label><select name="floorId" id="ex-floor">${options(data().floors.map(f=>[f.id,f.names[lang()]]),record.floorId)}</select></div>${isNew?`<div class="field"><label for="initial-status">${esc(t('status'))}</label><select name="status" id="initial-status">${statusOptions(record.status)}</select></div>`:''}`}
 <div class="field"><label for="model-choice">${esc(t('model'))}</label><select id="model-choice" name="modelId">${modelOptions}</select></div>
 ${!isFloor?`<label class="check"><input type="checkbox" name="placed" ${record.placed?'checked':''}>${esc(t('placed'))}</label>`:''}
 ${['position','rotation','scale'].map(key=>`<div class="vector"><h3>${esc(t(key))}</h3><div class="grid3">${['X','Y','Z'].map((axis,i)=>`<div><label for="${key}-${i}">${axis}</label><input type="number" step="any" data-vector="${key}" data-axis="${i}" id="${key}-${i}" value="${Number(transform[key][i].toFixed(4))}"></div>`).join('')}</div></div>`).join('')}
 <label class="check"><input type="checkbox" id="locked" checked>${esc(t('lockProportions'))}</label><div class="vector"><h3>${esc(t('dimensions'))}</h3><div class="grid3">${['X','Y','Z'].map((axis,i)=>`<div><label for="dim-${i}">${axis}</label><input type="number" step="any" min="0.001" data-dimension="${i}" id="dim-${i}"></div>`).join('')}</div><p class="small muted">${esc(t('dimensionHint'))}</p></div>
 <div class="row">${button('resetTransform','resetFormTransform')}${!isFloor&&!isNew?button('deleteExhibit','deleteCurrent','danger'):''}</div>${!isFloor&&!isNew?`<p class="small muted" style="margin-top:10px">${esc(t('deleteHint'))}</p>`:''}${footer('apply')}`,
        async form => {
            new MapPlacement(transform);
            record.transform = transform;
            record.modelId = form.get('modelId') || null;
            if (isFloor) {
                record.names = {
                    de: String(form.get('nameDe')).trim(),
                    en: String(form.get('nameEn')).trim()
                };
                if (!record.names.de || !record.names.en || !record.modelId) throw Error('invalidInput');
                record.order = Number(form.get('order'));
                record.elevation = Number(form.get('elevation'));
            } else {
                record.name = String(form.get('name')).trim();
                if (!record.name) throw Error('invalidInput');
                record.location = String(form.get('location')).trim();
                record.floorId = form.get('floorId');
                record.placed = form.has('placed');
                if (isNew) record.status = form.get('status');
            }
            edit.change(s => {
                const index = s[kind].findIndex(x => x.id === record.id);
                if (index < 0) s[kind].push(record);
                else s[kind][index] = record;
            });
            if (!isFloor) {
                selected = record.id;
                floorId = record.floorId;
            } else floorId = record.id;
            closeDialog();
            changed();
        });
    const syncDimensions = () => {
        const asset = data().assets.find(a => a.id === $('#model-choice').value);
        for (let i = 0; i < 3; i++) {
            const field = $('#dim-' + i);
            field.disabled = !asset || !asset.dimensions[i];
            field.value = asset ? Number((asset.dimensions[i] * transform.scale[i]).toFixed(4)) : '';
        }
    };
    const syncVectors = () => {
        for (const k of ['position', 'rotation', 'scale'])
            for (let i = 0; i < 3; i++) $('#' + k + '-' + i).value = Number(transform[k][i].toFixed(4));
        syncDimensions();
    };
    $('#locked').addEventListener('change', e => locked = e.target.checked);
    $('#model-choice').addEventListener('change', syncDimensions);
    document.querySelectorAll('[data-vector]').forEach(input => input.addEventListener('change', () => {
        const k = input.dataset.vector,
            i = Number(input.dataset.axis);
        let v = Number(input.value);
        if (snap && k === 'position') v = Math.round(v);
        if (snap && k === 'rotation') v = Math.round(v / 15) * 15;
        if (!Number.isFinite(v) || k === 'scale' && v <= 0) {
            input.value = transform[k][i];
            return;
        }
        if (k === 'scale' && locked) {
            const ratio = v / transform.scale[i];
            transform.scale = transform.scale.map(x => x * ratio);
        } else transform[k][i] = v;
        syncVectors();
    }));
    document.querySelectorAll('[data-dimension]').forEach(input => input.addEventListener('change', () => {
        try {
            const asset = data().assets.find(a => a.id === $('#model-choice').value);
            transform = new MapPlacement(transform).resize(asset.dimensions, Number(input.dataset.dimension), Number(input.value), locked).toJSON();
            syncVectors();
        } catch {
            syncVectors();
        }
    }));
    $('[data-action=resetFormTransform]').onclick = () => {
        transform = identity();
        syncVectors();
    };
    $('[data-action=deleteCurrent]')?.addEventListener('click', () => {
        edit.change(s => {
            s.exhibits = s.exhibits.filter(x => x.id !== record.id);
            s.trash.push({
                ...record,
                deleted: {
                    signature: '',
                    at: new Date().toISOString()
                }
            });
        });
        selected = data().exhibits.find(x => x.floorId === floorId)?.id || null;
        closeDialog();
        changed();
    });
    syncDimensions();
}

function saveExit() {
    if (!edit) return;
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

function trashDialog() {
    if (!edit) return;
    const rows = data().trash.map(e => {
        const attribution = e.deleted?.signature ? e.deleted.signature + ' · ' + date(e.deleted.at) : t('pending');
        return `<div class="row between">
            <div><strong>${esc(e.name)}</strong><p class="small muted">${esc(attribution)}</p></div>
            <button data-restore="${esc(e.id)}" type="button">${esc(t('restore'))}</button>
        </div>`;
    }).join('');
    showDialog('trash', rows ? '<div class="stack">' + rows + '</div>' : '<p class="muted">' + esc(t('emptyTrash')) + '</p>');
}

async function modelsDialog() {
    const rows = data().assets.map(asset => {
        const dimensions = asset.dimensions.map(n => new Intl.NumberFormat(lang(), { maximumFractionDigits: 2 }).format(n)).join(' × ');
        return `<div class="model-row">
            <div class="model-text"><strong>${esc(asset.name)}</strong><p>${esc(asset.id)} · ${dimensions} m</p><p>${esc(asset.source || 'GLB')}</p></div>
            <button type="button" data-preview-model="${esc(asset.id)}">${esc(t('preview'))}</button>
        </div>`;
    }).join('');
    showDialog('models', `
        <p class="muted small" style="margin-bottom:16px">${esc(t('modelHint'))}</p>
        <div class="model-grid">${rows}</div>
        <div class="field" style="margin-top:24px"><label for="model-file">${esc(t('uploadModel'))}</label><input type="file" name="model" id="model-file" accept=".glb,model/gltf-binary"></div>
        ${signatureField()}${footer('uploadModel')}`, async form => {
        const signature = requireSignature(form);
        const file = form.get('model');
        if (!file?.size) throw Error('invalidModel');
        if (file.size > 32 * 1024 * 1024) throw Error('fileTooLarge');
        const { inspectModel } = await import('./map.js');
        const dimensions = await inspectModel(file);
        await api.upload(file, 'model', signature, uid(), dimensions);
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
                    if (!old && state.trash.some(x => x.id === change.id)) throw Error('conflict');
                    const merged = { ...(old || desired), ...change.record };
                    const index = state[change.kind].findIndex(x => x.id === change.id);
                    if (index < 0) state[change.kind].push(merged);
                    else state[change.kind][index] = merged;
                } else if (change.op === 'delete') {
                    state.exhibits = state.exhibits.filter(e => e.id !== change.id);
                } else if (change.op === 'restore') {
                    const record = state.trash.find(e => e.id === change.id);
                    if (!record || state.exhibits.some(e => e.id === change.id)) throw Error('conflict');
                    state.exhibits.push(record);
                    state.trash = state.trash.filter(e => e.id !== change.id);
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

function recoverDraft() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('hub-edit') || 'null'); } catch {}
    if (!saved) return;
    showDialog('draftRecover', `<p>${esc(t('draft'))}</p><div class="dialog-footer">${button('discard', 'forgetEditDraft')}<button type="submit" class="primary">${esc(t('recover'))}</button></div>`, async () => {
        edit = new EditSession(saved.base);
        edit.value = saved.value;
        closeDialog();
        render();
    });
}

const actions = {
    refresh,
    enterEdit,
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
    notePreview: () => {
        drafts[selected].preview = !drafts[selected].preview;
        renderComposer();
    },
    noteConflict,
    status: statusDialog,
    addLink: () => linkDialog(),
    closeDialog,
    expand: () => {
        expanded = !expanded;
        document.body.classList.toggle('expanded', expanded);
        renderInspector();
        map?.resize();
    },
    clear: () => {
        query = '';
        floorFilter = '';
        statusFilter = '';
        scope = 'nameLocation';
        renderSidebar();
    },
    focus: async () => {
        if (!exhibit()?.placed) { announce(t('unplaced')); return; }
        if (!flat) { await ensureMap(); map?.focus(); }
        setView('map');
        renderFlat();
    },
    editExhibit: () => structureDialog('exhibits'),
    editFloor: () => structureDialog('floors'),
    newExhibit: () => structureDialog('exhibits', true),
    newFloor: () => structureDialog('floors', true),
    undo: () => { edit?.undo(); changed(); },
    redo: () => { edit?.redo(); changed(); },
    saveExit,
    trash: trashDialog,
    models: modelsDialog,
    discard: () => { edit = null; persistEdit(); closeDialog(); render(); },
    forgetEditDraft: () => { localStorage.removeItem('hub-edit'); closeDialog(); },
    structureConflict
};

document.addEventListener('click', async event => {
    const element = event.target.closest('button,[data-select]');
    if (!element) return;
    try {
        if (element.dataset.language) { setLanguage(element.dataset.language); render(); return; }
        if (element.dataset.select) { select(element.dataset.select); return; }
        if (element.dataset.tab) { tab = element.dataset.tab; renderInspector(); return; }
        if (element.dataset.correct) {
            const record = exhibit();
            if (drafts[record.id]?.body || drafts[record.id]?.images.length) {
                drafts[record.id].open = true;
                renderComposer();
                announce(t('draft'));
                return;
            }
            drafts[record.id] = newDraft(record, record.notes.find(n => n.id === element.dataset.correct));
            persistDrafts();
            renderComposer();
            return;
        }
        if (element.dataset.editLink) { linkDialog(element.dataset.editLink); return; }
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
        if (element.dataset.format) {
            const text = $('#note-body'), start = text.selectionStart, end = text.selectionEnd, value = text.value;
            const replacement = element.dataset.format === 'bold' ? '**' + value.slice(start, end) + '**' : '- ' + value.slice(start, end);
            drafts[selected].body = value.slice(0, start) + replacement + value.slice(end);
            persistDrafts(); renderComposer(); $('#note-body').focus(); return;
        }
        if (element.dataset.restore) {
            const id = element.dataset.restore;
            edit.change(state => {
                state.exhibits.push(state.trash.find(e => e.id === id));
                state.trash = state.trash.filter(e => e.id !== id);
            });
            closeDialog(); changed(); return;
        }
        if (element.dataset.previewModel) { await modelPreview(element.dataset.previewModel); return; }
        const action = element.dataset.action;
        if (action?.startsWith('view:')) { setView(action.split(':')[1]); return; }
        if (action?.startsWith('camera:')) {
            const command = action.split(':')[1];
            if (['iso', 'top', 'perspective'].includes(command)) mapMode = command;
            map?.command(command);
            renderMapUI();
            return;
        }
        if (actions[action]) await actions[action]();
    } catch (error) { announce(errorText(error)); }
});

document.addEventListener('keydown', event => {
    if (event.target.matches('[data-select]') && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        select(event.target.dataset.select);
    }
});

$('#dialog').addEventListener('cancel', () => { dialogCleanup?.(); dialogCleanup = null; });
const resizer = $('#resizer');
resizer.addEventListener('pointerdown', event => resizer.setPointerCapture(event.pointerId));
resizer.addEventListener('pointermove', event => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    const width = Math.min(innerWidth * .6, Math.max(320, innerWidth - event.clientX));
    document.documentElement.style.setProperty('--reader', width + 'px');
});
resizer.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const width = $('#inspector').clientWidth + (event.key === 'ArrowLeft' ? 24 : -24);
    document.documentElement.style.setProperty('--reader', Math.max(320, Math.min(innerWidth * .6, width)) + 'px');
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
    if (!snapshot.exhibits.some(e => e.id === selected)) selected = snapshot.exhibits[0]?.id || null;
    floorId = exhibit()?.floorId || snapshot.floors[0]?.id;
    render();
    if (!flat) ensureMap();
    recoverDraft();
} catch (error) {
    $('#sidebar').innerHTML = '<div class="error">' + esc(errorText(error)) + '</div>' + button('refresh', 'refresh');
}
