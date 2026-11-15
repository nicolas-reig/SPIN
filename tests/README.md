# Review verification

Run application syntax checks and source regression tests with Node.js 24+ and PHP 8.1+:

```sh
node tools/review-source.mjs
```

The runner checks the non-vendor application JavaScript and PHP, discovers `tests/unit/*.test.mjs` recursively, and runs PHP tests named `*.test.php`. A failed command stops the run. These tests use synthetic data and model objects; they do not open a browser or inspect the real content folders.

Screenshot capture and strict baseline/candidate image comparisons are a separate gate documented in [visual/README.md](visual/README.md). Passing source tests alone does not establish visual equivalence.

For the complete automated suite, install the development dependencies with
`npm ci` and `python3 -m pip install -r requirements-ci.txt`, then run `npm test`.
This also checks the visual harness and release packages. Every default test uses
disposable synthetic data; a clean checkout needs no `config.php` or content folders.
The frozen editor reference is stored in [fixtures/source-baseline](fixtures/source-baseline/README.md),
so shallow clones work without old Git objects.

`npx playwright install chromium` followed by `npm run test:browser` runs the
desktop/mobile smoke checks. See [the pipeline guide](../docs/deployment.md) for
GitHub triggers, release artifacts and installation instructions.
