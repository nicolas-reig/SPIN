# UI consistency audit

Baseline: `0071aff`. Evidence: the original app at `http://127.0.0.1:8000/`, captured by the lead reviewer in IAB at desktop **1600 × 900** and mobile **390 × 844**. The independent visual assessment below inspected screenshots **02, 04, 13 and 15** and checked the relevant CSS and popover implementation. The larger capture inventory records states reached; it is not a claim that every conditional state received an independent visual assessment.

Two low-severity consistency issues are confirmed. This review documents them without UI changes.

| Finding | Impact and location | Screenshot evidence | Recommendation |
| --- | --- | --- | --- |
| **UI-01 · Low — select carets change alignment inside popovers.** In the filter menu, each caret follows its value instead of aligning at the right edge. The edit inspector's floor selector uses the right-aligned pattern. | Similar controls have different scan positions and affordances. `frontend/css/app.css:462` applies `.popover > button { justify-content: flex-start; }`, which is more specific than `.select-button { justify-content: space-between; }` at line 2187. This affects enhanced selects inside popovers. | [02 · filter selectors](screenshots/02-filter-menu.jpg), compared with [13 · inspector floor selector](screenshots/13-edit-inspector.jpg). | Exclude select buttons from the menu-item alignment rule, or give popover select buttons an explicit `space-between` rule. Check filter, draft-status and placement-option selectors together. |
| **UI-02 · Low — hardware library menu loses its compact inset when opened.** The hardware list has a visibly deeper inset than the application options menu. | Related action menus have inconsistent density. `.hardware-picker .popover` specifies `padding: 6px` at `frontend/css/app.css:2562`, but `openPopover()` in `frontend/js/select.js:38` moves the element under `body`. It preserves computed width, while the ancestor-dependent padding rule stops matching; generic `.popover` padding becomes **14px**. The app menu retains its independent `.app-menu-popover` class and **6px** inset. | [15 · hardware library](screenshots/15-hardware-library.jpg), compared with [04 · application options](screenshots/04-options-menu.jpg). | Give the hardware popover a stable component class and carry its padding rule on that class. Verify the open desktop and mobile menus after portaling. |

## Capture coverage

These are actual baseline screenshots supplied by the lead reviewer. Only the four frames identified above underpin the independently verified design findings.

| Surface or state reached | Evidence |
| --- | --- |
| Desktop overview, map and camera controls; final restored reading state | [01](screenshots/01-overview.jpg), [35](screenshots/35-restored-overview.jpg) |
| Filters, custom option list, application options | [02](screenshots/02-filter-menu.jpg), [03](screenshots/03-filter-select.jpg), [04](screenshots/04-options-menu.jpg) |
| Exhibit inspector, posts, status menu, expanded composer | [05](screenshots/05-exhibit-posts.jpg), [06](screenshots/06-status-menu.jpg), [07](screenshots/07-post-composer.jpg) |
| Documentation and link editor; nonempty draft options and status list | [09](screenshots/09-documentation.jpg), [10](screenshots/10-link-editor.jpg), [11](screenshots/11-post-draft-options.jpg), [12](screenshots/12-draft-status-select.jpg) |
| Edit inspector, transform options and hardware library | [13](screenshots/13-edit-inspector.jpg), [14](screenshots/14-transform-options.jpg), [15](screenshots/15-hardware-library.jpg) |
| Instance placement, shared placement, saved views, creation and save signature form | [16](screenshots/16-instance-placement.jpg), [17](screenshots/17-shared-placement.jpg), [18](screenshots/18-saved-views.jpg), [19](screenshots/19-create-panel.jpg), [20](screenshots/20-save-signature.jpg) |
| Mobile map, list, filter, details and options | [22](screenshots/22-mobile-overview.jpg), [23](screenshots/23-mobile-list.jpg), [24](screenshots/24-mobile-filter.jpg), [25](screenshots/25-mobile-details.jpg), [26](screenshots/26-mobile-options.jpg) |
| Mobile edit list, edit details and hardware menu | [27](screenshots/27-mobile-edit-list.jpg), [28](screenshots/28-mobile-edit-details.jpg), [29](screenshots/29-mobile-hardware-menu.jpg) |
| Exhibit deletion confirmation, multiselection/join and target list | [30](screenshots/30-delete-confirmation.jpg), [31](screenshots/31-multiselection.jpg), [32](screenshots/32-join-select.jpg) |
| Accessibility page, desktop and mobile | [33](screenshots/33-accessibility.jpg), [34](screenshots/34-mobile-accessibility.jpg) |

## Limits and follow-up observations

- [08](screenshots/08-composer-options.jpg) records the empty composer collapsing during an options interaction; it does **not** show an open menu. Compare with the nonempty draft menu in [11](screenshots/11-post-draft-options.jpg). This is an interaction observation requiring reproduction, not a confirmed design defect.
- [21](screenshots/21-discard-confirmation.jpg) shows an immediate discard/undo toast, despite its filename. It is **not** a confirmation modal or evidence of inconsistent dialog styling.
- Conditional conflict resolution, corrected/deleted post displays, photo upload/attachment states, rename, post deletion, documentation deletion and hardware removal dialogs were not captured. Hover/focus states, complete keyboard traversal, alternate palettes, English text, landscape and additional widths were not exhaustively verified.
- The lead reviewer reports that temporary drafts and staged creation were canceled, no original backend data was saved, and the final state returned to five exhibits with edit mode closed. Screenshot dimensions or outer padding are not treated as app layout defects.
