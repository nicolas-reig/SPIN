# Optimization review

Baseline: `0071aff11cc3b1accd3c893e69b1b0fb5df02062` (12 November 2026).

Follow-up: the four source findings listed at the end of this first-pass report have since been addressed. See [portability-followup.md](portability-followup.md) for the latest 88-test result and the still-pending browser acceptance gate.

## Review boundaries

| Reviewer | Scope | Evidence allowed |
| --- | --- | --- |
| Rendering | Model loading, scene structure, repeated geometry, canceled builds | Source and synthetic tests only |
| Application | Edit data modeling, snapshot allocations, refresh concurrency, bounded file reads | Source and synthetic tests only |
| Client memory | CPU/GPU resource ownership and disposal | Source and synthetic tests only |
| Data independence | Arbitrary floors, exhibits, geometry, models and transforms | Source and synthetic tests only |
| Frame verification | Matched baseline/candidate states, screenshots, pixel diffs and functional checks | Browser, screenshots and isolated test data |
| UI consistency | Menus, dialogs, panels and responsive layouts | Source and screenshots; report only |

The source reviewers do not receive screenshots, image diffs or the contents of the real asset and exhibit files. The integrator owns Git commits and accepts or rejects changes using both source review and verification evidence.

## Baseline and acceptance

The source baseline is an unmodified `git archive` of the commit above. Both content roots were copied before source modifications. The original application and its content folders remain separate from the review checkout.

Every visual comparison must use the same viewport, browser, renderer, device scale, data and interaction sequence. Capture multiple states rather than comparing a single home screen. Verify that rendered geometry is present, that the baseline is repeatable, and that changing real pixels fails the comparator. Never refresh the baseline to make a candidate pass. Any accepted visual difference needs a named bug, a narrowly defined expected region or state, and independent review.

Image equivalence supplements behavioral assertions; it does not prove behavior outside the exercised states. Synthetic tests must cover empty and nonzero-numbered floors, repeated models with independent transforms/materials, supported model variants, stale loads, scene replacement and resource release.

## Delivered changes

| Area | Change | Evidence |
| --- | --- | --- |
| Model structure | Reuse one immutable geometry template per unskinned asset within each scene build; retain separate object transforms and materials. Skinned models keep independent loads. | Actual `MapView` tests cover repeated, mirrored, morph and instanced models. |
| Model lifetime | Stop obsolete builds before normal recalculation; release late results, failed preprocessing, bitmaps, skeleton textures and instanced morph textures. Preserve materials and bitmap sources retained by supplemental Points/Lines. | Lifecycle, cancellation, failure and cross-build ownership tests. |
| Edit data model | Clone read-only floor/model collections once per edit session, index structural changes and omit read-only collections from persisted history. | Legacy/compact draft recovery, input isolation, undo/redo and baseline payload parity. |
| Application work | Skip post-text construction for empty searches; limit background refresh to one request and discard stale responses during editing or after a newer snapshot. | Delayed-response and filter regression tests. |
| File reads | Read only the accepted byte limit plus one before rejecting oversized posts and shortcuts. | Boundary tests and 128 MiB sparse files processed under a 32 MiB PHP memory limit. |

No UI styling or content files were patched. The original checkout remains at `0071aff`; changes are committed on `review/optimization-2026-11-12` in `/Users/nreigs/digitaltwin/WebApp`.

## Measured synthetic results

These are reproducible source-operation and allocation measurements, not total browser RAM or FPS measurements.

| Workload | Baseline/reference | Optimized | Result |
| --- | ---: | ---: | --- |
| 64 instances of one synthetic model: unique geometry buffers | 73,728 bytes | 1,152 bytes | 98.44% fewer geometry-buffer bytes; loads/smoothing 64 → 1 |
| Dirty check, 10,000 synthetic exhibits, median of five | 627.04 ms | 142.87 ms | 4.39× faster on the recorded run |
| Serialized history: 100 exhibits, 3,000 assets, 25 undo states | 15,852,609 bytes | 878,598 bytes | 94.46% smaller |

Run `node tests/benchmarks/edit-session.mjs` to reproduce the edit benchmark. The model test reports its buffer counts. Full structural exhibit snapshots remain in undo history; geometry sharing does not eliminate per-instance object/transform storage.

## Validation status

| Gate | Result |
| --- | --- |
| Application syntax | 25 JavaScript modules and seven PHP files pass. |
| Source regression tests | 34 Node tests pass, including 16 seeds × 50 arbitrary edit actions compared with the original implementation. |
| Backend byte limits | PHP bounded-read test passes. |
| Comparator/staging | 16 Python tests pass: RGB/alpha sensitivity, global drift, missing/incomplete frames, environment/state mismatches, blankness, metadata-preserving copies and bounded image serialization. |
| PHP/browser transport | Four Node tests pass, including the real production snapshot and GLB response bridge. Original-baseline PHP integration was also checked. |
| Actual original screenshots | 35 desktop/mobile screenshots captured. First/restored overview match exactly: zero differing pixels out of 2,250,000. A one-level RGB edit to one real captured pixel is detected. |
| Optimized-build frame comparison | **BLOCKED / NOT VERIFIED.** The environment rejects automated Chrome startup. No candidate frames were captured; visual equivalence is not established. |

The reusable [visual suite](../../tests/visual/README.md) implements independent baseline/candidate captures, exact pixel diffs, temporal repeats, functional assertions and negative controls. Its browser scenarios are source-audited and syntax-checked, but have not executed here. The strict comparator allows no masks or drift tolerance. Source tests and manually captured original screenshots do not substitute for the pending candidate gate.

The complete source/data baseline is preserved at `/Users/nreigs/digitaltwin/ReviewBaseline`, with a committed [fingerprint](../../tests/visual/baseline-fingerprint.json). Live Blender source/backup files changed externally during the session; exported GLBs, floor metadata and exhibit bytes remain consistent with the frozen data. The test suite uses the frozen copies.

## Remaining findings

The first independent source audit found no new dataset-specific names, floor counts or geometry exceptions. It identified fixed camera orbit/clipping bounds, permissive numeric-string/object-vector metadata reads, whitespace filename discovery and modification-time-only note date edits that did not invalidate refresh tags. Those four items were subsequently addressed in the [portability follow-up](portability-followup.md); they are retained here as first-pass history.

The [UI consistency report](ui-consistency/README.md) documents screenshot-backed findings separately. Conditional conflict, upload and correction states are not claimed as fully inspected.
