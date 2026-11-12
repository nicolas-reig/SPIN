#!/usr/bin/env python3
import os
from pathlib import Path
import tempfile
import unittest
from fixture import fingerprint, stage_copy


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

    def test_original_absolute_config_paths_are_refused(self):
        (self.app / 'config.php').write_text("<?php return ['assets_dir'=>'/somewhere/Assets','exhibits_dir'=>'/somewhere/Exponate'];")
        with self.assertRaisesRegex(ValueError, 'refusing'):
            stage_copy(self.app, self.app.parent, 'source', self.root / 'staged')


if __name__ == '__main__':
    unittest.main()
