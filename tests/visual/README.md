# Browser frame regression gate

This suite executes the actual frontend modules, CSS, fonts, GLBs and unchanged production `frontend/api.php`. Playwright routes synthetic `http://localhost/` requests directly to staged static files and a GET-only PHP CLI bridge. It opens no HTTP listener. Localhost supplies a potentially trustworthy browser origin for WebGPU; every request is fulfilled before any network connection. Every run stages independent copies of source and data; input bytes and nanosecond content mtimes are fingerprinted before and after. No production file or original project content is changed.

**Execution status for this review:** the comparator, staging and PHP transport tests passed. Actual browser capture and baseline/candidate pixel equivalence have **not been established**. The shell rejected a local PHP listener with `Operation not permitted`, and the available Google Chrome process aborted during the initial Playwright launch with `SIGABRT`. No further launch or alternate-file workaround was attempted. See [execution-status.json](execution-status.json). A separate manual UI inspection of the existing original HTTP app is not a baseline/candidate regression run.

## Requirements

- Node.js 24+, PHP 8.1+, Python 3 with Pillow, Playwright or playwright-core, and a runnable Chromium/Chrome.
- Set `PLAYWRIGHT_MODULE` to an absolute Playwright package directory if normal package resolution cannot find it. `--browser` or `CHROME_PATH` selects a browser executable.
- Baseline is a frozen sibling layout: `BASELINE/WebApp`, `BASELINE/Assets`, `BASELINE/Exponate`. Candidate source is a separate checkout. The explicit `--data` tree supplies the data for both revisions. A custom `config.php` data root is redirected only in its disposable copy; the original settings and exact test-only override are recorded. Unrelated settings are preserved.

The immutable original revision is `0071aff11cc3b1accd3c893e69b1b0fb5df02062`, archived by the review owner at `/Users/nreigs/digitaltwin/ReviewBaseline`. Its complete application/data manifest is [baseline-fingerprint.json](baseline-fingerprint.json). The aggregate code SHA-256 is `a5777b541267f901e414dfbb2202eac79247052cd171d4c227e8452238c1ed44`. Metadata files are included; `.DS_Store` and runtime/cache directories are excluded. Data fingerprints include file mtimes because note correction timestamps depend on them.

## Commands

Normal environment:

```sh
python3 -m unittest discover -s tests/visual -p 'test_*.py' -v
node --test tests/visual/*.test.mjs
node tests/visual/suite.mjs \
  --baseline /Users/nreigs/digitaltwin/ReviewBaseline \
  --candidate /Users/nreigs/digitaltwin/WebApp \
  --data /Users/nreigs/digitaltwin/ReviewBaseline \
  --output tests/visual/artifacts/suite
```

The reviewed Mac has a bundled Node executable at `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` and Playwright at `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright-core`. These paths are optional fallbacks in the runner. The test suite must be run in an environment that permits browser processes; changing the executable path does not resolve a sandbox restriction.

For an individual run:

```sh
node tests/visual/run.mjs \
  --source /Users/nreigs/digitaltwin/ReviewBaseline/WebApp \
  --data /Users/nreigs/digitaltwin/ReviewBaseline \
  --profile source \
  --backend webgl \
  --output tests/visual/artifacts/baseline-a

python3 tests/visual/compare.py \
  tests/visual/artifacts/baseline-a \
  tests/visual/artifacts/candidate-a \
  --output tests/visual/artifacts/diff

python3 tests/visual/negative_control.py \
  tests/visual/artifacts/baseline-a \
  --output tests/visual/artifacts/negative-control
```

Use `--backend webgpu` for an additional separate WebGPU pass in a supported environment. WebGL is explicitly selected by default for deterministic SwiftShader rendering; fallback from the requested backend is an assertion failure. Both revisions must use the same backend and browser. Failure to render the requested 2D style also fails the run.

## State coverage

All rows below are **implemented scenarios, unexecuted in the restricted review environment**. Frames are full viewport screenshots, including the complete visible canvas. The suite never supplies screenshot masks.

| Area | Matched frames and functional assertions |
| --- | --- |
| Actual copied content | Fresh scenes in `thickness`, `height`, `shaded`; exact style/backend; 2D orthographic and 3D; selected exhibit and list hover; status menu; zoom, turn and keyboard pan |
| Settled rendering | Captures immediately after settling, then +500 ms and +2000 ms; later images must equal the first exactly within each run |
| Animated camera | Frozen page clock and exact +0, +64, +128, +256, +1256 ms selection and explicit-focus frames; distinct intermediate offsets and an exactly settled endpoint; orbit/pointer-pan frames and repeats |
| Menu and filter states | Filter popover, status listbox, app menu, search with no results, documentation/posts tabs; selection and checked/expanded state assertions |
| Edit inspector | Hardware picker, instance/group placement, draft position change, undo/redo value checks, translation gizmo, transform options/axis list, default view capture, signature-disabled state, rename/remove/delete dialogs, cancel and restore unsaved draft |
| Resizing | Inspector keyboard resize, 1100×780 viewport, return to 1440×1000; mobile 390×844 list/map/detail, status and app menus |
| Public accessibility page | Default and all four alternative palettes, checked radios, persisted mode, English switch; separate real map frames in every alternative palette |
| Test matrix profile | Three additional generated floors at 4×3, 24×18 and 150×90 units; collision-free IDs; all 2D styles and 3D on every scale; floor keyboard navigation, rapid switching, three statuses and multi-selection |
| Stale scene completion | Hold one real asset GET, switch back to a ready floor, release the superseded response, and require exact before/after pixels in the current scene |
| Content matrix profile | Deterministic formatted post and documentation; existing item menus, deletion dialogs, unsaved rich-text composer, composer status dropdown and signature; documentation editor |
| Renderer unavailable | `no3d` state with a visible map-status message and no canvas |

The `source` profile preserves the real dataset and selects an actual placed exhibit with hardware rather than relying on the first list row. It fails explicitly when no such source exhibit exists. The `matrix` profile adds explicit fixtures **only in disposable staged copies**. It generates self-contained seeded GLBs covering indexed closed geometry, an open non-indexed wedge, nested shared geometry with mirrored/non-uniform transforms, and a single-joint skinned mesh. All three statuses and all four hardware topologies appear on every generated floor. IDs and names avoid existing content, and positions/scales derive from generated floor dimensions rather than assumptions about the original building. The seed defaults to `271828`; `--seed` changes it consistently for all suite captures. Original and staged data fingerprints and the complete fixture manifest are recorded separately. Fixture bytes and timestamps repeat exactly for a given input and seed.

## Determinism and pass criteria

`run.mjs` fixes the browser version/executable, launch flags, software renderer, viewport, device scale, locale, timezone, language, color scheme, fresh localStorage and page clock. It waits for actual geometry readiness and fonts and advances real application callbacks at known clock intervals. It asserts the exact elapsed JavaScript clock on every advance and verifies that screenshot encoding leaves that clock frozen. Finite CSS transitions use the browser's compositor timeline, which the JavaScript clock does not control; the runner waits for those transitions to finish without advancing the application clock. No application render code is replaced. Browser console errors, page errors, failed requests, unexpected external requests, POSTs, empty/missing canvases, non-finite camera offsets and incorrect UI values fail the run. PHP temporary receipts are isolated so API pruning cannot affect unrelated requests.

`suite.mjs` captures baseline A/B and candidate A/B independently for both profiles, then requires:

1. Exact baseline repeatability.
2. Exact candidate repeatability.
3. Exact baseline-versus-candidate equality for every matching frame.
4. Exact temporal equality within each settled frame group.
5. A real captured-canvas one-pixel negative control fails comparison by exactly one pixel.

`compare.py` compares every RGBA channel, including antialiasing, at zero tolerance. It does not register images, exclude edges, ignore alpha, or permit global color/position drift. It fails missing frames, dimension/environment/input-data mismatches, incomplete runs, and canvases with insufficient color/foreground content. It writes per-frame counts, bounds, maximum delta, RMSE and magenta difference images. Those metrics report the failure; they do not relax it.

The passing synthetic controls change one RGB channel by one level in one pixel with unchanged alpha, change alpha alone, and apply a one-level global drift. The comparator was also exercised on actual manually captured original-app screenshots: the restored overview matches the first exactly across 2,250,000 pixels, and a one-channel-level change in one captured pixel fails by exactly one pixel. See [real-frame-comparator-validation.json](real-frame-comparator-validation.json). This establishes sensitivity and repeatability for that original state; optimized-build capture and the automated suite remain pending.

The comparator also rejects duplicate frame names, missing environment/clock/state metadata, unreadable screenshots, browser audit failures, staged fixture drift and mismatched functional state (selection, mode, camera, dialogs, open menus and layout), even when the screenshots contain identical pixels. Selection-camera assertions respect the application's contract: selecting a visible exhibit need not reframe it; a separate explicit perspective turn verifies camera movement.

All run artifacts are ignored by Git. Each `run.json` records source and data fingerprints, browser/environment information, requests, UI/canvas state, assertions, completion and failures. A failed/incomplete capture can never compare as passing. Screenshot access is limited to visual reviewers; source-only reviewers should receive scalar results and source-level findings.

## Separate browser memory profile

This profile is implemented and source-tested; it has **not been executed in a browser** in the restricted environment. Run the same command once per revision in a browser-permitted environment, changing `--source` and `--output`:

```sh
node tests/visual/run.mjs \
  --source /Users/nreigs/digitaltwin/ReviewBaselinePass2/WebApp \
  --data /Users/nreigs/digitaltwin/ReviewBaselinePass2 \
  --memory-only --memory-runs 3 --memory-cycles 5 \
  --output tests/visual/artifacts/memory-baseline
```

Memory sessions are separate from pixel captures. The runner holds the initial read-only snapshot response until the importmap is parsed, imports `MapView`, installs test-only prototype observation, and releases the response before the app constructs its map. It does not rewrite production HTML or modules. The observer keeps a weak reference to the map and returns scalar inventories; it does not retain old scenes or geometry arrays.

Each new context supplies a cold application scene, followed by warm selections, repeated floor rebuild/return cycles, a controlled superseded load, an edit and undo, viewport changes, renderer destruction, and document navigation. Samples include Chromium `Runtime.getHeapUsage` before/after explicit garbage collection, DOM counters, current scene/resource inventories, and actual `renderer.info.memory` geometry/texture counts. Unique CPU geometry buffer bytes include indexes, interleaved attributes and morph attributes. These are distinct measurements: CPU buffer bytes are not VRAM, renderer counters are not GPU byte sizes, and JavaScript heap is not total browser or operating-system RAM. The context is fresh; operating-system file caches are not flushed. No universal heap threshold or improvement claim is inferred from an unexecuted profile.

The source tests use the actual vendored `GLTFLoader` to parse every generated shape without network access. They also verify shared/interleaved buffer counting and superseded concurrent-build observation. This establishes fixture and instrumentation behavior in Node, not browser GPU measurements or visual equivalence.

## After project consolidation (12 November 2026)

There is one active application at `/Users/nreigs/Projects/digitaltwin/WebApp`.
The historical `ReviewBaseline` and `ReviewBaselinePass2` trees referenced above
are preserved inside `../../../Archive/digitaltwin-before-consolidation-2026-11-12.tar.gz`
(relative to this directory), under `digitaltwin unorganized/`. Extract them into
a separate temporary directory and supply those extracted paths when running the
historical comparison. Do not replace the active Assets or Exponate.

The transform UI now intentionally differs from the old pixel baselines. Current
transform implementation and manual interaction verification are recorded in
[transform-editing.md](../../docs/reviews/transform-editing.md). The historical
strict pixel and browser memory gates above retain their original status.
