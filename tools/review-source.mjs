import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function files(directory, matches) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? files(path, matches) : matches(path) ? [path] : [];
    }).sort();
}

function run(command, args, { quiet = false } = {}) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
    if (!quiet || result.status !== 0) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
    }
    if (result.error || result.status !== 0) {
        console.error(result.error?.message ?? `${command} exited with ${result.status}`);
        process.exit(result.status || 1);
    }
}

const javascript = files(join(root, 'frontend/js'), path => path.endsWith('.js'));
for (const path of javascript) run(process.execPath, ['--check', path], { quiet: true });
console.log(`JavaScript syntax: ${javascript.length} application modules passed`);

const php = [
    ...files(join(root, 'backend'), path => path.endsWith('.php')),
    join(root, 'config.php'), join(root, 'frontend/api.php')
];
for (const path of php) run('php', ['-l', path], { quiet: true });
console.log(`PHP syntax: ${php.length} application files passed`);

const unitTests = files(join(root, 'tests/unit'), path => path.endsWith('.test.mjs'));
if (!unitTests.length) throw Error('No source regression tests found');
run(process.execPath, ['--test', ...unitTests.map(path => relative(root, path))]);

const phpTests = files(join(root, 'tests'), path => path.endsWith('.test.php'));
for (const path of phpTests) run('php', [path]);

console.log('Source checks complete. Browser/frame verification is a separate gate.');
