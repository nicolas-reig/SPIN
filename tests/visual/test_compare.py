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
        state = {'canvas': None, 'url': '/index.html', 'view': 'map', 'colorMode': 'default', 'selected': None,
                 'floor': '0', 'editing': False, 'viewport': {'width': 20, 'height': 20}, 'heading': None,
                 'openDialog': False, 'openMenus': 0, 'canvasState': {}, 'clock_frozen': True}
        metadata = {'complete': complete, 'frames': [{'name': name, 'file': name + '.png', **state} for name in names],
            'viewport': state['viewport'], 'device_scale_factor': 1, 'browser_version': 'test-browser',
            'browser_arguments': [], 'clock_epoch': '2026-11-12T12:00:00Z', 'profile': 'source', 'backend': 'webgl',
            'browser_executable': '/test/browser', 'playwright_version': 'test', 'environment': {'test': True},
            'stage': {phase: {'assets': {'sha256': 'a'}, 'exhibits': {'sha256': 'b'}} for phase in ('original', 'staged')}}
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

    def test_duplicate_frame_names_are_rejected_even_with_identical_pixels(self):
        a = self.run_fixture(self.root / 'baseline'); b = self.run_fixture(self.root / 'candidate')
        metadata = json.loads((b / 'run.json').read_text())
        metadata['frames'].append(metadata['frames'][0].copy())
        (b / 'run.json').write_text(json.dumps(metadata))
        result = compare_runs(a, b, self.root / 'out')
        self.assertFalse(result['pass'])
        self.assertIn('candidate duplicate frame names', result['environment_errors'])

    def test_missing_matching_metadata_cannot_make_two_runs_pass(self):
        a = self.run_fixture(self.root / 'baseline'); b = self.run_fixture(self.root / 'candidate')
        for directory in (a, b):
            metadata = json.loads((directory / 'run.json').read_text())
            del metadata['browser_version']; del metadata['frames'][0]['clock_frozen']
            (directory / 'run.json').write_text(json.dumps(metadata))
        result = compare_runs(a, b, self.root / 'out')
        self.assertFalse(result['pass'])
        self.assertTrue(any('missing environment metadata' in value for value in result['environment_errors']))
        self.assertTrue(any('clock was not verified' in value for value in result['environment_errors']))

    def test_same_pixels_with_a_different_open_menu_count_fail(self):
        a = self.run_fixture(self.root / 'baseline'); b = self.run_fixture(self.root / 'candidate')
        metadata = json.loads((b / 'run.json').read_text()); metadata['frames'][0]['openMenus'] = 1
        (b / 'run.json').write_text(json.dumps(metadata))
        result = compare_runs(a, b, self.root / 'out')
        self.assertFalse(result['pass']); self.assertEqual(result['frames'][0]['state_changes'], ['openMenus'])

    def test_missing_image_is_reported_as_failure(self):
        a = self.run_fixture(self.root / 'baseline'); b = self.run_fixture(self.root / 'candidate')
        (b / 'scene.png').unlink()
        result = compare_runs(a, b, self.root / 'out')
        self.assertFalse(result['pass']); self.assertEqual(result['frames'][0]['reason'], 'unreadable frame')

    def test_staged_fixture_content_and_browser_error_must_match(self):
        a = self.run_fixture(self.root / 'baseline'); b = self.run_fixture(self.root / 'candidate')
        metadata = json.loads((b / 'run.json').read_text()); metadata['stage']['staged']['assets']['sha256'] = 'different'
        metadata['contexts'] = [{'name': 'failed', 'blockedWrites': [], 'errors': [], 'pageErrors': ['render failed'], 'consoleErrors': []}]
        (b / 'run.json').write_text(json.dumps(metadata))
        result = compare_runs(a, b, self.root / 'out')
        self.assertFalse(result['pass'])
        self.assertIn('Input data mismatch: staged assets', result['environment_errors'])
        self.assertIn('candidate browser context failure: failed pageErrors', result['environment_errors'])


if __name__ == '__main__':
    unittest.main()
