# Portability follow-up

The follow-up resolves the four outstanding source findings from the first pass. All application changes remain inside `WebApp/`; assets and exhibit/post folders remain configurable external data. No original content files were modified.

| Area | Delivered correction | Verification |
| --- | --- | --- |
| Camera geometry | Bounds-based framing considers height, aspect ratio and all eight corners. Orbit and clipping limits adapt to scene scale and requested views. | Tall, translated, large and miniature bounds; 4,800 deterministic corner projections. |
| Imported camera views | Valid distant, below-target, near-pole and exact-pole views preserve their requested coordinates and span. Exact vertical orientation no longer moves a narrow target offscreen. | Actual Three cameras and OrbitControls; mixed-scale close targets and cache invalidation regressions. |
| Metadata | Vectors must be three actual finite numbers in JSON arrays; object-shaped vectors and numeric strings are rejected consistently in files and API requests. | Transform and saved-view suites pass; both fail against the frozen pre-follow-up implementation. |
| Filenames | Discovery rejects surrounding whitespace, invalid UTF-8 and control characters without aliasing paths. Deliberate trimming of UI input remains. | Unicode, byte limits, reserved names, discovery and direct-access tests. The regression fails on the frozen implementation. |
| Post refresh | Changing a displayed correction/deletion timestamp invalidates the content tag without changing structural revisions or body hashes. Unix epoch remains valid. | Timestamp-only changes and unchanged plain-note timestamps; regression fails on the frozen implementation. |
| Installation | The PHP application runs from a renamed and relocated installation with development tooling absent and external executable calls disabled. Configured external roots can be renamed, moved and replaced. | Actual API reads, model delivery and structural saves; previous data and installed source hashes remain unchanged. This already passed on the frozen version and is now explicitly tested. |

Two source-only agents implemented the camera and backend changes, then independently reviewed each other's code. Neither accessed screenshots or actual content files. A third agent improved the verification harness.

## Final checks

- 44 JavaScript source tests and six PHP suites pass.
- 26 Python comparator/fixture tests and 12 Node transport, loader and profiling-instrumentation tests pass.
- 26 application JavaScript modules and seven application PHP files pass syntax checks; no whitespace errors were found.
- The model-memory regression still reports 64 loads reduced to one and 73,728 unique geometry-buffer bytes reduced to 1,152 for its synthetic repeated-model case. These remain geometry-buffer measurements, not total client RAM.

The follow-up therefore has **88 passing tests/suites**, with additional individual assertions and randomized cases inside those suites. The source baseline before this follow-up is commit `3d6c1a8`, preserved with data at `/Users/nreigs/digitaltwin/ReviewBaselinePass2`.

## Browser acceptance is still pending

The [frame suite](../../tests/visual/README.md) now generates seeded self-contained GLBs and collision-free floor/exhibit names instead of depending on floor `0`, particular model names or the current building's dimensions. It rejects missing/duplicate frames, missing metadata, state drift, audit failures and even one-pixel changes. Separate profiling records actual browser heap, unique CPU geometry bytes and renderer resource counts without treating them as equivalent measurements.

Neither the updated browser comparison nor the memory profile ran here: the session does not permit the required automated browser process, and permission escalation is disabled. No permission was bypassed. **Visual equivalence and total browser RAM improvement are not established.** The existing screenshots document only the original app.

Some camera differences are intentional bug fixes: formerly clipped tall/narrow/large scenes can reframe, and miniature scenes can use closer views. The comparator does not automatically waive those differences or hide them behind masks; they still require inspection when browser execution is available. GPU depth precision and Three's tiny pole-safety adjustment remain numerical limits, not a guarantee for every imaginable coordinate magnitude.
