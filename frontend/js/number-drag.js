// Click to type as usual; a horizontal drag previews without changing history.
export function installNumberDrag(root, { start, preview, commit, cancel }) {
    const abort = new AbortController();
    let pending = null, suppressClick = false;
    const listen = (target, type, callback) => target.addEventListener(type, callback, { signal: abort.signal });
    const finish = accept => {
        if (!pending) return;
        const drag = pending; pending = null;
        if (drag.started) {
            accept ? commit(drag) : cancel(drag);
            if (drag.input.hasPointerCapture(drag.pointerId)) drag.input.releasePointerCapture(drag.pointerId);
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 0);
        }
        document.body.classList.remove('dragging-number');
    };
    listen(root, 'pointerdown', event => {
        const input = event.target.closest('input[data-vector]') || event.target.closest('label[data-number-drag]')?.control;
        if (!input || event.button !== 0) return;
        pending = { input, x: event.clientX, lastX: event.clientX, delta: 0, pointerId: event.pointerId, started: false };
    });
    listen(window, 'pointermove', event => {
        const drag = pending;
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!drag.started && Math.abs(event.clientX - drag.x) < 4) return;
        if (!drag.started) {
            drag.started = true;
            if (start(drag) === false) { pending = null; return; }
            drag.input.setPointerCapture(event.pointerId);
            document.body.classList.add('dragging-number');
            drag.input.blur();
        }
        event.preventDefault(); getSelection()?.removeAllRanges();
        const step = { position: .01, rotation: .5, scale: .01 }[drag.input.dataset.vector];
        drag.delta += (event.clientX - drag.lastX) * step * (event.shiftKey ? .1 : 1);
        drag.lastX = event.clientX;
        preview(drag, event);
    });
    listen(window, 'pointerup', event => { if (pending?.pointerId === event.pointerId) finish(true); });
    listen(window, 'pointercancel', () => finish(false));
    listen(root, 'lostpointercapture', () => { if (pending?.started) finish(false); });
    listen(window, 'blur', () => finish(false));
    listen(document, 'keydown', event => {
        if (event.key === 'Escape' && pending?.started) { event.preventDefault(); event.stopImmediatePropagation(); finish(false); }
    });
    // Suppress the click produced at the end of a scrub, retaining normal clicks.
    root.addEventListener('click', event => {
        if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, { capture: true, signal: abort.signal });
    const dispose = () => { finish(false); abort.abort(); };
    dispose.cancel = () => finish(false);
    return dispose;
}
