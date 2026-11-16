import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('build_release', ROOT / 'tools/build-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
REVISION = 'a' * 40


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='spin-release-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_reproducible_archive_manifest_and_checksum_exclude_local_state(self):
        a = release.build(ROOT, self.root / 'a', REVISION, 1234567890)
        b = release.build(ROOT, self.root / 'b', REVISION, 1234567890)
        self.assertEqual(a.read_bytes(), b.read_bytes())
        self.assertEqual(a.with_name(a.name + '.sha256').read_text().split()[0],
                         hashlib.sha256(a.read_bytes()).hexdigest())
        with tarfile.open(a) as archive:
            members = archive.getmembers()
            names = {member.name for member in members}
            for forbidden in ('config.php', '.git', 'tests', 'tools', 'node_modules', '.DS_Store'):
                self.assertFalse(any(forbidden in Path(name).parts for name in names), forbidden)
            self.assertIn('WebApp/frontend/vendor/three/LICENSE', names)
            self.assertIn('WebApp/config.example.php', names)
            manifest = json.load(archive.extractfile('WebApp/RELEASE.json'))
            self.assertEqual(manifest['revision'], REVISION)
            self.assertEqual(len(names), len(manifest['files']) + 1)
            for name, digest in manifest['files'].items():
                self.assertEqual(hashlib.sha256(archive.extractfile('WebApp/' + name).read()).hexdigest(), digest)
            self.assertTrue(all(member.isfile() and member.uid == 0 and member.mode == 0o644 for member in members))

    def test_packaged_application_reads_generated_data_with_php_alone(self):
        artifact = release.build(ROOT, self.root / 'output', REVISION, 1234567890)
        installation = self.root / 'installation'
        with tarfile.open(artifact) as archive:
            archive.extractall(installation, filter='data')
        app = installation / 'WebApp'
        (app / 'config.php').write_bytes((app / 'config.example.php').read_bytes())
        for name in ('Assets/Floors/17', 'Exponate/Packaged exhibit'):
            (installation / name).mkdir(parents=True)
        (installation / 'Exponate/Packaged exhibit/.exhibit.json').write_text(json.dumps({
            'floor': 17, 'status': 'problem', 'models': []
        }))
        runner = self.root / 'request.php'
        runner.write_text("<?php $_SERVER['REQUEST_METHOD']='GET'; $_GET=[]; require $argv[1];")
        result = subprocess.run(['php', '-d', 'display_errors=stderr', str(runner), str(app / 'frontend/api.php')],
                                text=True, capture_output=True, check=True)
        self.assertEqual(result.stderr, '')
        snapshot = json.loads(result.stdout)
        self.assertEqual([row['id'] for row in snapshot['floors']], ['17'])
        self.assertEqual(snapshot['exhibits'][0]['id'], 'Packaged exhibit')
        self.assertEqual(snapshot['exhibits'][0]['status'], 'problem')

    def test_symlinks_and_incomplete_installations_are_rejected(self):
        source = self.root / 'source'
        source.mkdir()
        for name in release.RELEASE_PATHS:
            target = source / name
            if name in ('frontend', 'backend'):
                target.mkdir()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('fixture')
        with self.assertRaisesRegex(ValueError, 'Incomplete installation'):
            release.build(source, self.root / 'output', REVISION, 0)
        (source / 'frontend/private.php').symlink_to(ROOT / 'config.example.php')
        with self.assertRaisesRegex(ValueError, 'Symbolic links'):
            release.build(source, self.root / 'output', REVISION, 0)

    def test_invalid_release_identity_is_rejected(self):
        for revision, epoch in [('main', 0), (REVISION, -1)]:
            with self.assertRaises(ValueError):
                release.build(ROOT, self.root, revision, epoch)

    def test_untracked_files_in_runtime_directories_are_not_shipped(self):
        source = self.root / 'source'
        for name in (*release.REQUIRED_FILES, 'frontend/local-secret.php', 'frontend/.env',
                     'README.md', 'docs/deployment.md'):
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('fixture')
        files = release.release_files(source, set(release.REQUIRED_FILES))
        self.assertEqual(set(files), set(release.REQUIRED_FILES))


if __name__ == '__main__':
    unittest.main()
