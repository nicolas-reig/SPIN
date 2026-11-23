import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { aimCamera, limitCameraHeight } from './camera-framing.js';

export class MapOrbitControls extends OrbitControls {
    constructor(camera, element) {
        super(camera, element);
        this.addEventListener('change', () => this.limitHeight());
        this.limitHeight();
    }

    limitHeight() {
        const position = this.object.position;
        if (position.y >= 0) return;
        // Keep the viewing angle when a pan reaches the ground.
        const lift = Math.min(-position.y, Math.max(0, this.targetYBeforeUpdate - this.target.y));
        this.target.y += lift;
        position.y += lift;
        limitCameraHeight(position, this.target);
        aimCamera(this.object, this.target);
    }

    update(deltaTime) {
        // Small updates can fall below OrbitControls' change-event threshold.
        this.targetYBeforeUpdate = this.target.y;
        const changed = super.update(deltaTime);
        if (!changed) this.limitHeight();
        return changed;
    }
}
