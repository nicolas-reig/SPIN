#!/usr/bin/env python3
"""Fingerprint application/data trees and stage disposable metadata-preserving copies."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

CODE_ROOTS = ('frontend', 'backend', 'config.php')
SKIP = {'.DS_Store', '.git', 'node_modules', '__pycache__'}
FIXED_NS = 1_794_268_800_000_000_000  # fixed fixture mtimes, independent of the run


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def tree_manifest(root, *, code=False):
    root = Path(root).resolve()
    starts = [root / name for name in CODE_ROOTS] if code else [root]
    rows = []
    for start in starts:
        files = [start] if start.is_file() else sorted(start.rglob('*'))
        for path in files:
            if not path.is_file() or any(p in SKIP for p in path.relative_to(root).parts):
                continue
            stat = path.stat()
            row = {'path': path.relative_to(root).as_posix(), 'bytes': stat.st_size, 'sha256': digest(path)}
            if not code:
                row['mtime_ns'] = stat.st_mtime_ns
            rows.append(row)
    rows.sort(key=lambda row: row['path'])
    packed = json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()
    return {'sha256': hashlib.sha256(packed).hexdigest(), 'files': rows}


def fingerprint(source, data):
    source, data = Path(source).resolve(), Path(data).resolve()
    try:
        ref = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True, stderr=subprocess.DEVNULL).strip()
        dirty = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain', '--', *CODE_ROOTS], text=True).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        ref, dirty = None, None
    return {'source': str(source), 'data': str(data), 'git_ref': ref, 'git_app_dirty': dirty,
            'code': tree_manifest(source, code=True),
            'assets': tree_manifest(data / 'Assets'), 'exhibits': tree_manifest(data / 'Exponate')}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    os.utime(path, ns=(FIXED_NS, FIXED_NS))


def matrix_fixture(stage):
    """Add explicit test content only to disposable copies; retain source-data frames too."""
    assets, exhibits = stage / 'Assets', stage / 'Exponate'
    floors = sorted((assets / 'Floors').glob('*/model.glb'))
    hardware = sorted((assets / 'HardwareModels').glob('*.glb'))
    if not floors or not hardware:
        raise ValueError('Matrix profile needs one real floor GLB and hardware GLB')
    for number in ('-1', '1'):
        target = assets / 'Floors' / number / 'model.glb'
        if target.exists():
            raise ValueError(f'Matrix fixture would overwrite existing floor {number}')
        target.parent.mkdir(parents=True)
        shutil.copy2(floors[0], target)
    metadata_path = assets / 'Floors' / '.floors.json'
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    metadata.update({'-1': {'de': 'Test UG', 'en': 'Test basement'}, '1': {'de': 'Test OG', 'en': 'Test upper floor'}})
    write_json(metadata_path, metadata)
    model = hardware[0].relative_to(assets).as_posix()
    identity = {'position': [0, 0, 0], 'rotation': [0, 0, 0], 'scale': [1, 1, 1]}
    # Use original placed coordinates so added instances lie inside the building frame.
    originals = sorted(exhibits.glob('*/.exhibit.json'))
    original = next((json.loads(p.read_text()) for p in originals if json.loads(p.read_text()).get('models')), {})
    transform = original.get('models', [{}])[0].get('transform', identity)
    for index, status in enumerate(('ok', 'problem', 'retired')):
        name = f'Visual {status}'
        folder = exhibits / name
        if folder.exists():
            raise ValueError('Matrix fixture name already exists: ' + name)
        instances = []
        for offset in (0, 2, 4):
            placement = json.loads(json.dumps(transform))
            placement['position'][0] += index * 8 + offset
            instances.append({'model': model, 'transform': placement})
        write_json(folder / '.exhibit.json', {'floor': 0, 'status': status, 'transform': identity, 'models': instances, 'views': {}})
        note = folder / 'Notizen' / 'Visual 10_11_2026 12.00.md'
        note.parent.mkdir(parents=True, exist_ok=True)
        note.write_text('# Deterministic visual fixture\n\nA post with **bold**, a [link](https://example.invalid) and a list.\n\n1. First\n2. Second\n')
        os.utime(note, ns=(FIXED_NS, FIXED_NS))
        link = folder / 'Links' / 'Visual documentation.url'
        link.parent.mkdir(parents=True, exist_ok=True)
        link.write_text('[InternetShortcut]\nURL=https://example.invalid/manual\n')
        os.utime(link, ns=(FIXED_NS, FIXED_NS))


def stage_copy(source, data, profile, destination=None):
    stage = Path(destination) if destination else Path(tempfile.mkdtemp(prefix='digitaltwin-visual-'))
    stage.mkdir(parents=True, exist_ok=True)
    original = fingerprint(source, data)
    app = stage / 'WebApp'
    app.mkdir()
    for name in CODE_ROOTS:
        path = Path(source) / name
        if path.is_dir():
            shutil.copytree(path, app / name, copy_function=shutil.copy2, ignore=shutil.ignore_patterns(*SKIP))
        else:
            shutil.copy2(path, app / name)
    for name in ('Assets', 'Exponate'):
        shutil.copytree(Path(data) / name, stage / name, copy_function=shutil.copy2, ignore=shutil.ignore_patterns(*SKIP))
    copied = fingerprint(app, stage)
    for key in ('code', 'assets', 'exhibits'):
        if original[key]['sha256'] != copied[key]['sha256']:
            raise ValueError(f'Staged {key} content/mtime differs before fixture augmentation')
    if profile == 'matrix':
        matrix_fixture(stage)
    config = subprocess.check_output(['php', '-r', '$v=require $argv[1];echo json_encode($v);', str(app / 'config.php')], text=True)
    configured = json.loads(config)
    for key, name in (('assets_dir', 'Assets'), ('exhibits_dir', 'Exponate')):
        if Path(configured[key]).resolve() != (stage / name).resolve():
            raise ValueError('config.php must use sibling data folders; refusing to access other data')
    final = fingerprint(app, stage)
    return {'root': str(stage.resolve()), 'profile': profile, 'original': original, 'staged': final}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('fingerprint', 'stage'))
    parser.add_argument('--source', required=True)
    parser.add_argument('--data', required=True)
    parser.add_argument('--profile', default='source', choices=('source', 'matrix'))
    parser.add_argument('--destination')
    args = parser.parse_args()
    result = fingerprint(args.source, args.data) if args.operation == 'fingerprint' else stage_copy(args.source, args.data, args.profile, args.destination)
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
