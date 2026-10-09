export const cameraMode = mode => mode === 'top' ? 'top' : 'perspective';
export const viewKey = mode => cameraMode(mode) === 'top' ? '2D' : '3D';
export const viewMode = key => key === '2D' ? 'top' : 'perspective';

export function cameraOffset(mode, distance) {
    if (mode === 'top') return [0, distance, .00001];
    const direction = [.65, .75, 1];
    const length = Math.hypot(...direction);
    return direction.map(value => value * distance / length);
}

export const normalizeHeading = degrees => ((degrees % 360) + 360) % 360;

export function orbitState(position, target) {
    const [x, y, z] = position.map((value, index) => value - target[index]);
    return {
        heading: normalizeHeading(-Math.atan2(x, z) * 180 / Math.PI),
        elevation: Math.max(0, Math.min(90, Math.atan2(y, Math.hypot(x, z)) * 180 / Math.PI)),
        distance: Math.hypot(x, y, z)
    };
}

export function orbitOffset(distance, heading, elevation) {
    const theta = -heading * Math.PI / 180;
    const phi = Math.max(.000001, (90 - Math.max(0, Math.min(90, elevation))) * Math.PI / 180);
    const horizontal = distance * Math.sin(phi);
    return [horizontal * Math.sin(theta), distance * Math.cos(phi), horizontal * Math.cos(theta)];
}

export function cardinalDirection(heading) {
    return ['north', 'east', 'south', 'west'][Math.round(normalizeHeading(heading) / 90) % 4];
}

export function navigationGesture(button, shift, mode) {
    const orbit = button === 0 ? shift : !shift;
    return {
        action: orbit ? 'orbit' : 'pan',
        leaveTop: mode === 'top' && orbit && button !== 2
    };
}
