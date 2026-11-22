import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { syntheticInstallation } from '../fixtures/synthetic-installation.mjs';

const output = new URL('../artifacts/browser/', import.meta.url);
let installation, php, origin, browser;

before(async () => {
    installation = await syntheticInstallation();
    const first = installation.fixture.exhibits.find(record => record.floor_id === installation.fixture.home_floor);
    const shortcut = path.join(installation.root, 'Exponate', first.id, 'Links', 'Visual documentation.url');
    await writeFile(shortcut, '[InternetShortcut]\r\nURL=https://example.invalid/first-manual\r\n');
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

test('each added exhibit slides in once the service inspector is stacked', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
    try {
        await context.addInitScript(() => {
            window.inspectorEntries = [];
            const animate = Element.prototype.animate;
            Element.prototype.animate = function (...args) {
                const animation = animate.apply(this, args);
                if (this.id === 'inspector') window.inspectorEntries.push(animation);
                return animation;
            };
        });
        const page = await context.newPage();
        await page.goto(`${origin}/index.html?webgl=1`);
        const exhibits = page.locator('[data-select]');
        await exhibits.nth(0).click();
        await exhibits.nth(1).press('Shift+Enter');
        await page.waitForFunction(() => window.inspectorEntries.filter(animation => animation.id === 'inspector-spring').length === 2);
        await exhibits.nth(2).press('Shift+Enter');
        await page.waitForFunction(() => window.inspectorEntries.filter(animation => animation.id === 'inspector-spring').length === 3);
        assert.equal(await page.locator('#inspector .selection-tags .exhibit-tag').count(), 3);
    } finally {
        await context.close();
    }
});

for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }]
]) {
    test(`${name}: batch posts and links from the service view`, { timeout: 120000 }, async () => {
        const mobile = name === 'mobile';
        const context = await browser.newContext({ viewport, hasTouch: mobile, locale: 'en-GB', reducedMotion: 'reduce' });
        await context.addInitScript(() => {
            localStorage.setItem('hub-language', 'en');
            Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.copiedLink = value; } } });
        });
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
        const tags = page.locator('#inspector .selection-tags .exhibit-tag');
        const panel = page.locator('#inspector-content');
        const posts = panel.locator('.note');
        const links = panel.locator('.link-card');
        const postsTab = page.getByRole('tab', { name: 'Posts' });
        const documentationTab = page.getByRole('tab', { name: 'Documentation' });
        const recipients = [first.id, second.id].sort();
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
            assert.equal(await page.locator('#exhibit-list .content-selection-mark').count(), 0);
            assert.equal(await title.textContent(), '2 exhibits selected');
            assert.deepEqual((await tags.allTextContents()).sort(), recipients);
            assert.equal(await page.locator('#editbar').isHidden(), true);
            assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Posts', 'Documentation']);
            assert.equal(await postsTab.getAttribute('aria-selected'), 'true');
            const fixturePosts = posts.filter({ hasText: 'Deterministic visual fixture' });
            assert.deepEqual((await fixturePosts.locator('.exhibit-tag').allTextContents()).sort(), recipients);
            await page.screenshot({ path: new URL(`${name}-batch-content.png`, output).pathname });

            await postsTab.press('ArrowRight');
            assert.equal(await documentationTab.getAttribute('aria-selected'), 'true');
            const fixtureLinks = links.filter({ hasText: 'Visual documentation' });
            assert.deepEqual((await fixtureLinks.locator('.exhibit-tag').allTextContents()).sort(), recipients);
            const sourceLink = fixtureLinks.filter({ hasText: 'https://example.invalid/first-manual' });
            await sourceLink.getByRole('button', { name: 'Copy URL: Visual documentation' }).click();
            assert.equal(await page.evaluate(() => window.copiedLink), 'https://example.invalid/first-manual');

            await documentationTab.press('ArrowLeft');
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
            await page.getByRole('button', { name: 'Post to all' }).click();
            await page.locator('#note-signature').fill('Batch Tester');
            await page.locator('[data-action=confirmNote]').click();
            await page.locator('#notice').getByText('Saved to 2 exhibits').waitFor();
            const dates = await posts.locator('time[datetime]').evaluateAll(times => times.map(time => time.dateTime));
            assert.deepEqual(dates, [...dates].sort().reverse(), 'Posts from all selected exhibits share chronological order');
            const published = posts.filter({ hasText: body });
            const photoSources = await published.evaluateAll(cards => cards.map(card => [
                card.querySelector('.exhibit-tag').textContent,
                new URL(card.querySelector('.note-body img').src).searchParams.get('exhibitId')
            ]));
            assert.deepEqual(photoSources.sort(), recipients.map(id => [id, id]), 'Photos use the source exhibit folder');
            for (const image of await published.locator('.note-body img').all()) {
                await image.scrollIntoViewIfNeeded();
                await image.evaluate(photo => photo.decode());
            }

            await documentationTab.click();
            await page.locator('#link-title').fill(linkTitle);
            await page.locator('#link-url').fill('example.org/batch-manual');
            await page.locator('#link-description').fill('Shared guide');
            const saved = page.waitForResponse(response => response.url() === `${origin}/api.php` && response.request().method() === 'POST');
            await page.getByRole('button', { name: 'Add to all' }).click();
            assert.equal((await saved).status(), 200);
            await page.waitForFunction(() => document.querySelector('#link-title')?.value === '');
            const titles = await links.locator('.document-title').allTextContents();
            assert.deepEqual(titles, [...titles].sort(), 'Documentation links from all selected exhibits share alphabetical order');
            assert.deepEqual((await links.filter({ hasText: linkTitle }).locator('.exhibit-tag').allTextContents()).sort(), recipients);
            await page.screenshot({ path: new URL(`${name}-batch-documentation.png`, output).pathname });

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
            if (!mobile) {
                await page.locator('.app-menu summary').click();
                await page.locator('[data-action="enterEdit"]').click();
                await row(first).click();
                await row(second).press('Shift+Enter');
                assert.equal(await title.textContent(), '2 exhibits selected');
                assert.deepEqual((await tags.allTextContents()).sort(), recipients);
                assert.equal(await page.locator('#structure-form').isVisible(), true);
                await page.screenshot({ path: new URL('desktop-batch-edit.png', output).pathname });
            }
            assert.deepEqual(errors, []);
        } catch (error) {
            await page.screenshot({ path: new URL(`${name}-batch-failure.png`, output).pathname }).catch(() => {});
            throw error;
        } finally {
            await context.close();
        }
    });
}
