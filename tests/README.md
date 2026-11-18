# Development and tests

Run commands from the repository root. Use Node.js 24, PHP 8.1+, and Python 3.13 for the full suite. Tests create disposable data and do not need a local SPIN configuration.

```sh
node tests/check-source.mjs
```

The source check runs JavaScript and PHP syntax checks, the unit tests in `unit/`, and the API and data contract tests in `php/`. It requires no npm or Python packages.

For the fixture, PHP transport, and screenshot comparator tests, install the Python requirements into a virtual environment and run the full suite.

```sh
python3 -m venv tests/.venv
source tests/.venv/bin/activate
python3 -m pip install -r tests/requirements.txt
npm --prefix tests test
```

On PowerShell, activate that environment with `. .\tests\.venv\Scripts\Activate.ps1`.

Run the browser smoke tests with Chromium.

```sh
cd tests
npm ci
npx playwright install chromium
npm run test:browser
```

The smoke tests use generated floor models and exercise desktop and mobile. Screenshots and request logs go to `tests/artifacts/browser/`. For optional screenshot comparisons and browser profiling, see [visual/README.md](visual/README.md).

GitHub runs these checks on pull requests, pushes to `main`, and merge queue entries. The `CI / required` check reports their combined result. Dependabot uses the pinned test dependencies in this folder.
