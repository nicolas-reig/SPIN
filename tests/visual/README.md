# Browser frame regression gate

This suite executes the actual frontend modules, CSS, fonts, GLBs and unchanged production `frontend/api.php`. Playwright routes synthetic `http://localhost/` requests directly to staged static files and a GET-only PHP CLI bridge. It opens no HTTP listener. Localhost supplies a potentially trustworthy browser origin for WebGPU; every request is fulfilled before any network connection. Every run stages independent copies of source and data; input bytes and nanosecond content mtimes are fingerprinted before and after. No production file or original project content is changed.

**Execution status for this review:** the comparator, staging and PHP transport tests passed. Actual browser capture and baseline/candidate pixel equivalence have **not been established**. The shell rejected a local PHP listener with `Operation not permitted`, and the available Google Chrome process aborted during the initial Playwright launch with `SIGABRT`. No further launch or alternate-file workaround was attempted. See [execution-status.json](execution-status.json). A separate manual UI inspection of the existing original HTTP app is not a baseline/candidate regression run.

## Requirements

- Node.js 24+, PHP 8.1+, Python 3 with Pillow, Playwright or playwright-core, and a runnable Chromium/Chrome.
- Set `PLAYWRIGHT_MODULE` to an absolute Playwright package directory if normal package resolution cannot find it. `--browser` or `CHROME_PATH` selects a browser executable.
- Baseline is a frozen sibling layout: `BASELINE/WebApp`, `BASELINE/Assets`, `BASELINE/Exponate`. Candidate source is a separate checkout. Its `config.php` must resolve the sibling content directories; the staging utility refuses external data paths.

The immutable original revision is `0071aff11cc3b1accd3c893e69b1b0fb5df02062`, archived by the review owner at `/Users/nreigs/digitaltwin/ReviewBaseline`. Its complete application/data manifest is [baseline-fingerprint.json](baseline-fingerprint.json). The aggregate code SHA-256 is `a5777b541267f901e414dfbb2202eac79247052cd171d4c227e8452238c1ed44`. Metadata files are included; `.DS_Store` and runtime/cache directories are excluded. Data fingerprints include file mtimes because note correction timestamps depend on them.

## Commands

Normal environment:

```sh
python3 -m unittest discover -s tests/visual -p 'test_*.py' -v
node --test tests/visual/transport.test.mjs tests/visual/bridge-integration.test.mjs
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
| Animated camera | Frozen page clock and exact +0, +64, +128, +256, +1256 ms selection frames; camera offset changes and remains finite; orbit/pointer-pan frames and repeats |
| Menu and filter states | Filter popover, status listbox, app menu, search with no results, documentation/posts tabs; selection and checked/expanded state assertions |
| Edit inspector | Hardware picker, instance/group placement, draft position change, undo/redo value checks, translation gizmo, transform options/axis list, default view capture, signature-disabled state, rename/remove/delete dialogs, cancel and restore unsaved draft |
| Resizing | Inspector keyboard resize, 1100×780 viewport, return to 1440×1000; mobile 390×844 list/map/detail, status and app menus |
| Public accessibility page | Default and all four alternative palettes, checked radios, persisted mode, English switch; separate real map frames in every alternative palette |
| Test matrix profile | Two additional floors from the actual floor GLB, floor switching and keyboard navigation, rapid switch returning to floor 0, three statuses with repeated hardware models, multi-selection |
| Content matrix profile | Deterministic formatted post and documentation; existing item menus, deletion dialogs, unsaved rich-text composer, composer status dropdown and signature; documentation editor |
| Renderer unavailable | `no3d` state with a visible map-status message and no canvas |

The `source` profile preserves the real dataset. The `matrix` profile additionally creates explicit fixtures **only in disposable staged copies**, because the actual dataset has a single floor and all exhibits have status `ok`. Added floors reuse the real floor GLB; the generated exhibit statuses, placement, posts, links and fixed timestamps are identical for both revisions. The original content's fingerprint remains separately recorded.

## Determinism and pass criteria

`run.mjs` fixes the browser version/executable, launch flags, software renderer, viewport, device scale, locale, timezone, language, color scheme, fresh localStorage and page clock. It waits for actual geometry readiness and fonts, advances the real application animation callbacks at known clock intervals, and captures after settling. Screenshot encoding does not advance the paused app clock. No application render code is replaced. Browser console errors, page errors, failed requests, unexpected external requests, POSTs, empty/missing canvases, non-finite camera offsets and incorrect UI values fail the run. PHP temporary receipts are isolated so API pruning cannot affect unrelated requests.

`suite.mjs` captures baseline A/B and candidate A/B independently for both profiles, then requires:

1. Exact baseline repeatability.
2. Exact candidate repeatability.
3. Exact baseline-versus-candidate equality for every matching frame.
4. Exact temporal equality within each settled frame group.
5. A real captured-canvas one-pixel negative control fails comparison by exactly one pixel.

`compare.py` compares every RGBA channel, including antialiasing, at zero tolerance. It does not register images, exclude edges, ignore alpha, or permit global color/position drift. It fails missing frames, dimension/environment/input-data mismatches, incomplete runs, and canvases with insufficient color/foreground content. It writes per-frame counts, bounds, maximum delta, RMSE and magenta difference images. Those metrics report the failure; they do not relax it.

The passing synthetic controls change one RGB channel by one level in one pixel with unchanged alpha, change alpha alone, and apply a one-level global drift. The comparator was also exercised on actual manually captured original-app screenshots: the restored overview matches the first exactly across 2,250,000 pixels, and a one-channel-level change in one captured pixel fails by exactly one pixel. See [real-frame-comparator-validation.json](real-frame-comparator-validation.json). This establishes sensitivity and repeatability for that original state; optimized-build capture and the automated suite remain pending.

The comparator also rejects mismatched functional frame metadata (selection, mode, camera state, dialogs and layout), even when the screenshots happen to contain identical pixels. Selection-camera assertions respect the application's contract: selecting a visible exhibit need not reframe it; a separate explicit perspective turn verifies camera movement.

All run artifacts are ignored by Git. Each `run.json` records source and data fingerprints, browser/environment information, requests, UI/canvas state, assertions, completion and failures. A failed/incomplete capture can never compare as passing. Screenshot access is limited to visual reviewers; source-only reviewers should receive scalar results and source-level findings.
