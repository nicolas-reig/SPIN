import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { syntheticInstallation } from '../fixtures/synthetic-installation.mjs';
import { installTransport, TEST_ORIGIN } from '../visual/transport.mjs';

const output = new URL('./artifacts/', import.meta.url);
let installation, browser;

before(async () => {
    await mkdir(output, { recursive: true });
    installation = await syntheticInstallation();
    browser = await chromium.launch({
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-color-profile=srgb'],
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
    });
});

after(async () => {
    await browser?.close();
    await installation?.cleanup();
});

for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }]
]) {
    test(`${name}: generated models, selection, filtering and accessibility load`, { timeout: 120000 }, async () => {
        const audit = { requests: [], blockedWrites: [], errors: [] };
        const errors = [];
        const context = await browser.newContext({ viewport, locale: 'en-GB', reducedMotion: 'reduce' });
        await installTransport(context, installation.app, audit);
        await context.addInitScript(() => localStorage.setItem('hub-language', 'en'));
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        try {
            await page.goto(`${TEST_ORIGIN}/index.html?webgl=1&floor=${installation.fixture.home_floor}`);
            await page.locator('[data-select]').first().waitFor();
            if (name === 'mobile') await page.locator('[data-action="view:map"]').click();
            await page.waitForFunction(() => {
                const canvas = document.querySelector('#map-canvas canvas');
                return canvas?.dataset.cameraOffset && document.querySelector('#map-message').textContent === '';
            }, null, { timeout: 60000 });
            const canvas = page.locator('#map-canvas canvas');
            assert.equal(await canvas.getAttribute('data-renderer'), 'webgl2');
            assert.equal(await canvas.getAttribute('data-view'), 'top');
            assert((await canvas.getAttribute('data-camera-offset')).split(',').map(Number).every(Number.isFinite));
            await page.screenshot({ path: new URL(name + '-map.png', output).pathname });
            await page.locator('[data-camera-command="perspective"]').click();
            await page.waitForFunction(() => document.querySelector('#map-canvas canvas')?.dataset.view === 'perspective');
            assert.equal(await canvas.getAttribute('data-projection'), 'perspective');
            if (name === 'mobile') await page.locator('[data-action="view:list"]').click();
            const exhibit = installation.fixture.exhibits.find(row => row.floor_id === installation.fixture.home_floor);
            await page.locator('[data-select=' + JSON.stringify(exhibit.id) + ']').click();
            assert.equal(await page.locator('[data-select=' + JSON.stringify(exhibit.id) + ']').getAttribute('aria-pressed'), 'true');
            if (name === 'mobile') await page.locator('[data-action="view:list"]').click();
            await page.locator('#search').fill('no-matching-exhibit-592840');
            await page.waitForFunction(() => document.querySelectorAll('[data-select]').length === 0);
            await page.locator('#search').fill('');
            await page.locator('[data-select]').first().waitFor();
            await page.goto(TEST_ORIGIN + '/accessibility.html');
            await page.locator('.palette-option').first().waitFor();
            assert.equal(await page.locator('.palette-option').count(), 5);
            await page.screenshot({ path: new URL(name + '-accessibility.png', output).pathname });
            assert.deepEqual(errors, [], 'No browser or console errors');
            assert.deepEqual(audit.errors, [], 'No external requests or transport failures');
            assert.deepEqual(audit.blockedWrites, [], 'Smoke tests never mutate production data');
        } catch (error) {
            await page.screenshot({ path: new URL(name + '-failure.png', output).pathname }).catch(() => {});
            throw error;
        } finally {
            await writeFile(new URL(name + '-audit.json', output), JSON.stringify({ ...audit, errors }, null, 2) + '\n');
            await context.close();
        }
    });

    test(`${name}: naming a new exhibit keeps its inspector in place`, { timeout: 120000 }, async () => {
        const audit = { requests: [], blockedWrites: [], errors: [] };
        const errors = [];
        const context = await browser.newContext({ viewport, locale: 'en-GB', reducedMotion: 'no-preference' });
        await installTransport(context, installation.app, audit);
        await context.addInitScript(() => localStorage.setItem('hub-language', 'en'));
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        try {
            await page.goto(`${TEST_ORIGIN}/index.html?webgl=1&floor=${installation.fixture.home_floor}`);
            await page.locator('[data-select]').first().waitFor();
            await page.locator('.app-menu summary').click();
            await page.locator('[data-action="enterEdit"]').click();
            await page.locator('[data-action="newExhibit"]').click();
            await page.locator('#creation-form').waitFor();
            await page.waitForFunction(() => !document.getAnimations().some(animation => ['inspector-spring', 'sidebar-spring'].includes(animation.id)));
            await page.evaluate(() => {
                window.creationMotion = { animations: [], snapshots: 0 };
                const animate = Element.prototype.animate;
                Element.prototype.animate = function (...args) {
                    if (['inspector', 'resizer', 'sidebar', 'editbar'].includes(this.id)) window.creationMotion.animations.push(this.id);
                    return animate.apply(this, args);
                };
                new MutationObserver(records => {
                    window.creationMotion.snapshots += records.reduce((count, record) => count + record.addedNodes.length, 0);
                }).observe(document.querySelector('#inspector-underlays'), { childList: true });
            });
            const exhibitName = 'New inspector continuity';
            await page.locator('#ex-name').fill(exhibitName);
            await page.locator('#creation-form [type="submit"]').click();
            await page.locator('#structure-form').waitFor();
            assert.equal(await page.locator('#inspector h1').textContent(), exhibitName);
            assert.deepEqual(await page.evaluate(() => window.creationMotion), { animations: [], snapshots: 0 });
            assert.equal(await page.locator('#inspector-underlays > *').count(), 0);
            assert.equal(await page.locator('#inspector-stack > *').count(), 0);
            if (name === 'mobile') {
                await page.locator('[data-action="view:list"]').click();
                await page.locator('[data-select=' + JSON.stringify(exhibitName) + ']').click();
                assert.deepEqual(await page.evaluate(() => window.creationMotion), { animations: [], snapshots: 0 }, 'revealing the same inspector keeps its context');
                await page.locator('[data-action="view:list"]').click();
            }
            const existing = installation.fixture.exhibits.find(row => row.floor_id === installation.fixture.home_floor);
            await page.locator('[data-select=' + JSON.stringify(existing.id) + ']').click();
            assert((await page.evaluate(() => window.creationMotion.animations)).includes('inspector'), 'another exhibit still gets its entry animation');
            assert.deepEqual(errors, [], 'No browser or console errors');
            assert.deepEqual(audit.errors, [], 'No external requests or transport failures');
            assert.deepEqual(audit.blockedWrites, [], 'Creation stays in the local edit draft');
        } catch (error) {
            await page.screenshot({ path: new URL(name + '-creation-failure.png', output).pathname }).catch(() => {});
            throw error;
        } finally {
            await writeFile(new URL(name + '-creation-audit.json', output), JSON.stringify({ ...audit, errors }, null, 2) + '\n');
            await context.close();
        }
    });
}
