import { cp, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));

// Copy code and generate content in a disposable installation. Never read local config/data.
export async function syntheticInstallation() {
    const root = await mkdtemp(path.join(tmpdir(), 'spin-synthetic-'));
    const app = path.join(root, 'WebApp');
    try {
        await mkdir(app);
        for (const name of ['frontend', 'backend']) {
            await cp(path.join(repository, name), path.join(app, name), {
                recursive: true,
                filter: source => path.basename(source) !== '.DS_Store'
            });
        }
        await copyFile(path.join(repository, 'config.example.php'), path.join(app, 'config.php'));
        for (const name of ['Assets', 'Exponate']) await mkdir(path.join(root, name));
        const fixture = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c',
            'import json,sys;from pathlib import Path;from fixture import matrix_fixture;print(json.dumps(matrix_fixture(Path(sys.argv[1]))))', root
        ], { cwd: path.join(repository, 'tests/visual'), encoding: 'utf8' }));
        return { root, app, fixture, cleanup: () => rm(root, { recursive: true, force: true }) };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}
