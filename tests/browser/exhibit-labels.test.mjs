import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { syntheticInstallation } from '../fixtures/synthetic-installation.mjs';
import { installTransport, TEST_ORIGIN } from '../visual/transport.mjs';

function waitForPrefix(page, selector, short) {
    return page.waitForFunction(({ selector, short }) => {
        const prefix = document.querySelector(selector);
        return prefix && prefix.classList.contains('sr-only') === short;
    }, { selector, short });
}

test('exhibit labels give up their group prefix before wrapping and restore it on resize', { timeout: 120000 }, async t => {
    const installation = await syntheticInstallation();
    t.after(() => installation.cleanup());
    const name = 'Immersive Technology Collection - Hologram';
    await mkdir(path.join(installation.root, 'Exponate', name));
    const browser = await chromium.launch({
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
    });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-GB', reducedMotion: 'reduce' });
    const audit = { requests: [], blockedWrites: [], errors: [] };
    await installTransport(context, installation.app, audit);
    await context.addInitScript(() => localStorage.setItem('hub-language', 'en'));
    const page = await context.newPage();
    await page.goto(TEST_ORIGIN + '/index.html?webgl=1');

    const row = '[data-select=' + JSON.stringify(name) + ']';
    const inspectorPrefix = '#inspector h1 .exhibit-name-prefix';
    await page.locator(row).click();
    await waitForPrefix(page, row + ' .exhibit-name-prefix', true);
    await waitForPrefix(page, inspectorPrefix, true);
    assert.equal(await page.locator('#inspector h1').textContent(), name);
    assert(await page.getByRole('heading', { name, exact: true }).isVisible(), 'the full name remains available to assistive technology');
    assert(await page.locator('#inspector h1 .exhibit-name-text').evaluate(element =>
        element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) + 1
    ), 'the suffix fits without wrapping');

    const resize = page.locator('#resizer');
    const max = Number(await resize.getAttribute('aria-valuemax'));
    const width = Number(await resize.getAttribute('aria-valuenow'));
    for (let current = width; current < max; current += 24) await resize.press('ArrowLeft');
    await waitForPrefix(page, inspectorPrefix, false);
    for (let current = max; current > 320; current -= 24) await resize.press('ArrowRight');
    await waitForPrefix(page, inspectorPrefix, true);

    await page.locator('#search').fill('Immersive Technology Collection');
    assert(await page.locator(row).isVisible(), 'search still uses the full exhibit name');
    await page.locator('.app-menu summary').click();
    await page.locator('[data-action="enterEdit"]').click();
    await waitForPrefix(page, inspectorPrefix, true);
    await waitForPrefix(page, row + ' + .exhibit-label .exhibit-name-prefix', true);
    assert(await page.locator('#inspector [data-action="renameExhibit"]').isVisible());
    assert.equal(await page.locator('#inspector h1').textContent(), name);
    assert.deepEqual(audit.errors, []);
    assert.deepEqual(audit.blockedWrites, []);
});
