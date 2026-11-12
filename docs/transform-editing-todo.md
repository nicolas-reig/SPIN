# Transform editing — completed 12 November 2026

The UI groundwork from `d5cbeba` is now integrated. Application code owns the
controller and gizmo meshes; vendored Three.js was not changed.

## Delivered

- Geometry-centered move, rotation, scale and combined handles; multiple objects
  share the middle of their geometry centers. Perspective and orthographic
  handles retain their screen size. Original GLB geometry/origins are preserved.
- Exhibit selection is blue; explicitly selected hardware is purple. Shift-click
  selects hardware within or across exhibits on the current floor. Exhibit-list
  selection remains separate from hardware selection and explicit joining.
- Modal G/R/S previews, Enter/left-click confirmation and Esc/right-click
  cancellation; X/Y/Z global/local/unconstrained cycling, Shift-axis plane
  constraints, R/R trackball, numeric amounts, component cycling for move/scale,
  reciprocals, expressions/units, Ctrl snapping and Shift mouse precision.
- Atomic selection previews and one Undo operation per confirmed transform.
  Selection/floor/camera changes, pointer loss, window blur and disposal cancel
  previews. Numeric errors prevent confirmation; unrepresentable shear and
  singular parents are rejected without a partial write.
- Combined tool and gray G/R/S marks in the existing toolbar; local/global
  orientation and axis/snapping choices remain in its options menu.
- Compact stacked axis fields in the existing inspector; direct typing,
  Enter/Esc, horizontal dragging, precision, snapping, exact drag cancellation,
  shared fields and mixed values. Dragging mixed fields retains their offsets.
- Hardware selection and transform preferences round-trip with edit drafts.
  Selection is normalized after structural edits and history changes.
- Signed, zero and small scale values are supported by frontend validation,
  PHP reads/saves, inspector fields and documentation. A collapsed parent must be
  restored through its fields before its children can be transformed in space.
- Transform-only commits reuse loaded models. Returning to the installed layout
  during an outstanding replacement invalidates the obsolete load.
- Invalid GLBs no longer hide an otherwise usable floor. The current primary
  `Assets/HardwareModels/Display.glb` is an empty 132-byte export; it is preserved
  and skipped with a map warning. The floor and valid hardware remain visible.

## Verification completed

`node tools/review-source.mjs`: 31 application JavaScript modules and seven PHP
files pass syntax checks; **63 JavaScript tests and six PHP suites pass**. Tests
cover displaced geometry, shared buffers, group pivots, exact cancellation,
mirroring/flattening, global/local/plane constraints, numeric errors and recovery,
nonuniform/singular parents, real gizmo mesh picking, pointer confirmation,
precision/snapping, screen sizing, stale loads and signed-save contracts.

The actual app was checked through the browser at desktop and mobile layouts.
A disposable installation under `/private/tmp/digitaltwin-transform-acceptance`
used its own Assets and Exponate, including a generated floor and displaced,
rotated, mirrored GLB geometry. Browser checks exercised:

- G/X/2, Esc cancellation and one-step Undo.
- Multiple inspector hardware selections and Shift-click across exhibits.
- Group rotation (45°) and mirroring (-1); draggable Y values and one-step Undo.
- Draft reload/recovery retaining hardware selection and the selected tool.
- Direct typed zero scale, signed Save and browser reload; metadata on disk
  independently confirmed the signature, mirrored scale and zero scale.
- 3D editing with the numeric expression `2*3`, yielding a six-metre movement.
- Mobile inspector and map/toolbar navigation within the existing panels.

This is implementation and interaction verification, not a claim of complete
Blender parity or pixel equivalence to the previous UI. The older optimization
review's strict baseline pixel comparison and browser RAM profiling are separate
historical gates and have not been claimed as completed by this change.

## Project consolidation

The primary project is `/Users/nreigs/Projects/digitaltwin` with one active
`WebApp`, `Assets` and `Exponate`. All 119 pre-existing commits are retained,
including duplicate repository branch tips under `preserved/`. The full former
`digitaltwin unorganized` tree, including reference snapshots and older asset
versions, is preserved in the verified recovery archive under `../Archive`.
Every one of the 33 primary content files matches its pre-task SHA-256.

The application is available at http://127.0.0.1:8000 while its local server runs.

## Six-decimal precision update — 12 November 2026

All editable transform components and saved-camera position/target/span values
are rounded to at most six decimal places in the inspector, committed edits,
undo/redo, drafts, API reads and signed saves. Half values round away from zero;
negative zero and unnecessary trailing zeros are removed. Rendering calculations
retain their working precision; committed values use the shared precision rule.

Ten of eleven active metadata files required rounding. Their originals are in
`../Archive/coordinate-metadata-before-six-decimals-2026-11-12.tar.gz` relative
to WebApp. An audit verified 207 coordinate components and preserved all other
metadata values. This follow-up intentionally updates the placement metadata
that was preserved byte-for-byte during the original consolidation.

Verification: 67 JavaScript tests and seven PHP suites pass. The live inspector
shows six-decimal values, a typed nine-decimal coordinate rounds on Enter, and
Undo restores its starting value. The browser test change was not signed/saved.
