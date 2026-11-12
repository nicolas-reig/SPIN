#!/usr/bin/env python3
"""Exact all-pixel RGBA comparator. No masks, registration, global drift or AA exclusions."""
from __future__ import annotations
import argparse
from collections import Counter
import json
import math
from pathlib import Path
from PIL import Image, ImageChops

ENVIRONMENT_KEYS = ('viewport', 'device_scale_factor', 'browser_version', 'browser_arguments', 'clock_epoch',
                    'profile', 'backend', 'browser_executable', 'playwright_version', 'environment')
STATE_KEYS = ('url', 'view', 'colorMode', 'selected', 'floor', 'editing', 'viewport', 'heading',
              'openDialog', 'openMenus', 'canvasState', 'animation_ms')


def validate_report(report, side):
    errors = []
    for key in ENVIRONMENT_KEYS:
        if key not in report or report[key] is None:
            errors.append(f'{side} missing environment metadata: {key}')
    frames = report.get('frames')
    if not isinstance(frames, list):
        return errors + [f'{side} missing frame list']
    names = [frame.get('name') for frame in frames if isinstance(frame, dict)]
    if len(names) != len(frames) or any(not isinstance(name, str) or not name for name in names):
        errors.append(f'{side} invalid frame names')
    valid_names = [name for name in names if isinstance(name, str)]
    if len(valid_names) != len(set(valid_names)):
        errors.append(f'{side} duplicate frame names')
    for frame in frames:
        if not isinstance(frame, dict):
            continue
        filename = frame.get('file')
        if not isinstance(filename, str) or Path(filename).name != filename or not filename.endswith('.png'):
            errors.append(f'{side} invalid frame filename: {frame.get("name")}')
        for key in ('canvas', *STATE_KEYS[:-1]):
            if key not in frame:
                errors.append(f'{side} missing frame metadata: {frame.get("name")} {key}')
        if frame.get('clock_frozen') is not True:
            errors.append(f'{side} screenshot clock was not verified frozen: {frame.get("name")}')
    for context in report.get('contexts', []):
        for key in ('blockedWrites', 'errors', 'pageErrors', 'consoleErrors'):
            if key not in context or context[key]:
                errors.append(f'{side} browser context failure: {context.get("name")} {key}')
    if report.get('failure'):
        errors.append(f'{side} recorded a browser failure')
    return errors


def compare_images(baseline, candidate, diff_path=None):
    a, b = Image.open(baseline).convert('RGBA'), Image.open(candidate).convert('RGBA')
    if a.size != b.size:
        return {'pass': False, 'reason': 'dimensions', 'baseline_size': a.size, 'candidate_size': b.size}
    delta = ImageChops.difference(a, b)
    # Alpha can be equal while RGB differs: RGBA.getbbox alone would miss that.
    bands = delta.split()
    changed = ImageChops.lighter(ImageChops.lighter(bands[0], bands[1]), ImageChops.lighter(bands[2], bands[3]))
    count = sum(changed.histogram()[1:])
    squares = sum(value * value * amount for band in bands for value, amount in enumerate(band.histogram()))
    maximum = max(max(band.getextrema()) for band in bands)
    if diff_path and count:
        Path(diff_path).parent.mkdir(parents=True, exist_ok=True)
        # Solid magenta for every changed pixel; retain a faint baseline elsewhere.
        overlay = a.convert('RGB').point(lambda value: int(value * .3))
        overlay.paste((255, 0, 255), mask=changed.point(lambda value: 255 if value else 0))
        overlay.save(diff_path)
    return {'pass': count == 0, 'differing_pixels': count, 'total_pixels': a.width * a.height,
            'ratio': count / (a.width * a.height), 'maximum_channel_delta': maximum,
            'rmse_rgba': math.sqrt(squares / (a.width * a.height * 4)), 'bounds': changed.getbbox()}


def rendering_metrics(path, canvas_rect=None):
    image = Image.open(path).convert('RGB')
    if canvas_rect:
        x, y, w, h = (canvas_rect[key] for key in ('x', 'y', 'width', 'height'))
        image = image.crop((round(x), round(y), round(x + w), round(y + h)))
    raw = image.tobytes()
    colors = Counter(zip(raw[0::3], raw[1::3], raw[2::3]))
    pixels = image.width * image.height
    dominant = colors.most_common(1)[0][1] if pixels else 0
    foreground = pixels - dominant
    # A valid map must contain actual shaded geometry, not just a flat canvas.
    return {'pass': pixels > 10000 and len(colors) >= 32 and foreground >= 400 and foreground / max(1, pixels) >= .002,
            'pixels': pixels, 'unique_colors': len(colors), 'non_dominant_pixels': foreground,
            'non_dominant_fraction': foreground / max(1, pixels)}


def compare_runs(baseline_dir, candidate_dir, output):
    baseline_dir, candidate_dir, output = Path(baseline_dir), Path(candidate_dir), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    a = json.loads((baseline_dir / 'run.json').read_text())
    b = json.loads((candidate_dir / 'run.json').read_text())
    frames_a = {frame['name']: frame for frame in a.get('frames', []) if isinstance(frame, dict) and isinstance(frame.get('name'), str)}
    frames_b = {frame['name']: frame for frame in b.get('frames', []) if isinstance(frame, dict) and isinstance(frame.get('name'), str)}
    results = []
    invariant_errors = validate_report(a, 'baseline') + validate_report(b, 'candidate')
    for key in ENVIRONMENT_KEYS:
        if a.get(key) != b.get(key):
            invariant_errors.append('Environment mismatch: ' + key)
    for key in ('assets', 'exhibits'):
        for phase in ('original', 'staged'):
            sha_a = a.get('stage', {}).get(phase, {}).get(key, {}).get('sha256')
            sha_b = b.get('stage', {}).get(phase, {}).get(key, {}).get('sha256')
            if not isinstance(sha_a, str) or not isinstance(sha_b, str) or not sha_a or not sha_b:
                invariant_errors.append(f'Missing input fingerprint: {phase} {key}')
            elif sha_a != sha_b:
                invariant_errors.append(f'Input data mismatch: {phase} {key}')
    if a.get('stage', {}).get('fixture') != b.get('stage', {}).get('fixture'):
        invariant_errors.append('Fixture definition mismatch')
    for name in sorted(set(frames_a) | set(frames_b)):
        if name not in frames_a or name not in frames_b:
            results.append({'name': name, 'pass': False, 'reason': 'missing frame'})
            continue
        frame_a, frame_b = frames_a[name], frames_b[name]
        try:
            if any(not isinstance(frame.get('file'), str) or Path(frame['file']).name != frame['file'] for frame in (frame_a, frame_b)):
                raise ValueError('Invalid frame filename')
            result = {'name': name, **compare_images(baseline_dir / frame_a['file'], candidate_dir / frame_b['file'], output / (Path(frame_a['file']).name))}
        except (OSError, ValueError, KeyError) as error:
            results.append({'name': name, 'pass': False, 'reason': 'unreadable frame', 'error': str(error)})
            continue
        if frame_a.get('canvas') != frame_b.get('canvas'):
            result['canvas_rect_changed'] = True
            result['pass'] = False
            result['reason'] = 'canvas rectangle changed'
        state_changes = [key for key in STATE_KEYS if frame_a.get(key) != frame_b.get(key)]
        if state_changes:
            result['state_changes'] = state_changes
            result['pass'] = False
            result['reason'] = 'functional frame state changed'
        for side, directory, frame in [('baseline', baseline_dir, frame_a), ('candidate', candidate_dir, frame_b)]:
            if frame.get('canvas'):
                metrics = rendering_metrics(directory / frame['file'], frame['canvas'])
                result[side + '_rendering'] = metrics
                if not metrics['pass']:
                    result['pass'] = False
                    result['reason'] = 'blank/insufficient canvas geometry'
        results.append(result)
    stability = {}
    for side, directory, frames in [('baseline', baseline_dir, frames_a), ('candidate', candidate_dir, frames_b)]:
        groups = {}
        for name, frame in frames.items():
            if '-settled-' in name:
                groups.setdefault(name.rsplit('-settled-', 1)[0], []).append(frame)
        stability[side] = []
        for group, members in groups.items():
            for frame in members[1:]:
                try:
                    check = compare_images(directory / members[0]['file'], directory / frame['file'])
                except (OSError, ValueError, KeyError) as error:
                    check = {'pass': False, 'reason': 'unreadable settled frame', 'error': str(error)}
                stability[side].append({'group': group, 'frame': frame['name'], **check})
                if not check['pass']:
                    invariant_errors.append(f'{side} unsettled repeated state: {group}')
    if not a.get('complete') or not b.get('complete'):
        invariant_errors.append('Incomplete browser run')
    if not results:
        invariant_errors.append('No frames')
    result = {'pass': not invariant_errors and all(row['pass'] for row in results),
              'environment_errors': invariant_errors, 'frames': results, 'stability': stability,
              'counts': {'frames': len(results), 'passed': sum(row['pass'] for row in results),
                         'failed': sum(not row['pass'] for row in results)}}
    (output / 'comparison.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('baseline')
    parser.add_argument('candidate')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = compare_runs(args.baseline, args.candidate, args.output)
    print(json.dumps({'pass': result['pass'], 'counts': result['counts'], 'environment_errors': result['environment_errors']}))
    raise SystemExit(0 if result['pass'] else 1)

if __name__ == '__main__':
    main()
