export const cameraMode = mode => mode === 'top' ? 'top' : 'perspective';

export function cameraOffset(mode, distance) {
    if (mode === 'top') return [0, distance, .00001];
    const direction = [.65, .75, 1];
    const length = Math.hypot(...direction);
    return direction.map(value => value * distance / length);
}

export function navigationGesture(button, shift, mode) {
    const orbit = button === 0 ? shift : !shift;
    return {
        action: orbit ? 'orbit' : 'pan',
        leaveTop: mode === 'top' && orbit && button !== 2
    };
}
