#!/usr/bin/env python3
import os
from pathlib import Path
import tempfile
import unittest
from fixture import fingerprint, stage_copy
from glb_fixture import floor_glb, hardware_glb, inspect_glb


class StageIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / 'source' / 'WebApp'
        for folder in ('frontend', 'backend'):
            (self.app / folder).mkdir(parents=True)
        (self.app / 'frontend' / 'index.html').write_text('<title>fixture</title>')
        (self.app / 'backend' / 'Store.php').write_text('<?php')
        (self.app / 'config.php').write_text("<?php return ['assets_dir'=>dirname(__DIR__).'/Assets','exhibits_dir'=>dirname(__DIR__).'/Exponate'];")
        for name in ('Assets', 'Exponate'):
            folder = self.app.parent / name
            folder.mkdir()
            item = folder / 'content'
            item.write_bytes(b'real\x00bytes')
            os.utime(item, ns=(1700000000123456789, 1700000000123456789))

    def test_staged_bytes_and_nanosecond_mtimes_match(self):
        result = stage_copy(self.app, self.app.parent, 'source', self.root / 'staged')
        for key in ('code', 'assets', 'exhibits'):
            self.assertEqual(result['original'][key]['sha256'], result['staged'][key]['sha256'])
        self.assertEqual((Path(result['root']) / 'Exponate' / 'content').stat().st_mtime_ns, 1700000000123456789)

    def test_code_and_content_change_changes_fingerprint(self):
        before = fingerprint(self.app, self.app.parent)
        (self.app / 'frontend' / 'index.html').write_text('<title>changed</title>')
        self.assertNotEqual(fingerprint(self.app, self.app.parent)['code']['sha256'], before['code']['sha256'])

    def test_absolute_config_roots_are_redirected_only_in_the_disposable_copy(self):
        (self.app / 'config.php').write_text("<?php return ['assets_dir'=>'/somewhere/Assets','exhibits_dir'=>'/somewhere/Exponate','another_setting'=>42];")
        before = fingerprint(self.app, self.app.parent)
        result = stage_copy(self.app, self.app.parent, 'source', self.root / 'staged')
        self.assertEqual(set(result['config_overrides']), {'assets_dir', 'exhibits_dir'})
        self.assertEqual(result['config_overrides']['assets_dir']['source_value'], '/somewhere/Assets')
        self.assertEqual(fingerprint(self.app, self.app.parent)['code'], before['code'])
        self.assertNotEqual(result['original']['code']['sha256'], result['staged']['code']['sha256'])

    def test_missing_input_data_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Missing input directory'):
            fingerprint(self.app, self.root / 'missing')

    def test_matrix_has_no_floor_name_model_or_original_scale_assumptions(self):
        floors = self.app.parent / 'Assets' / 'Floors'
        for number in ('-1', '0', '1', '2', '100'):
            (floors / number).mkdir(parents=True)
            (floors / number / 'model.glb').write_bytes(b'original untouched')
        (self.app.parent / 'Exponate' / 'Visual ok floor 1').mkdir()
        before = fingerprint(self.app, self.app.parent)
        result = stage_copy(self.app, self.app.parent, 'matrix', self.root / 'staged')
        fixture = result['fixture']
        self.assertEqual([floor['id'] for floor in fixture['floors']], ['3', '4', '5'])
        self.assertEqual(len(fixture['hardware']), 4)
        self.assertEqual(len(fixture['exhibits']), 9)
        self.assertEqual(fixture['exhibits'][0]['id'], 'Visual ok floor 1 2')
        self.assertEqual(fingerprint(self.app, self.app.parent), before)
        for asset in [*fixture['floors'], *fixture['hardware']]:
            model = asset.get('model_id', asset.get('id'))
            inspect_glb((Path(result['root']) / 'Assets' / model).read_bytes())

    def test_matrix_seed_repeats_byte_for_byte_but_changes_randomized_geometry(self):
        a = stage_copy(self.app, self.app.parent, 'matrix', self.root / 'a', seed=17)
        b = stage_copy(self.app, self.app.parent, 'matrix', self.root / 'b', seed=17)
        c = stage_copy(self.app, self.app.parent, 'matrix', self.root / 'c', seed=18)
        for key in ('assets', 'exhibits'):
            self.assertEqual(a['staged'][key]['sha256'], b['staged'][key]['sha256'])
            self.assertNotEqual(a['staged'][key]['sha256'], c['staged'][key]['sha256'])


class SelfContainedGeometryTests(unittest.TestCase):
    def test_seeded_shapes_cover_indexed_open_shared_and_skinned_inputs(self):
        for shape in ('closed-indexed', 'wedge-open', 'nested-shared', 'skinned'):
            a, b = hardware_glb(42, shape), hardware_glb(43, shape)
            document = inspect_glb(a)
            self.assertNotEqual(a, b)
            self.assertEqual(a, hardware_glb(42, shape))
            primitive = document['meshes'][0]['primitives'][0]
            self.assertEqual('indices' in primitive, shape != 'wedge-open')
            self.assertEqual('skins' in document, shape == 'skinned')
            if shape == 'nested-shared':
                self.assertEqual(sum('mesh' in node for node in document['nodes']), 2)
                self.assertTrue(any(node.get('scale', [1])[0] < 0 for node in document['nodes']))

    def test_floor_scales_and_generated_container_are_valid(self):
        for width, depth in ((4, 3), (24, 18), (150, 90)):
            document = inspect_glb(floor_glb(7, width, depth))
            self.assertEqual(document['accessors'][0]['min'][0], -width / 2)
            self.assertEqual(document['accessors'][0]['max'][2], depth / 2)
        with self.assertRaises(ValueError):
            inspect_glb(hardware_glb(1, 'closed-indexed')[:-4])


if __name__ == '__main__':
    unittest.main()
