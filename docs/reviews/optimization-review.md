# Optimization review

Baseline: `0071aff11cc3b1accd3c893e69b1b0fb5df02062` (12 November 2026).

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

## Status

Implementation and validation results are recorded here as the review completes. A browser restriction or an unexecuted test must be reported explicitly rather than represented as a pass.
