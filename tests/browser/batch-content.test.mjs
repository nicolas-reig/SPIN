import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { syntheticInstallation } from '../fixtures/synthetic-installation.mjs';

const output = new URL('../artifacts/browser/', import.meta.url);
let installation, php, origin, browser;

before(async () => {
    installation = await syntheticInstallation();
    const scratch = path.join(installation.root, 'php-tmp');
    await mkdir(scratch);
    await mkdir(output, { recursive: true });
    // Use the real write API against a disposable installation on loopback.
    php = spawn('php', ['-d', `sys_temp_dir=${scratch}`, '-S', '127.0.0.1:0', '-t', path.join(installation.app, 'frontend')], {
        stdio: ['ignore', 'ignore', 'pipe']
    });
    origin = await new Promise((resolve, reject) => {
        php.once('error', reject);
        php.stderr.once('data', chunk => {
            const address = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
            if (address) resolve(address);
            else reject(Error(chunk.toString()));
        });
    });
    php.stderr.resume();
    browser = await chromium.launch({
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-color-profile=srgb'],
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
    });
}, { timeout: 20000 });

after(async () => {
    await browser?.close();
    if (php?.pid && php.exitCode === null && php.signalCode === null) {
        const stopped = once(php, 'exit');
        php.kill();
        await stopped;
    }
    await installation?.cleanup();
});

for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }]
]) {
    test(`${name}: batch posts and links from the service view`, { timeout: 120000 }, async () => {
        const mobile = name === 'mobile';
        const context = await browser.newContext({ viewport, hasTouch: mobile, locale: 'en-GB', reducedMotion: 'reduce' });
        await context.addInitScript(() => localStorage.setItem('hub-language', 'en'));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const floor = installation.fixture.home_floor;
        const first = installation.fixture.exhibits.find(record => record.floor_id === floor);
        const second = installation.fixture.exhibits.find(record => record.floor_id !== floor);
        const row = record => page.locator('[data-select=' + JSON.stringify(record.id) + ']');
        const list = page.locator('[data-action="view:list"]'), detail = page.locator('[data-action="view:detail"]');
        const title = page.locator('#inspector .inspector-header h1');
        const body = `Shared maintenance post (${name})`;
        const linkTitle = `Shared maintenance guide (${name})`;
        const note = page.locator('#note-body');
        const selected = page.locator('[data-select][aria-pressed="true"]');
        try {
            await page.goto(`${origin}/index.html?webgl=1&floor=${floor}`);
            if (mobile) {
                await page.getByRole('button', { name: 'Select multiple exhibits' }).tap();
                await row(first).tap();
                await row(second).tap();
                assert.match(await detail.textContent(), /2 selected/);
                await detail.tap();
            } else {
                await row(first).click();
                await row(second).press('Shift+Enter');
            }
            assert.equal(await selected.count(), 2);
            assert.equal(await title.textContent(), '2 exhibits selected');
            assert.deepEqual((await page.locator('.batch-recipients li').allTextContents()).sort(), [first.id, second.id].sort());
            assert.equal(await page.locator('#editbar').isHidden(), true);
            await note.fill(body);
            await page.locator('#note-image').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png',
                buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=', 'base64') });
            await page.locator('.attachments img').waitFor();
            if (mobile) {
                await list.tap();
                await row(first).tap();
                assert.equal(await selected.count(), 1);
                await row(first).tap();
                await detail.tap();
            } else {
                await row(first).click();
                assert.equal(await selected.count(), 1);
                assert.equal(await title.textContent(), first.id);
                await row(second).click({ modifiers: ['Shift'] });
            }
            assert.equal(await note.textContent(), body, 'The draft follows its recipients');
            assert.equal(await page.locator('.attachments img').count(), 1);
            await page.screenshot({ path: new URL(`${name}-batch-content.png`, output).pathname });
            await page.getByRole('button', { name: 'Post to all' }).click();
            await page.locator('#note-signature').fill('Batch Tester');
            await page.locator('[data-action=confirmNote]').click();
            await page.locator('#notice').getByText('Saved to 2 exhibits').waitFor();

            await page.getByRole('tab', { name: 'Documentation' }).click();
            await page.locator('#link-title').fill(linkTitle);
            await page.locator('#link-url').fill('example.org/batch-manual');
            await page.locator('#link-description').fill('Shared guide');
            const saved = page.waitForResponse(response => response.url() === `${origin}/api.php` && response.request().method() === 'POST');
            await page.getByRole('button', { name: 'Add to all' }).click();
            assert.equal((await saved).status(), 200);
            await page.waitForFunction(() => document.querySelector('#link-title')?.value === '');

            const snapshot = await (await fetch(`${origin}/api.php`)).json();
            for (const record of snapshot.exhibits) {
                const count = [first.id, second.id].includes(record.id) ? 1 : 0;
                const posts = record.notes.filter(post => post.body.startsWith(body));
                const links = record.links.filter(link => link.title === linkTitle);
                assert.equal(posts.length, count, record.id);
                assert.equal(links.length, count, record.id);
                if (count) {
                    assert.match(posts[0].body, /\.\.\/Fotos\//);
                    assert.equal(posts[0].author, 'Batch Tester');
                    assert.equal(links[0].url, 'http://example.org/batch-manual');
                }
            }
            await page.getByRole('button', { name: 'Clear selection' }).click();
            assert.equal(await selected.count(), 0);
            assert.deepEqual(errors, []);
        } catch (error) {
            await page.screenshot({ path: new URL(`${name}-batch-failure.png`, output).pathname }).catch(() => {});
            throw error;
        } finally {
            await context.close();
        }
    });
}
