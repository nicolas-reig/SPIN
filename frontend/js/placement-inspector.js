import { escape as esc } from './markdown.js';
import { t } from './locale.js';
import { vectorFields, editHelp } from './edit.js';
import { icon } from './icons.js';

export function hardwareParameters(record, instanceIndex, assets, scope, { selected = true, expanded = selected, editable = false } = {}) {
    const instance = record.models[instanceIndex];
    const asset = assets.find(asset => asset.id === instance.model);
    const label = (asset?.name || instance.model) + (record.models.filter(item => item.model === instance.model).length > 1 ? ` ${instanceIndex + 1}` : '');
    return `<article class="model-instance ${selected ? 'active' : ''}" data-hardware-card="${instanceIndex}" data-exhibit="${esc(record.id)}">
        <div class="instance-header"><button type="button" class="quiet instance-name" data-edit-instance="${instanceIndex}" data-exhibit="${esc(record.id)}" aria-pressed="${selected}" ${editHelp('selectHardwareHint')}>${esc(label)}</button>
        ${editable ? `<div class="item-actions"><button type="button" class="icon-button" data-duplicate-instance="${instanceIndex}" aria-label="${esc(t('duplicate') + ': ' + label)}" ${editHelp('duplicateHardwareHint')}>${icon('copy-plus')}</button><button type="button" class="icon-button danger" data-remove-instance="${instanceIndex}" aria-label="${esc(t('remove') + ': ' + label)}" ${editHelp('removeHardwareHint')}>${icon('trash')}</button></div>` : ''}</div>
        <details class="instance-placement" data-hardware-placement="${instanceIndex}" data-exhibit="${esc(record.id)}" ${expanded ? 'open' : ''}><summary ${editHelp('instancePlacementHint')}>${esc(t('hardwarePlacement'))}</summary>
            <p class="small muted placement-context">${esc(t('relativeToExhibit'))} ${esc(record.name)}</p>
            ${editable ? `<label class="sr-only" for="instance-model-${instanceIndex}">${esc(t('model'))}</label><select id="instance-model-${instanceIndex}" data-instance-model="${instanceIndex}" ${editHelp('replaceHardwareHint')}>${assets.filter(item => item.kind === 'hardware').map(item => `<option value="${esc(item.id)}" ${item.id === instance.model ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>` : ''}
            ${vectorFields(instance.transform, `data-instance="${instanceIndex}" data-exhibit="${esc(record.id)}"`, scope)}
        </details></article>`;
}

export function exhibitParameters(record, scope, { active = false, showName = false, hardware = false, assets = [] } = {}) {
    return `<details class="exhibit-transform ${active ? 'active' : ''}" data-exhibit-placement="${esc(record.id)}" ${active ? 'open' : ''}>
        <summary>${esc(showName ? record.name : t('exhibitTransform'))}</summary>
        <p class="small muted placement-context">${esc(t('wholeExhibitHint'))}</p>
        ${vectorFields(record.transform, `data-group-vector data-exhibit="${esc(record.id)}"`, scope, { group: true })}
        ${hardware && record.models.length ? `<div class="exhibit-hardware-choices"><span class="small muted">${esc(t('modelInstances'))}</span>${record.models.map((instance, index) => `<button type="button" class="quiet" data-edit-instance="${index}" data-exhibit="${esc(record.id)}" aria-pressed="false" ${editHelp('selectHardwareHint')}>${esc(assets.find(asset => asset.id === instance.model)?.name || instance.model)} ${index + 1}</button>`).join('')}</div>` : ''}
    </details>`;
}
