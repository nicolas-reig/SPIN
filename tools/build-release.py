#!/usr/bin/env python3
"""Build a deterministic, source-only SPIN installation with an explicit allowlist."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
RELEASE_PATHS = ('backend', 'frontend', 'config.example.php', 'README.md', 'docs/deployment.md')
REQUIRED_FILES = ('frontend/index.html', 'frontend/api.php', 'backend/Store.php', 'config.example.php')
SKIP_NAMES = {'.DS_Store', '__pycache__', 'node_modules'}


def release_files(source, tracked=None):
    source = Path(source)
    files = {}
    for name in RELEASE_PATHS:
        start = source / name
        if not start.exists() or start.is_symlink():
            raise ValueError('Missing or symbolic release path: ' + name)
        paths = [start, *sorted(start.rglob('*'))] if start.is_dir() else [start]
        for path in paths:
            relative = path.relative_to(source)
            if any(part in SKIP_NAMES for part in relative.parts):
                continue
            if path.is_symlink():
                raise ValueError('Symbolic links cannot be shipped: ' + str(relative))
            if tracked is not None and relative.as_posix() not in tracked:
                continue
            if path.is_file() and path.suffix not in {'.log', '.pyc'}:
                files[relative.as_posix()] = path.read_bytes()
    for name in REQUIRED_FILES:
        if name not in files:
            raise ValueError('Incomplete installation: ' + name)
    return files


def build(source, output, revision, epoch, tracked=None):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Release revision must be a full Git commit SHA')
    if epoch < 0:
        raise ValueError('Release timestamp must be nonnegative')
    files = release_files(source, tracked)
    manifest = {
        'application': 'SPIN', 'revision': revision, 'source_date_epoch': epoch,
        'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
    }
    files['RELEASE.json'] = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    archive = output / ('spin-' + revision + '.tar.gz')
    with archive.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as stream:
        with tarfile.open(fileobj=stream, mode='w', format=tarfile.PAX_FORMAT) as tar:
            for name, data in sorted(files.items()):
                entry = tarfile.TarInfo('WebApp/' + name)
                entry.size, entry.mtime, entry.mode = len(data), epoch, 0o644
                entry.uid = entry.gid = 0
                entry.uname = entry.gname = ''
                tar.addfile(entry, io.BytesIO(data))
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + '.sha256').write_text(checksum + '  ' + archive.name + '\n')
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    epoch = int(subprocess.check_output(['git', 'show', '-s', '--format=%ct', 'HEAD'], cwd=ROOT, text=True))
    # Refuse to label changed application bytes as a clean commit. Untracked secrets stay excluded.
    dirty = subprocess.check_output(['git', 'status', '--porcelain', '--', *RELEASE_PATHS], cwd=ROOT, text=True)
    if dirty.strip():
        parser.error('Commit the runtime and release documentation changes before building a release')
    tracked = set(subprocess.check_output(['git', 'ls-files', '-z', '--', *RELEASE_PATHS],
                                         cwd=ROOT, text=True).split('\0'))
    print(build(ROOT, args.output, revision, epoch, tracked))


if __name__ == '__main__':
    main()
