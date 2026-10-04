import { icon } from './icons.js';
import { escape as esc } from './markdown.js';
import { t } from './locale.js';
import { cardinalDirection, normalizeHeading } from './camera.js';

export class CameraControls {
    constructor(host, { getView, id, mode = 'top', focus = null, canFocus = () => true, extras = '' }) {
        this.host = host;
        this.getView = getView;
        this.canFocus = canFocus;
        this.mode = mode;
        this.controller = new AbortController();
        const button = (command, label, name) => `<button type="button" class="icon-button" data-camera-command="${command}" aria-label="${esc(t(label))}" title="${esc(t(label))}">${icon(name)}</button>`;
        host.innerHTML = `<div class="map-toolbar camera-toolbar" role="group" aria-label="${esc(t('keyboardMap'))}">
            <div class="camera-primary">
                <div class="view-toggle" role="group" aria-label="${esc(t('cameraView'))}">
                    ${[['top', 'view2D', 'camera2DHint'], ['perspective', 'view3D', 'camera3DHint']].map(([mode, label, hint]) => `<button type="button" class="view-button" data-camera-command="${mode}" aria-label="${esc(t(label))}" title="${esc(t(hint))}" aria-pressed="false">${esc(t(label))}</button>`).join('')}
                </div>
                ${button('zoomOut', 'zoomOut', 'minus')}${button('zoomIn', 'zoomIn', 'plus')}
                <span class="toolbar-divider" aria-hidden="true"></span>
                ${button(focus ? 'focus' : 'fit', focus ? 'focus' : 'fitModel', focus ? 'crosshair' : 'maximize')}
            </div>
            ${extras}
        </div>
        <div class="camera-orbit" role="group" aria-label="${esc(t('orbitControls'))}">
            <div class="elevation-control">
                <label class="sr-only" for="${id}-elevation">${esc(t('orbitElevation'))}</label>
                <input id="${id}-elevation" type="range" min="0" max="90" step="1" value="90" aria-orientation="vertical" title="${esc(t('elevationHint'))}">
            </div>
            <div class="compass-control">
                <button type="button" class="compass-step compass-left" data-camera-command="turnLeft" aria-label="${esc(t('turnLeft'))}" title="${esc(t('turnLeft'))}">
                    <svg viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="44" cy="44" r="36" stroke-dasharray="30.159 226.195" transform="rotate(207 44 44)"/><path d="M10.8 22.6 L11.924 27.656 L17.1 25.4"/></svg>
                </button>
                <button type="button" class="compass-step compass-right" data-camera-command="turnRight" aria-label="${esc(t('turnRight'))}" title="${esc(t('turnRight'))}">
                    <svg viewBox="44 0 44 44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="44" cy="44" r="36" stroke-dasharray="30.159 226.195" transform="rotate(285 44 44)"/><path d="M77.2 22.6 L76.076 27.656 L70.9 25.4"/></svg>
                </button>
                <button type="button" class="compass-face" data-camera-command="north" aria-label="${esc(t('northUp'))}" title="${esc(t('compassHint'))}">
                    <span class="compass-rose" aria-hidden="true">
                        ${Array.from({ length: 12 }, (_, index) => `<i class="compass-tick" style="--tick:${index * 30}deg"></i>`).join('')}
                        ${['north', 'east', 'south', 'west'].map(direction => `<i class="compass-point compass-${direction}"></i>`).join('')}
                    </span>
                    <span class="compass-letter" aria-hidden="true">N</span>
                </button>
            </div>
        </div>`;
        this.face = host.querySelector('.compass-face');
        this.rose = host.querySelector('.compass-rose');
        this.letter = host.querySelector('.compass-letter');
        this.slider = host.querySelector('input[type=range]');
        const options = { signal: this.controller.signal };
        host.addEventListener('click', event => {
            const button = event.target.closest('[data-camera-command]');
            if (!button) return;
            if (button === this.face && this.dragged) { this.dragged = false; return; }
            const command = button.dataset.cameraCommand;
            if (command === this.getView()?.mode) return;
            if (command === 'focus') focus?.();
            else this.getView()?.command(command);
            this.update();
        }, options);
        this.slider.addEventListener('input', () => {
            this.getView()?.setElevation(Number(this.slider.value));
            this.update();
        }, options);
        this.face.addEventListener('keydown', event => {
            const command = { ArrowLeft: 'turnLeft', ArrowRight: 'turnRight', Home: 'north' }[event.key];
            if (!command) return;
            event.preventDefault();
            this.getView()?.command(command);
            this.update();
        }, options);
        this.face.addEventListener('pointerdown', event => {
            if (event.button !== 0 || !this.getView()) return;
            const rect = this.face.getBoundingClientRect();
            this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
                centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2,
                heading: this.getView().navigationState().heading };
            this.drag.angle = Math.atan2(event.clientX - this.drag.centerX, this.drag.centerY - event.clientY);
            this.drag.circular = Math.hypot(event.clientX - this.drag.centerX, event.clientY - this.drag.centerY) >= 12;
            this.dragged = false;
            this.face.setPointerCapture(event.pointerId);
        }, options);
        this.face.addEventListener('pointermove', event => {
            if (!this.drag || event.pointerId !== this.drag.id) return;
            if (Math.hypot(event.clientX - this.drag.x, event.clientY - this.drag.y) < 4 && !this.dragged) return;
            this.dragged = true;
            this.face.classList.add('dragging');
            const angle = Math.atan2(event.clientX - this.drag.centerX, this.drag.centerY - event.clientY);
            const delta = this.drag.circular ? Math.atan2(Math.sin(angle - this.drag.angle), Math.cos(angle - this.drag.angle)) * 180 / Math.PI : (event.clientX - this.drag.x) * 2;
            this.getView()?.setHeading(normalizeHeading(this.drag.heading - delta));
            this.update();
        }, options);
        const endDrag = () => { this.drag = null; this.face.classList.remove('dragging'); };
        this.face.addEventListener('pointerup', endDrag, options);
        this.face.addEventListener('pointercancel', () => { endDrag(); this.dragged = false; }, options);
        this.face.addEventListener('lostpointercapture', endDrag, options);
        this.update();
    }

    update() {
        if (this.controller.signal.aborted) return;
        const view = this.getView();
        const state = view?.navigationState() || { heading: 0, elevation: this.mode === 'top' ? 90 : 35, mode: this.mode };
        const degrees = Math.round(state.elevation);
        const direction = t(cardinalDirection(state.heading));
        this.host.querySelectorAll('[data-camera-command]').forEach(button => {
            const command = button.dataset.cameraCommand;
            button.disabled = !view || (command === 'focus' && !this.canFocus());
            if (['top', 'perspective'].includes(command)) button.setAttribute('aria-pressed', command === state.mode);
        });
        this.rose.style.transform = `rotate(${-state.heading}deg)`;
        this.letter.textContent = direction;
        this.face.setAttribute('aria-label', t('facing') + ' ' + direction + ' · ' + t('northUp'));
        this.slider.disabled = !view;
        this.slider.value = degrees;
        this.slider.setAttribute('aria-valuetext', degrees + '° · ' + t(degrees === 90 ? 'topDownAngle' : degrees === 0 ? 'parallelFloor' : 'aboveFloor'));
    }

    destroy() {
        this.controller.abort();
    }
}
