export function cameraOffset(mode, distance) {
    if (mode === 'top') return [0, distance, .00001];
    const direction = mode === 'iso' ? [.65, .8, 1] : [.65, .75, 1];
    const length = Math.hypot(...direction);
    return direction.map(value => value * distance / length);
}
