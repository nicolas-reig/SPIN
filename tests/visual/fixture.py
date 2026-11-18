#!/usr/bin/env python3
"""Fingerprint application/data trees and stage disposable metadata-preserving copies."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from glb_fixture import floor_glb, hardware_glb

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
    if not root.is_dir():
        raise ValueError('Missing input directory: ' + str(root))
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


def available_name(folder, base, *, suffix=''):
    name, number = base, 1
    while (folder / (name + suffix)).exists():
        number += 1
        name = f'{base} {number}'
    return name


def matrix_fixture(stage, seed=271828):
    """Add portable seeded geometry only to disposable copies; never assume real bounds."""
    assets, exhibits = stage / 'Assets', stage / 'Exponate'
    existing = {p.name for p in (assets / 'Floors').iterdir()} if (assets / 'Floors').exists() else set()
    numbers = []
    candidate = 0
    while len(numbers) < 3:
        if str(candidate) not in existing:
            numbers.append(str(candidate))
        candidate += 1
    metadata_path = assets / 'Floors' / '.floors.json'
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    floors = []
    for index, (number, dimensions) in enumerate(zip(numbers, ((4, 3), (24, 18), (150, 90)))):
        target = assets / 'Floors' / number / 'model.glb'
        target.parent.mkdir(parents=True)
        target.write_bytes(floor_glb(seed + index, *dimensions))
        os.utime(target, ns=(FIXED_NS, FIXED_NS))
        metadata[number] = {'de': f'Test {index + 1}', 'en': f'Test {index + 1}'}
        floors.append({'id': number, 'dimensions': list(dimensions), 'model_id': f'Floors/{number}/model.glb'})
    write_json(metadata_path, metadata)
    hardware = []
    for index, shape in enumerate(('closed-indexed', 'wedge-open', 'nested-shared', 'skinned')):
        folder = assets / 'HardwareModels'
        name = available_name(folder, 'Visual seeded ' + shape, suffix='.glb')
        target = folder / (name + '.glb')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(hardware_glb(seed + index, shape))
        os.utime(target, ns=(FIXED_NS, FIXED_NS))
        hardware.append({'id': target.relative_to(assets).as_posix(), 'shape': shape})
    identity = {'position': [0, 0, 0], 'rotation': [0, 0, 0], 'scale': [1, 1, 1]}
    records = []
    for floor_index, item in enumerate(floors):
        width, depth = item['dimensions']
        scale = min(width, depth) * .035
        for index, status in enumerate(('ok', 'problem', 'retired')):
            name = available_name(exhibits, f'Visual {status} floor {floor_index + 1}')
            folder = exhibits / name
            instances = []
            for model_index, model in enumerate(hardware):
                transform = {'position': [(model_index - 1.5) * width * .18, 0, (index - 1) * depth * .25],
                             'rotation': [0, (seed + model_index * 37 + index * 19) % 360, 0],
                             'scale': [scale, scale, scale]}
                instances.append({'model': model['id'], 'transform': transform})
            write_json(folder / '.exhibit.json', {'floor': int(item['id']), 'status': status,
                                                 'transform': identity, 'models': instances, 'views': {}})
            note = folder / 'Notizen' / 'Visual 10_11_2026 12.00.md'
            note.parent.mkdir(parents=True, exist_ok=True)
            note.write_text('# Deterministic visual fixture\n\nA post with **bold**, a [link](https://example.invalid) and a list.\n\n1. First\n2. Second\n')
            os.utime(note, ns=(FIXED_NS, FIXED_NS))
            link = folder / 'Links' / 'Visual documentation.url'
            link.parent.mkdir(parents=True, exist_ok=True)
            link.write_text('[InternetShortcut]\nURL=https://example.invalid/manual\n')
            os.utime(link, ns=(FIXED_NS, FIXED_NS))
            records.append({'id': name, 'floor_id': item['id'], 'status': status, 'models': len(instances)})
    return {'version': 1, 'seed': seed, 'home_floor': floors[1]['id'], 'floors': floors,
            'hardware': hardware, 'exhibits': records}


def stage_copy(source, data, profile, destination=None, *, php='php', seed=271828):
    stage = Path(destination) if destination else Path(tempfile.mkdtemp(prefix='digitaltwin-visual-'))
    stage.mkdir(parents=True, exist_ok=True)
    original = fingerprint(source, data)
    app = stage / 'WebApp'
    app.mkdir()
    for name in ('frontend', 'backend'):
        shutil.copytree(Path(source) / name, app / name, copy_function=shutil.copy2, ignore=shutil.ignore_patterns(*SKIP))
    if (Path(source) / 'config.php').is_file():
        shutil.copy2(Path(source) / 'config.php', app / 'config.php')
    for name in ('Assets', 'Exponate'):
        shutil.copytree(Path(data) / name, stage / name, copy_function=shutil.copy2, ignore=shutil.ignore_patterns(*SKIP))
    copied = fingerprint(app, stage)
    for key in ('code', 'assets', 'exhibits'):
        if original[key]['sha256'] != copied[key]['sha256']:
            raise ValueError(f'Staged {key} content/mtime differs before fixture augmentation')
    fixture = matrix_fixture(stage, seed) if profile == 'matrix' else None
    config = app / 'config.php'
    if not config.is_file():
        shutil.copy2(app / 'backend/config.example.php', config)
    serialized = subprocess.check_output([php, '-r', '$v=require $argv[1];echo json_encode($v);', str(config)], text=True)
    configured = json.loads(serialized)
    if not isinstance(configured, dict):
        raise ValueError('config.php must return a settings object')
    overrides = {}
    for key, name in (('assets_dir', 'Assets'), ('exhibits_dir', 'Exponate')):
        if not isinstance(configured.get(key), str):
            raise ValueError('config.php missing data setting: ' + key)
        if Path(configured[key]).resolve() != (stage / name).resolve():
            overrides[key] = {'source_value': configured[key], 'staged_folder': name}
            configured[key] = str((stage / name).resolve())
    if overrides:
        # Test-only config adaptation: retain every unrelated setting and record the delta.
        encoded = base64.b64encode(json.dumps(configured, ensure_ascii=False).encode()).decode()
        config.write_text("<?php return json_decode(base64_decode('" + encoded + "'), true, 512, JSON_THROW_ON_ERROR);\n")
    final = fingerprint(app, stage)
    return {'root': str(stage.resolve()), 'profile': profile, 'original': original, 'staged': final,
            'fixture': fixture, 'config_overrides': overrides}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('fingerprint', 'stage'))
    parser.add_argument('--source', required=True)
    parser.add_argument('--data', required=True)
    parser.add_argument('--profile', default='source', choices=('source', 'matrix'))
    parser.add_argument('--destination')
    parser.add_argument('--php', default=os.environ.get('PHP', 'php'))
    parser.add_argument('--seed', type=int, default=271828)
    args = parser.parse_args()
    result = fingerprint(args.source, args.data) if args.operation == 'fingerprint' else stage_copy(args.source, args.data, args.profile, args.destination, php=args.php, seed=args.seed)
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
