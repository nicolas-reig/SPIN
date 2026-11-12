# Transform editing checkpoint

Status: **in progress; the new helpers are not connected to the application UI.**

The user paused implementation to preserve a resumable checkpoint. The current
application keeps its existing selection, gizmos, shortcuts and inspector.
No asset or exhibit files have been changed.

## Requested result

- Place gizmos at the geometry center, including GLBs whose geometry is far
  from their placement origin. Use a shared middle pivot for multiple selections.
- Highlight selected exhibits blue. Only explicitly selected hardware is purple.
  Support selecting several hardware components, including Shift-click selection.
- Follow Blender's move, rotate, scale and combined transform gizmos and behavior.
  Preserve the application's axis colors, accessibility palettes and Y-up convention.
- Make G/R/S start modal transforms, with mouse movement, keyboard amounts,
  axis/plane constraints, local/global constraints, precision and snapping,
  confirmation and cancellation. Do not add a keyboard-value text field or overlay.
- Add the combined transform tool within the existing floating transform toolbar.
  Put small gray G/R/S marks at the bottom-right of the three tool icons.
- Use compact, vertically stacked, draggable numeric axis values in the existing
  inspector, following the supplied Blender reference. Keep direct text editing.
- Keep the current panels, floating islands, visual language, signed Save,
  undo/redo, draft recovery, joining, and data independence.

## Implemented groundwork

- `frontend/js/transform-math.js`: geometry centers, a median selection pivot,
  temporary transform transactions, world-to-parent conversion, local field
  previews, exact cancellation, and atomic rejection of unrepresentable shear.
  Geometry buffers and source model origins are never modified.
- `frontend/js/transform-input.js`: keyboard number state and a bounded numeric
  expression parser without evaluation of JavaScript. Supports decimals, sign,
  reciprocals, component cycling, basic arithmetic, units and math functions.
- `tests/unit/transform-editing.test.mjs`: synthetic geometry/pivot, parent-space,
  cancellation, resource preservation, shear and numeric-input coverage.

The current positive-scale file/API contract is intentionally still unchanged.
Negative and zero scales are not yet supported end to end. The decomposition
helper contains groundwork for collapsed axes, but validation still rejects them.

## Remaining implementation

1. Build a transform controller and Blender-style gizmo meshes in application
   source, without patching vendored Three.js. Include arrow/plane move handles,
   rotation rings/view rotation/trackball, scale handles and the combined mode.
   Size handles consistently on screen for orthographic and perspective cameras.
2. Attach the controller to temporary geometry-based pivots. Preview without
   changing `EditSession`; commit all affected transforms as one undo step.
   Restore the exact starting state on Esc, right-click, pointer cancellation,
   selection changes, floor changes and scene disposal.
3. Add explicit hardware selection independent of exhibit selection. Resolve map
   picks and inspector clicks, including Shift-click and selection across exhibits
   on the current floor. Keep exhibit joining an explicit exhibit action.
4. Change `MapView.highlight`, `setData`, `setTool`, `cancelTransform`, camera
   replacement and disposal to use the controller. Selected exhibits use
   `materials.selection`; explicitly selected hardware uses `materials.editSelection`.
5. Integrate modal G/R/S in the existing keyboard handler. The current handler
   only toggles the active tool; it must start a preview instead. Include Enter/LMB
   confirmation, Esc/RMB cancellation, X/Y/Z cycling global/local/unconstrained,
   Shift-axis plane exclusion, R/R trackball, Ctrl snapping, Shift precision,
   numeric component cycling and meaningful numeric error handling. Prevent the
   same gestures from panning the camera or accidentally changing selection.
6. Decide and implement signed/zero scale behavior consistently in frontend
   validation, PHP, tests, inspector limits and documentation. Blender mirroring
   and flattening require this; never silently approximate a sheared transform
   that the existing TRS metadata cannot represent. Handle singular parents clearly.
7. Rework `vectorFields` within existing inspector elements. Add draggable number
   behavior with one committed undo step, direct typing, keyboard accessibility,
   precision and cancellation. Add common transform fields for multiple selections.
8. Extend the existing toolbar with combined mode, corner shortcut marks, and
   local/global orientation inside its current options menu. Translate new help
   and error strings in both languages. Preserve alternative color palettes.
9. Persist and restore hardware selection and transform preferences in edit drafts;
   normalize selection after undo/redo, duplicate, remove, join, cancel and save.
10. Run source checks and interaction tests. Inspect the actual browser at desktop
    and mobile sizes when permitted. Verify displaced/rotated/mirrored GLBs,
    nonuniform parents, multiple selected components, camera modes, cancellation,
    undo/redo and signed save/reload. Do not claim exact Blender parity or completed
    visual acceptance before those cases are exercised.

## References and verification

- Blender gizmos: https://docs.blender.org/manual/en/4.5/editors/3dview/display/gizmo.html
- Axis locking: https://docs.blender.org/manual/en/4.5/scene_layout/object/editing/transform/control/axis_locking.html
- Numeric input: https://docs.blender.org/manual/en/4.5/scene_layout/object/editing/transform/control/numeric_input.html
- Precision: https://docs.blender.org/manual/en/4.5/scene_layout/object/editing/transform/control/precision.html
- Inspector reference: the user's attached screenshot in this conversation,
  `Captura de pantalla 2026-11-12 a las 13.53.00.png`.
- Source checks: `node tools/review-source.mjs`.

Verified at this checkpoint: **52 JavaScript tests and six PHP suites pass**,
including eight new transform-helper tests. Syntax checks pass for 28 application
JavaScript modules and seven PHP files. No browser interaction test was run for
these helpers because UI integration has not begun.

On the current Mac, Node is available at
`/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` and PHP at
`/opt/homebrew/bin/php`; include their directories in `PATH` to run the source
runner. No package installation is needed.

The earlier optimization review's browser frame acceptance and actual browser RAM
profile remain pending. This checkpoint does not resolve those earlier gates.
