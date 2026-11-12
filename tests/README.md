# Review verification

Run application syntax checks and source regression tests with Node.js 24+ and PHP 8.1+:

```sh
node tools/review-source.mjs
```

The runner checks the non-vendor application JavaScript and PHP, discovers `tests/unit/*.test.mjs` recursively, and runs PHP tests named `*.test.php`. A failed command stops the run. These tests use synthetic data and model objects; they do not open a browser or inspect the real content folders.

Screenshot capture and strict baseline/candidate image comparisons are a separate gate documented in [visual/README.md](visual/README.md). Passing source tests alone does not establish visual equivalence.
