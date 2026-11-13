import test from 'node:test';
import assert from 'node:assert/strict';
import { InspectorNavigation } from '../../frontend/js/inspector-navigation.js';

const frames = new Map();
let serial = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.getComputedStyle = () => ({ paddingTop: '14px' });
function paint() {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback());
}

class Menu {
    open = true;
    isConnected = true;
    constructor(panel, dataset, offset, className = '', parent = null, cardOffset = null) {
        Object.assign(this, { panel, dataset, offset, className, parent, cardOffset });
    }
    hasAttribute(attribute) {
        const key = attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return Object.hasOwn(this.dataset, key);
    }
    contains(other) { return other === this || Boolean(other.parent && this.contains(other.parent)); }
    closest() {
        return this.cardOffset == null ? null : { getBoundingClientRect: () => ({ top: this.panel.top + this.cardOffset - this.panel.scrollTop }) };
    }
    getBoundingClientRect() { return { top: this.panel.top + this.offset - this.panel.scrollTop }; }
}

function setup({ multiple = false, nested = false, visible = true } = {}) {
    frames.clear();
    const panel = { scrollTop: 900, top: 100, visible,
        getBoundingClientRect() { return { top: this.top }; },
        getClientRects() { return this.visible ? [{}] : []; }
    };
    const menus = {};
    menus.whole = new Menu(panel, { exhibitPlacement: 'Alpha' }, 30, 'exhibit-transform');
    if (multiple) menus.shared = new Menu(panel, { selectionPlacement: '' }, 30, 'selection-transform');
    if (nested) menus.members = new Menu(panel, {}, 150, 'selection-members');
    menus.first = new Menu(panel, { hardwarePlacement: '0', exhibit: 'Alpha' }, 300, 'instance-placement', menus.members, 260);
    menus.second = new Menu(panel, { hardwarePlacement: '1', exhibit: 'Alpha' }, 600, 'instance-placement', menus.members, 560);
    menus.otherOwner = new Menu(panel, { hardwarePlacement: '0', exhibit: 'Beta' }, 800, 'instance-placement', menus.members, 760);
    menus.views = new Menu(panel, {}, 1000, 'view-presets');
    const inspector = {
        querySelector: () => panel,
        querySelectorAll: () => Object.values(menus)
    };
    const navigation = new InspectorNavigation(inspector);
    return { panel, menus, inspector, navigation };
}
const hardware = (...indices) => indices.map(instanceIndex => ({ exhibitId: 'Alpha', instanceIndex }));
const openMenus = menus => Object.keys(menus).filter(key => menus[key].open);

test('selecting hardware opens only its own sliders and scrolls its card within the inspector', () => {
    const { panel, menus, navigation } = setup();
    navigation.update(new Set(['Alpha']), hardware(1));
    assert.deepEqual(openMenus(menus), ['second']);
    assert.equal(panel.scrollTop, 546);
    paint(); assert.equal(panel.scrollTop, 546, 'the final alignment does not accumulate scroll');
});

test('an exhibit without a whole-placement menu opens its sole component directly', () => {
    const { panel, menus, navigation } = setup();
    delete menus.whole; delete menus.second;
    navigation.update(new Set(['Alpha']), []); paint();
    assert.deepEqual(openMenus(menus), ['first']); assert.equal(panel.scrollTop, 246);
});

test('multi-component and multi-exhibit selections open only the shared transform menu', () => {
    for (const [exhibits, entries] of [
        [new Set(['Alpha']), hardware(0, 1)],
        [new Set(['Alpha', 'Beta']), []],
        [new Set(['Alpha', 'Beta']), [...hardware(0), { exhibitId: 'Beta', instanceIndex: 0 }]]
    ]) {
        const { panel, menus, navigation } = setup({ multiple: true, nested: true });
        navigation.update(exhibits, entries); paint();
        assert.deepEqual(openMenus(menus), ['shared']);
        assert.equal(panel.scrollTop, 16);
    }
});

test('deselecting from multiple components reveals the remaining component rather than the clicked component', () => {
    const { menus, navigation } = setup({ multiple: true });
    navigation.update(new Set(['Alpha']), hardware(0, 1)); paint();
    navigation.update(new Set(['Alpha']), hardware(1)); paint();
    assert.deepEqual(openMenus(menus), ['second']);
    navigation.update(new Set(['Alpha']), []); paint();
    assert.deepEqual(openMenus(menus), ['whole'], 'whole-exhibit selection returns to its placement menu');
});

test('reselecting the same component restores its menu and collapses manually opened alternatives', () => {
    const { panel, menus, navigation } = setup();
    navigation.update(new Set(['Alpha']), hardware(0)); paint();
    menus.first.open = false; menus.views.open = true; menus.whole.open = true;
    panel.scrollTop = 999;
    navigation.update(new Set(['Alpha']), hardware(0), { focus: true }); paint();
    assert.deepEqual(openMenus(menus), ['first']);
    assert.equal(panel.scrollTop, 246);
});

test('ordinary rebuilds preserve manually opened menus and scroll while the selection stays unchanged', () => {
    const { panel, menus, navigation } = setup();
    navigation.update(new Set(['Alpha']), hardware(0)); paint();
    menus.first.open = false; menus.views.open = true; panel.scrollTop = 720;
    const previous = navigation.capture();
    Object.values(menus).forEach(menu => { menu.open = !menu.open; }); panel.scrollTop = 0;
    navigation.update(new Set(['Alpha']), hardware(0), { previous });
    assert.deepEqual(openMenus(menus), ['views']); assert.equal(panel.scrollTop, 720);
    assert.equal(frames.size, 0);
});

test('a nested target opens its containing disclosure and keeps unrelated menus closed', () => {
    const { menus, navigation } = setup({ nested: true });
    navigation.update(new Set(['Alpha']), hardware(0)); paint();
    assert.deepEqual(openMenus(menus), ['members', 'first']);
});

test('a hidden mobile inspector waits for visibility and aligns after control enhancement', () => {
    const { panel, menus, navigation } = setup({ visible: false });
    navigation.update(new Set(['Alpha']), hardware(1));
    assert.deepEqual(openMenus(menus), ['second']); assert.equal(panel.scrollTop, 900);
    assert.equal(frames.size, 0);
    panel.visible = true; navigation.reveal();
    assert.equal(panel.scrollTop, 546);
    menus.second.cardOffset += 18; paint();
    assert.equal(panel.scrollTop, 564, 'the final alignment includes the enhanced controls');
    assert.equal(navigation.pending, null);
});

test('rapid selection changes and leaving edit mode cancel obsolete deferred scrolling', () => {
    const { panel, menus, navigation } = setup();
    navigation.update(new Set(['Alpha']), hardware(0));
    navigation.update(new Set(['Alpha']), hardware(1)); paint();
    assert.deepEqual(openMenus(menus), ['second']); assert.equal(panel.scrollTop, 546);
    navigation.update(new Set(['Alpha']), hardware(0)); navigation.reset();
    panel.scrollTop = 67; paint();
    assert.equal(panel.scrollTop, 67); assert.equal(navigation.selection, null);
});

test('manually closing the selected menu cancels its pending alignment without reopening it', () => {
    const { panel, menus, navigation } = setup();
    navigation.update(new Set(['Alpha']), hardware(0));
    menus.first.open = false; panel.scrollTop = 90; paint();
    assert.equal(panel.scrollTop, 90); assert.equal(navigation.pending, null);
    const previous = navigation.capture();
    navigation.update(new Set(['Alpha']), hardware(0), { previous });
    assert.deepEqual(openMenus(menus), []);
});
