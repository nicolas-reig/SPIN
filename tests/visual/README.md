# Visual comparison and browser profiling

The optional visual suite compares the real application across two source revisions using independent copies of the same content. It routes browser requests to staged files and the PHP API through a read-only CLI bridge. See [test setup](../README.md) for required tooling.

## Compare two revisions

Prepare a frozen baseline containing `WebApp/`, `Assets/`, and `Exponate/`. Use a separate SPIN checkout as the candidate. Both revisions use the data you pass with `--data`. Use a dataset with at least one placed exhibit and hardware for the `source` profile.

```sh
node tests/visual/suite.mjs \
  --baseline /path/to/baseline \
  --candidate . \
  --data /path/to/frozen-data
```

The runner uses Playwright's installed Chromium by default. Pass `--browser` or set `CHROME_PATH` to use another executable. Set `PLAYWRIGHT_MODULE` if Playwright is installed outside the normal package resolution paths. Run separate passes with `--backend webgl` and `--backend webgpu` if you need to compare both renderers.

The suite captures each revision twice using both the original data and the `matrix` profile, which adds generated floors and hardware to the copies. It compares matched map, camera, inspector, menu, mobile, and accessibility states. It requires identical RGBA pixels within each repeated capture and across revisions. It also requires a one-pixel change to fail comparison. `run.json` records the input fingerprints, environment, state assertions, requests, and errors.

Intentional UI differences can fail the exact comparison. Review those differences separately and keep the baseline fixed during the review.

## Capture or profile one revision

```sh
node tests/visual/run.mjs \
  --source . \
  --data /path/to/frozen-data \
  --profile source \
  --output tests/artifacts/visual/candidate

node tests/visual/run.mjs \
  --source . \
  --data /path/to/frozen-data \
  --memory-only --memory-runs 3 --memory-cycles 5 \
  --output tests/artifacts/visual/memory
```

Use `compare.py BASELINE_RUN CANDIDATE_RUN --output OUTPUT` to compare two completed captures. The memory profile reports browser heap usage, unique CPU geometry bytes, and renderer resource counts separately. For a comparison, keep the browser, renderer, dataset, and run parameters fixed across revisions.
