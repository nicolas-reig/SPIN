#!/usr/bin/env python3
"""Verify the comparator against a real captured canvas pixel, not a fixture PNG."""
import argparse
import json
from pathlib import Path
from PIL import Image
from compare import compare_images


def negative_control(run, output):
    run, output = Path(run), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    report = json.loads((run / 'run.json').read_text())
    if not report.get('complete'):
        raise ValueError('Negative control requires a completed real browser run')
    frame = next(frame for frame in report['frames'] if frame.get('canvas'))
    original = run / frame['file']
    image = Image.open(original).convert('RGBA')
    rect = frame['canvas']
    x, y = round(rect['x'] + rect['width'] / 2), round(rect['y'] + rect['height'] / 2)
    pixel = image.getpixel((x, y))
    image.putpixel((x, y), (pixel[0] ^ 1, *pixel[1:]))
    changed = output / 'one-canvas-pixel.png'
    image.save(changed)
    result = compare_images(original, changed, output / 'detected-pixel.png')
    assert result['pass'] is False and result['differing_pixels'] == 1
    assert result['maximum_channel_delta'] == 1
    result.update({'negative_control_pass': True, 'source_frame': frame['name'], 'changed_pixel': [x, y]})
    (output / 'negative-control.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('run')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = negative_control(args.run, args.output)
    print(json.dumps({'negative_control_pass': result['negative_control_pass'], 'differing_pixels': result['differing_pixels']}))
