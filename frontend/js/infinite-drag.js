let owner = null;
const wrap = (value, span) => ((value % span) + span) % span;

export function startInfiniteDrag(target, initial, onLost, { slider = false } = {}) {
    if (owner || document.pointerLockElement || !target.requestPointerLock || !document.exitPointerLock) return null;
    const events = new AbortController();
    let { x, y } = initial;
    let cursor, stopped = false;
    const paint = () => {
        x = wrap(x, Math.max(1, window.innerWidth));
        y = wrap(y, Math.max(1, window.innerHeight));
        if (cursor) cursor.style.translate = `${x}px ${y}px`;
    };

    const drag = {
        get locked() { return !stopped && document.pointerLockElement === target; },
        sync(point) { ({ x, y } = point); },
        move(dx, dy) { x += dx; y += dy; paint(); return { x, y }; },
        stop() {
            stopped = true;
            cursor?.remove();
            if (document.pointerLockElement === target) document.exitPointerLock();
        }
    };
    owner = drag;
    const cleanup = () => {
        cursor?.remove();
        events.abort();
        if (owner === drag) owner = null;
    };
    const options = { signal: events.signal };
    document.addEventListener('pointerlockchange', () => {
        if (document.pointerLockElement !== target) {
            const interrupted = cursor && !stopped;
            cleanup();
            if (interrupted) onLost();
            return;
        }
        // A click, release or Escape can finish the action before acquisition.
        if (stopped) { document.exitPointerLock(); return; }
        if (!cursor) {
            cursor = document.createElement('div');
            cursor.className = slider ? 'wrapped-drag-cursor wrapped-drag-cursor--slider' : 'wrapped-drag-cursor';
            cursor.setAttribute('aria-hidden', 'true');
            document.body.append(cursor);
        }
        paint();
    }, options);
    document.addEventListener('pointerlockerror', cleanup, options);
    window.addEventListener('resize', paint, options);
    try { target.requestPointerLock()?.catch(cleanup); }
    catch { cleanup(); }
    return owner === drag ? drag : null;
}
