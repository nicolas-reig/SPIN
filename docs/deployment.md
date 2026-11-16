# GitHub pipeline and installation

For the practical review-before-merge workflow, see
[the AI review guide](https://github.com/nicolas-reig/SPIN/blob/main/docs/review-workflow.md).

Every push to an active branch, pull request, merge queue entry and manual run starts
the [CI workflow](../.github/workflows/ci.yml). Branches under `preserved/` retain
historical snapshots and do not start push builds. No path filters skip required checks.

The pipeline runs these independent gates:

- Application syntax and source regressions with Node.js 24 and PHP 8.1, 8.3, 8.4 and 8.5.
- Python comparator/fixture tests and Node PHP transport/GLB tests using generated data.
- Chromium smoke tests of the real application, generated GLBs and PHP API at desktop
  and mobile sizes, with selection, search and the accessibility page. Screenshots and
  request audits remain available as build artifacts for seven days.
- Workflow linting and release contract tests, including deterministic packaging,
  manifest/checksum verification and an extracted installation running on PHP alone.

`CI / required` is the stable aggregate check for branch protection. It fails if any
gate fails or is skipped. Pull requests receive read-only credentials and never publish.
Actions are pinned to commit SHAs; Dependabot proposes weekly action updates and
monthly updates for development dependencies. Runtime files use vendored dependencies.

## Automatic delivery

After all gates pass on `main` or an explicit version tag, GitHub stores
`spin-<commit>.tar.gz` and its `.sha256` file as the `spin-<commit>` artifact for
14 days. Working branches and pull requests run the same checks without delivering
an installation package. Successful main-branch builds can be installed
directly from the repository's Actions page. Packaging uses the checked-out commit's
timestamp, sorted paths, fixed permissions and a stable gzip header, so the same
runtime bytes and commit produce the same archive.

Push a release tag such as `v1.0.0` to run every gate again and automatically publish
the same package and checksum as a GitHub Release. Tags must point to a commit on
`main`. Existing releases are never overwritten. Tags containing `-`, such as
`v1.1.0-rc.1`, create prereleases. Release publishing has its own narrowly scoped
write permission and runs only after the required CI check succeeds.

```sh
git tag v1.0.0
git push origin v1.0.0
```

Delivery currently ends at the verified GitHub package. Connecting a live server
requires its hosting address and update method; no server credentials are present
in the repository. GitHub Pages cannot run the PHP API.

## Install or update

1. Download the archive and matching checksum from a successful CI run or Release.
2. Verify them together: `shasum -a 256 -c spin-<commit>.tar.gz.sha256` (or
   `sha256sum -c` on Linux).
3. Extract into a new directory. The archive contains one `WebApp/` folder with
   `backend/`, `frontend/`, `config.example.php`, documentation and `RELEASE.json`.
4. Copy `config.example.php` to `config.php` for a new installation. For an update,
   copy the installation's existing `config.php`. Prefer absolute paths for external
   content when using versioned release directories.
5. Configure PHP 8.1+ with JSON, fileinfo and mbstring. Set the web server's document root to
   **`WebApp/frontend/`**. Backend files and configuration must remain outside the
   public document root. Give PHP write access to the configured exhibits folder
   and its temporary directory.
6. Check the homepage and `api.php` in the new installation, then switch the server
   to its `frontend/` folder. Keep the previous application directory for rollback.

`Assets/`, `Exponate/` and `config.php` are installation state. Releases exclude them,
along with tests, tools, Git metadata, review screenshots and development packages.
Application updates do not migrate or replace content. To roll back, point the web
server at the previous application directory with the same content configuration.

## Development checks

The installed app needs neither Node nor Python. Contributors use Node 24+, PHP 8.1+
and Python 3.13:

```sh
npm ci
python3 -m pip install -r requirements-ci.txt
npm test
npx playwright install chromium
npm run test:browser
npm run build
```

Run `node tools/review-source.mjs` for the source checks without installing npm or
Python dependencies. Release builds require committed runtime files and release
documentation. The generated archive stays under the ignored `dist/` directory.

Browser smoke checks verify current behavior; they do not compare against the old
pixel baselines. The historical full visual comparison remains documented in
[the visual review guide](../tests/visual/README.md).
