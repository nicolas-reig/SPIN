import { startInfiniteDrag } from './infinite-drag.js';

export function updateNumberFill(input) {
    const field = input.closest('.axis-value');
    if (!field) return;
    // Visual soft ranges keep ordinary placements legible without changing the
    // existing editable limits. Zero sits in the middle for signed values.
    const radius = input.dataset.vector === 'position' ? input.hasAttribute('data-selection-delta') ? 10 : 100 :
        input.dataset.vector === 'rotation' ? 180 : 2;
    const value = input.value === '' ? NaN : Number(input.value);
    // An unfinished sign or decimal has no numeric value yet. Keep the last
    // fill while typing rather than flashing the track back to empty.
    if (!Number.isFinite(value) && input.matches(':focus')) return;
    const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, (value + radius) / (2 * radius) * 100)) : 0;
    const fill = Number(percent.toFixed(4)) + '%';
    if (field.style.getPropertyValue('--number-fill') !== fill) field.style.setProperty('--number-fill', fill);
}

export function updateNumberFills(root) {
    root?.querySelectorAll('input[data-vector]').forEach(updateNumberFill);
}

// Click to type as usual; a horizontal drag previews without changing history.
export function installNumberDrag(root, { start, preview, commit, cancel }) {
    const abort = new AbortController();
    let pending = null, suppressClick = false;
    const listen = (target, type, callback) => target.addEventListener(type, callback, { signal: abort.signal });
    const fills = new MutationObserver(() => updateNumberFills(root));
    fills.observe(root, { childList: true, subtree: true });
    updateNumberFills(root);
    for (const type of ['input', 'change']) listen(root, type, event => {
        if (event.target.matches('input[data-vector]')) updateNumberFill(event.target);
    });
    const finish = accept => {
        if (!pending) return;
        const drag = pending; pending = null;
        if (drag.started) {
            drag.lock?.stop();
            accept ? commit(drag) : cancel(drag);
            if (drag.input.hasPointerCapture(drag.pointerId)) drag.input.releasePointerCapture(drag.pointerId);
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 0);
        }
        document.body.classList.remove('dragging-number');
        updateNumberFills(root);
    };
    listen(root, 'pointerdown', event => {
        const input = event.target.closest('input[data-vector]') || event.target.closest('label[data-number-drag]')?.control;
        if (!input || input.disabled || input.readOnly || event.button !== 0) return;
        if (pending) return;
        pending = { input, x: event.clientX, lastX: event.clientX, delta: 0,
            pointerId: event.pointerId, mouse: event.pointerType === 'mouse', started: false };
    });
    const scrub = (drag, event, pixels) => {
        event.preventDefault(); getSelection()?.removeAllRanges();
        const step = { position: .01, rotation: .5, scale: .01 }[drag.input.dataset.vector];
        drag.delta += pixels * step * (event.shiftKey ? .1 : 1);
        preview(drag, event);
        updateNumberFills(root);
    };
    listen(window, 'pointermove', event => {
        const drag = pending;
        if (!drag || event.pointerId !== drag.pointerId || drag.lock?.locked) return;
        if (!drag.started && Math.abs(event.clientX - drag.x) < 4) return;
        if (!drag.started) {
            // Blur commits any typed edit before the drag captures its baseline.
            drag.input.blur();
            if (pending !== drag) return;
            if (!drag.input.isConnected) { pending = null; return; }
            drag.started = true;
            if (start(drag) === false) { pending = null; return; }
            drag.input.setPointerCapture(event.pointerId);
            document.body.classList.add('dragging-number');
            if (drag.mouse) drag.lock = startInfiniteDrag(root, { x: event.clientX, y: event.clientY }, () => finish(false), { slider: true });
        }
        drag.lock?.sync({ x: event.clientX, y: event.clientY });
        const pixels = event.clientX - drag.lastX;
        drag.lastX = event.clientX;
        scrub(drag, event, pixels);
    });
    listen(window, 'mousemove', event => {
        const drag = pending;
        if (!drag?.lock?.locked) return;
        drag.lock.move(event.movementX, event.movementY);
        scrub(drag, event, event.movementX);
    });
    listen(window, 'pointerup', event => { if (pending?.pointerId === event.pointerId) finish(true); });
    listen(window, 'mouseup', event => { if (pending?.lock?.locked && event.button === 0) finish(true); });
    listen(window, 'pointercancel', event => { if (pending?.pointerId === event.pointerId) finish(false); });
    listen(root, 'lostpointercapture', event => {
        if (pending?.started && pending.pointerId === event.pointerId && !pending.lock?.locked) finish(false);
    });
    listen(window, 'blur', () => finish(false));
    listen(document, 'keydown', event => {
        if (event.key === 'Escape' && pending?.started) { event.preventDefault(); event.stopImmediatePropagation(); finish(false); }
    });
    // Suppress the click produced at the end of a scrub, retaining normal clicks.
    root.addEventListener('click', event => {
        if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, { capture: true, signal: abort.signal });
    const dispose = () => { finish(false); abort.abort(); fills.disconnect(); };
    dispose.cancel = () => finish(false);
    return dispose;
}
