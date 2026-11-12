#!/usr/bin/env python3
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
from compare import compare_images, compare_runs, rendering_metrics


class ExactPixelComparatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.a, self.b = self.root / 'a.png', self.root / 'b.png'

    def save(self, filename, image):
        image.save(filename)
        return filename

    def test_identical_rgba_passes(self):
        picture = Image.new('RGBA', (20, 20), (10, 20, 30, 255))
        self.save(self.a, picture); self.save(self.b, picture)
        self.assertTrue(compare_images(self.a, self.b)['pass'])

    def test_one_rgb_channel_one_pixel_negative_control(self):
        picture = Image.new('RGBA', (20, 20), (10, 20, 30, 255))
        self.save(self.a, picture)
        picture.putpixel((7, 11), (11, 20, 30, 255))
        self.save(self.b, picture)
        result = compare_images(self.a, self.b, self.root / 'diff.png')
        self.assertFalse(result['pass'])
        self.assertEqual(result['differing_pixels'], 1)
        self.assertEqual(result['maximum_channel_delta'], 1)
        self.assertEqual(result['bounds'], (7, 11, 8, 12))
        self.assertEqual(Image.open(self.root / 'diff.png').getpixel((7, 11)), (255, 0, 255))

    def test_alpha_only_change_is_detected(self):
        picture = Image.new('RGBA', (20, 20), (10, 20, 30, 255))
        self.save(self.a, picture); picture.putpixel((1, 1), (10, 20, 30, 254)); self.save(self.b, picture)
        self.assertEqual(compare_images(self.a, self.b)['differing_pixels'], 1)

    def test_global_one_channel_drift_fails_every_pixel(self):
        self.save(self.a, Image.new('RGB', (20, 20), (10, 20, 30)))
        self.save(self.b, Image.new('RGB', (20, 20), (11, 20, 30)))
        result = compare_images(self.a, self.b)
        self.assertFalse(result['pass']); self.assertEqual(result['differing_pixels'], 400)

    def test_dimensions_change_fails(self):
        self.save(self.a, Image.new('RGB', (20, 20))); self.save(self.b, Image.new('RGB', (21, 20)))
        self.assertEqual(compare_images(self.a, self.b)['reason'], 'dimensions')

    def test_blank_canvas_fails(self):
        self.save(self.a, Image.new('RGB', (200, 200), (250, 250, 250)))
        self.assertFalse(rendering_metrics(self.a)['pass'])

    def test_nonblank_geometry_inside_actual_canvas_rect(self):
        picture = Image.new('RGB', (400, 300), 'white')
        for x in range(100, 200):
            for y in range(100, 200):
                picture.putpixel((x, y), (x % 256, y % 256, 80))
        self.save(self.a, picture)
        self.assertTrue(rendering_metrics(self.a, {'x': 50, 'y': 50, 'width': 220, 'height': 220})['pass'])
        self.assertFalse(rendering_metrics(self.a, {'x': 220, 'y': 50, 'width': 150, 'height': 220})['pass'])

    def test_large_canvas_serializes_pixel_buffer_once(self):
        picture = Image.new('RGB', (1024, 768), (120, 140, 160))
        self.save(self.a, picture)
        original = Image.Image.tobytes
        calls = []
        def observed(image, *args, **kwargs):
            calls.append(image.size)
            return original(image, *args, **kwargs)
        with patch.object(Image.Image, 'tobytes', observed):
            result = rendering_metrics(self.a)
        self.assertEqual(calls, [(1024, 768)])
        self.assertEqual(result['pixels'], 1024 * 768)

    def run_fixture(self, directory, names=('scene',), complete=True):
        directory.mkdir()
        for name in names:
            self.save(directory / (name + '.png'), Image.new('RGB', (20, 20), (10, 20, 30)))
        metadata = {'complete': complete, 'frames': [{'name': name, 'file': name + '.png'} for name in names],
            'stage': {'original': {'assets': {'sha256': 'a'}, 'exhibits': {'sha256': 'b'}}}}
        (directory / 'run.json').write_text(json.dumps(metadata))
        return directory

    def test_missing_frame_never_passes(self):
        a = self.run_fixture(self.root / 'baseline', ('one', 'two'))
        b = self.run_fixture(self.root / 'candidate', ('one',))
        self.assertFalse(compare_runs(a, b, self.root / 'out')['pass'])

    def test_incomplete_run_never_passes(self):
        a = self.run_fixture(self.root / 'baseline'); b = self.run_fixture(self.root / 'candidate', complete=False)
        result = compare_runs(a, b, self.root / 'out')
        self.assertFalse(result['pass']); self.assertIn('Incomplete browser run', result['environment_errors'])

    def test_repeat_at_later_time_must_remain_exact(self):
        names = ('scene-settled-0', 'scene-settled-500ms')
        a = self.run_fixture(self.root / 'baseline', names); b = self.run_fixture(self.root / 'candidate', names)
        picture = Image.open(a / (names[1] + '.png')); picture.putpixel((1, 1), (0, 0, 0)); picture.save(a / (names[1] + '.png'))
        result = compare_runs(a, b, self.root / 'out')
        self.assertFalse(result['pass'])
        self.assertTrue(any('unsettled' in value for value in result['environment_errors']))

    def test_environment_and_input_data_mismatch_fail(self):
        a = self.run_fixture(self.root / 'baseline'); b = self.run_fixture(self.root / 'candidate')
        metadata = json.loads((b / 'run.json').read_text()); metadata['browser_version'] = 'different'
        metadata['stage']['original']['assets']['sha256'] = 'changed'; (b / 'run.json').write_text(json.dumps(metadata))
        self.assertEqual(len(compare_runs(a, b, self.root / 'out')['environment_errors']), 2)

    def test_identical_pixels_cannot_hide_different_functional_state(self):
        a = self.run_fixture(self.root / 'baseline'); b = self.run_fixture(self.root / 'candidate')
        metadata = json.loads((b / 'run.json').read_text())
        metadata['frames'][0]['selected'] = 'another-exhibit'
        (b / 'run.json').write_text(json.dumps(metadata))
        result = compare_runs(a, b, self.root / 'out')
        self.assertFalse(result['pass'])
        self.assertEqual(result['frames'][0]['differing_pixels'], 0)
        self.assertEqual(result['frames'][0]['state_changes'], ['selected'])


if __name__ == '__main__':
    unittest.main()
