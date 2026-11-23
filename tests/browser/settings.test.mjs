import assert from 'node:assert/strict';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { syntheticInstallation } from '../fixtures/synthetic-installation.mjs';
import { installTransport, TEST_ORIGIN } from '../visual/transport.mjs';

test('sidebar settings enable map overlays and reset client data', { timeout: 120000 }, async t => {
    const installation = await syntheticInstallation();
    t.after(() => installation.cleanup());
    const floor = installation.fixture.home_floor;
    const [first, second] = installation.fixture.exhibits.filter(exhibit => exhibit.floor_id === floor);
    const groupedName = exhibit => 'Gallery-' + exhibit.id;
    for (const exhibit of [first, second]) {
        const parent = path.join(installation.root, 'Exponate');
        await rename(path.join(parent, exhibit.id), path.join(parent, groupedName(exhibit)));
    }
    const browser = await chromium.launch({
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
    });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const audit = { requests: [], blockedWrites: [], errors: [] };
    await installTransport(context, installation.app, audit);
    let resetRequests = 0;
    await context.route('**/clear-browser-data.php', async route => {
        assert.equal(route.request().method(), 'POST');
        assert.equal(route.request().headers()['x-hub-request'], '1');
        resetRequests++;
        await route.fulfill({ status: 204, headers: { 'Clear-Site-Data': '"cache", "cookies", "storage"' } });
    });
    await context.addInitScript(() => localStorage.setItem('hub-language', 'en'));
    const page = await context.newPage();
    const openSettings = async () => {
        await page.locator('.app-menu summary').click();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
    };
    const circleSwitch = page.getByRole('switch', { name: 'Top Circle' });
    const labelSwitch = page.getByRole('switch', { name: 'Group labels' });
    await page.goto(`${TEST_ORIGIN}/index.html?webgl=1&floor=${floor}`);
    await openSettings();
    assert.equal(await page.locator('.palette-option').count(), 5);
    assert.equal(await circleSwitch.getAttribute('aria-checked'), 'false');
    assert.equal(await labelSwitch.getAttribute('aria-checked'), 'false');
    await circleSwitch.press('Space');
    await labelSwitch.click();
    await page.getByRole('link', { name: 'Back to map' }).click();
    assert.equal(new URL(page.url()).searchParams.get('floor'), floor);

    const circle = page.locator('[data-map-circle=' + JSON.stringify(groupedName(first)) + ']');
    const label = page.locator('[data-map-group=gallery]');
    await circle.waitFor();
    assert.equal(await label.textContent(), 'Gallery');
    const { x, y, width, height } = await circle.boundingBox();
    assert.ok(width >= 44 && height >= 44);
    await page.mouse.click(x + width / 2, y + height / 2);
    assert.equal(await page.locator('[data-select=' + JSON.stringify(groupedName(first)) + ']').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-camera-command=perspective]').click();
    await circle.waitFor({ state: 'hidden' });
    await label.waitFor({ state: 'attached' });

    await openSettings();
    assert.equal(await circleSwitch.getAttribute('aria-checked'), 'true');
    assert.equal(await labelSwitch.getAttribute('aria-checked'), 'true');
    await page.evaluate(async () => {
        document.cookie = 'spin-reset-test=1; Path=/';
        sessionStorage.setItem('spin-reset-test', 'draft');
        await caches.open('spin-reset-test');
    });
    await page.getByRole('button', { name: 'Clear browser data', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(resetRequests, 0);
    await page.getByRole('button', { name: 'Clear browser data', exact: true }).click();
    await dialog.getByRole('button', { name: 'Clear browser data', exact: true }).click();
    await page.locator('.settings-reset-status').waitFor();
    assert.equal(resetRequests, 1);
    assert.equal(await circleSwitch.getAttribute('aria-checked'), 'false');
    assert.equal(await labelSwitch.getAttribute('aria-checked'), 'false');
    assert.deepEqual(await page.evaluate(async () => ({
        cookie: document.cookie, session: sessionStorage.getItem('spin-reset-test'), cache: await caches.has('spin-reset-test')
    })), { cookie: '', session: null, cache: false });
    assert.deepEqual(audit.errors, []);
    assert.deepEqual(audit.blockedWrites, []);
});
