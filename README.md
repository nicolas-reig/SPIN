# SPIN — Spatial Information Navigator

SPIN is an interactive platform for exploring buildings and their exhibits in 2D and 3D, with easy access to information about their exhibits: Location, Hardware and a place to post updates and documentation for the exhibit.

## Assets and exhibit folders

The building and its content live in two folders outside `WebApp/`: `Assets/` and `Exponate/`. Models, placement, statuses, saved views, posts and documentation links belong to these folders. There is no content database to export.

For a new checkout, copy [config.example.php](config.example.php) to `config.php`. The local `config.php` is ignored by Git; keep it when updating an existing installation. The paths are set by `assets_dir` and `exhibits_dir` in that file. By default, both folders sit beside `WebApp/`. Their root names and locations can change through that configuration; the names **inside** them must follow the structure below, including capitalization. If you replace `WebApp/`, keep these content folders and point the new configuration to them.

This is an example layout, rather than a required set of exhibits:

```text
digitaltwin/
├── WebApp/
├── Assets/
│   ├── Floors/
│   │   ├── .floors.json
│   │   ├── -1/
│   │   │   └── model.glb
│   │   └── 0/
│   │       └── model.glb
│   └── HardwareModels/
│       ├── Display.glb
│       └── LED Wall.glb
└── Exponate/
    ├── Atrium Wall/
    │   ├── .exhibit.json
    │   ├── Notizen/
    │   │   └── Lea 05_10_2026 09.30.md
    │   ├── Fotos/
    │   │   └── Lea 05_10_2026 09.30.jpg
    │   └── Links/
    │       └── Wartungsanleitung.url
    └── Spare Displays/
        └── Notizen/
            └── Alex 06_10_2026 14.10.md
```

There are only two kinds of JSON metadata file to maintain:

| File | Purpose |
| --- | --- |
| [`Assets/Floors/.floors.json`](#floor-metadata-floorsjson) | Floor names in each language and optional default camera views. |
| [`Exponate/<exhibit name>/.exhibit.json`](#exhibit-metadata-exhibitjson) | One exhibit's floor, status, hardware instances, placement, default views and last structural editor. |

Both files are optional. Posts, photos and links are separate ordinary files, not JSON records. The leading dot is part of each metadata filename; enable hidden-file visibility in your file manager if needed.

### Assets: floors and shared hardware

#### Floor folders

Each direct child folder of `Assets/Floors/` represents a floor. Its name must be an integer in canonical form: `-2`, `-1`, `0`, `1`, `2`, and so on. Use `0`, not `+0` or `00`; use `1`, not `+1` or `01`. Names such as `EG`, `OG1` or `Basement` do not create floors. The app orders floors numerically.

Put the floor's 3D building model at **`Floors/<number>/model.glb`**. That filename is fixed. An integer folder is discovered even without a model; add `model.glb` to give it building geometry. Adding an entry to `.floors.json` alone does not create a floor.

The 2D view shows the floor model from above, with outlines and shading based on estimated material thickness and surface height. To compare styles, add `map2d=height` to the app URL for outlines and surface height, or `map2d=shaded` for the original lighting. Use `map2d=thickness` to return to the thickness view. These styles use the same model and saved views.

Floor placement is baked into the exported model. There is no supported floor `transform` field in `.floors.json`. The floor model and hardware library are maintained through files, rather than edited or uploaded in the app.

#### Floor metadata: `.floors.json`

This single file sits directly inside `Assets/Floors/`. Each key is an existing floor folder's number, written as a JSON string.

For names alone:

```json
{
    "-1": {
        "de": "UG",
        "en": "Basement"
    },
    "0": {
        "de": "EG",
        "en": "Ground floor"
    },
    "1": {
        "de": "OG1"
    }
}
```

In this example, floor `1` displays as `OG1` in German and `1` in English. A missing, empty or whitespace-only name falls back to the floor number **in that language**; it does not borrow the other language's name. Without `.floors.json`, all floors use their numbers.

Each floor entry accepts these fields:

| Field | Meaning | If omitted |
| --- | --- | --- |
| `de` | German display name. | The floor number. |
| `en` | English display name. | The floor number. |
| `views` | Optional `2D` and `3D` camera presets; see [saved views](#saved-views-2d-and-3d). | Automatic framing. |
| `lastEditedBy` | A name retained for compatibility with older floor metadata. Current app saves do not edit floors or update this field. | Empty. |

The reader also accepts a single string as an entry, such as `"0": "EG"`, and uses it for both languages. Use the object form above when maintaining bilingual names or saved views.

A floor entry with both default views looks like this:

```json
{
    "0": {
        "de": "EG",
        "en": "Ground floor",
        "views": {
            "2D": {
                "position": [0, 40, 0.00001],
                "target": [0, 0, 0],
                "span": 18
            },
            "3D": {
                "position": [24, 22, 32],
                "target": [0, 0, 0],
                "span": 18
            }
        }
    }
}
```

#### Hardware library

Place reusable hardware models directly inside **`Assets/HardwareModels/`**, for example `Display.glb`, `LED Wall.glb` or `Speaker.glb`. The filename without `.glb` becomes the library name. Subfolders are not scanned. No hardware-library JSON file is needed.

Use self-contained **binary glTF 2.0 (`.glb`)** files containing meshes. External buffers, external textures and required glTF extensions are rejected. `.gltf` and `.blend` files are not loaded; you may keep source files alongside the exported models.

Export at the intended size, with one world unit representing one metre and Y as the vertical axis. The model's origin defines its saved placement. Editing uses the geometry center as a temporary rotation and scale pivot, including models exported away from their origin. The source geometry is unchanged. The app replaces imported mesh materials with its own floor, status and selection materials, so original model colors and textures do not control their appearance.

All floor and hardware GLBs have their surface normals recalculated on load with a **30° smoothing threshold**. Faces meeting below that angle shade smoothly together; sharper edges retain a visible crease. This overrides exported normals in the viewer and leaves the GLB files unchanged.

Exhibits instance these shared files. Several exhibits can use the same file, and one exhibit can contain several instances of it. Renaming or removing a hardware file also affects every exhibit that references that path.

### Exhibit folders

Every valid direct child folder of `Exponate/` becomes an exhibit, and **its folder name is its exhibit name**. There is no separate name or ID to enter in metadata. Renaming the folder changes its identity in the app and any saved links that select it by name.

In edit mode, the pencil beside the exhibit title changes its name. The folder is renamed only after the signed Save; posts, photos and documentation links move with it. Until then, the change can be undone or canceled. Names must be unique, including capitalization differences.

Shift-click exhibits in edit mode to select several, then choose **Join** in the inspector. Choose which exhibit to keep; its name, status and default views are retained. Hardware keeps its placement, and the other exhibits' posts, photos, links and additional files move into the retained folder only after the signed Save. The other exhibit folders are then removed. Undo and Cancel remain available before saving.

Colliding dated filenames advance to the next available minute, keeping the usual naming format. Duplicate documentation titles receive ` (2)`, ` (3)` and so on before `.url`. Relative file references in Markdown are updated when files move or change name. The join adds no permanent metadata fields. Finish or discard the selected exhibits' unfinished browser drafts before joining. Hardware on different floors cannot be joined; transformations that would deform hardware through uneven shared scales are also rejected.

An exhibit can contain:

| Item | Contents |
| --- | --- |
| `.exhibit.json` | Optional placement and status metadata. |
| `Notizen/` | Markdown posts. The folder keeps this name even though the interface calls them **Posts**. |
| `Fotos/` | Photos referenced from the Markdown posts. |
| `Links/` | Windows `.url` documentation shortcuts. |

These subfolders can be absent or empty. A folder without `.exhibit.json` still appears in the app, with status **Ok**, no assigned floor and no hardware. Its posts and links remain available.

Use valid UTF-8 names compatible with Windows: avoid `<>:"/\|?*`, control characters (including DEL), surrounding whitespace, names starting with a dot, names ending in a dot, and reserved names such as `CON` or `NUL`. Names are limited to 160 UTF-8 bytes, including a file's extension when applicable. The reader skips noncanonical names rather than silently trimming them into a different path. Text entered through the app is still trimmed before a new name is validated. Avoid names that differ only in capitalization so the same dataset can be moved between operating systems.

#### Exhibit metadata: `.exhibit.json`

This file belongs **inside each exhibit folder**. A minimal placed exhibit can use:

```json
{
    "floor": 0,
    "models": [
        {
            "model": "HardwareModels/LED Wall.glb"
        }
    ]
}
```

This places one instance at the origin, with no rotation or scaling, and defaults its status to Ok. Adjust the placement to suit the building. The model path is relative to the configured **Assets root**, uses `/` separators and must match an existing library filename, including its capitalization.

The full supported structure is:

```json
{
    "floor": 0,
    "status": "ok",
    "transform": {
        "position": [4, 0, -6],
        "rotation": [0, 90, 0],
        "scale": [1, 1, 1]
    },
    "models": [
        {
            "model": "HardwareModels/LED Wall.glb",
            "transform": {
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1]
            }
        },
        {
            "model": "HardwareModels/Display.glb",
            "transform": {
                "position": [2, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1]
            }
        }
    ],
    "views": {
        "2D": {
            "position": [4, 20, -5.99999],
            "target": [4, 0, -6],
            "span": 5
        },
        "3D": {
            "position": [12, 8, 6],
            "target": [4, 1, -6],
            "span": 5
        }
    },
    "lastEditedBy": "Lea"
}
```

| Field | Meaning | If omitted |
| --- | --- | --- |
| `floor` | An existing floor number. Use a JSON integer, or `null` for no assignment. | No assigned floor. A reference to a missing floor also becomes unassigned. |
| `status` | `ok`, `problem` or `retired`; see the table below. | Ok. Unrecognized values also fall back to Ok. |
| `transform` | Shared placement applied to the whole exhibit. | Identity: no movement or rotation, scale 1. |
| `models` | Hardware instances, each with a `model` path and optional `transform`. | No hardware. |
| `views` | Optional `2D` and `3D` camera presets. | Automatic framing of the exhibit's hardware. |
| `lastEditedBy` | The name from the last signed structural Save in edit mode. It is a single attribution, not a history. Status changes do not update it. | Empty. |
| `createdAt` | Creation time in ISO 8601 format, recorded by the server when the app creates an exhibit. | Unknown age. Deleting the exhibit requires confirmation. |

Exhibit deletion is staged in edit mode and applied with the signed Save. An exhibit older than ten minutes, with an unknown creation time, or containing posts or links requires a warning confirmation. Saving removes its entire folder, including photos and other files. Undo or Cancel can restore a staged deletion before Save.

| Stored status | German label | English label |
| --- | --- | --- |
| `ok` | Ok | Ok |
| `problem` | In Bearbeitung | In progress |
| `retired` | Außer Betrieb | Out of service |

There is no stored `placed` flag. The app derives map placement from an existing floor assignment and at least one recognized hardware instance. A floor assignment alone does not put an exhibit on the map. Missing model references and instances with invalid transforms are skipped when reading; this can leave an exhibit unplaced. App saves require a floor for hardware instances and allow at most 100 instances per exhibit.

#### Placement: shared and per instance

Every transform has the same three arrays, in **`[x, y, z]`** order:

| Field | Units | Meaning |
| --- | --- | --- |
| `position` | Metres | X and Z lie on the floor plane; Y is height. |
| `rotation` | Degrees | Euler rotation about the X, Y and Z axes, using XYZ order. |
| `scale` | Multipliers | `[1, 1, 1]` keeps the exported size; `[2, 2, 2]` doubles it. |

The exhibit's `transform` moves, rotates and scales the entire group. Each instance's transform is **local to that group**, not another world placement. In the full example, the Display is two metres along the group's local X axis; the group's 90° rotation also rotates that offset. The original transforms inside the GLB remain part of the model.

When supplying a transform, include all three arrays, each with exactly three finite numbers. Position and rotation components must lie between `-100000` and `100000`; scale components must be between `-1000` and `1000`, inclusive. Negative values mirror an axis; zero flattens it. Hardware inside a zero-scaled exhibit cannot be transformed in world space until its parent scale is restored through the numeric fields. Operations that would introduce shear are rejected without changing any selected object. A missing instance transform uses identity. An invalid shared transform falls back to identity when reading, but an invalid instance transform causes that instance to be skipped. Invalid transforms cannot be saved through the app.

Transform components and saved-camera positions, targets and spans use **at most six decimal places** throughout inspector values, edit history, drafts, API responses and saved metadata. Values are rounded to the nearest millionth, with exact halves rounded away from zero. Unneeded trailing zeros and negative zero are omitted. The limit applies to whole exhibits and individual hardware. A saved camera must still have distinct position and target after rounding and a span of at least `0.000001`.

#### Transform controls in edit mode

Select an exhibit in the list to select all its hardware and transform its parent group. In edit mode, selected components and selected exhibit rows are purple. Unselected components within those selected exhibits use a darker, moderately saturated blue context material; other exhibits retain their neutral edit appearance. Select hardware on the map or with its inspector button to target individual components. Shift-click adds or removes components, including components belonging to different exhibits on the current floor; Shift-clicking a component after whole-exhibit selection removes that component from the selection. Joining remains an action for exhibits selected in the list. Standard mode retains blue selection highlights.

The existing toolbar offers Move, Rotate, Scale and a combined tool. Handles use the geometry center; several selected objects share a middle pivot. Local orientation is the default, so handles follow an object's retained rotation and subsequent movement follows its rotated axes. Global orientation remains available in the toolbar options. Rotating never bakes the turn into geometry or child placements: rotation stays in the selected object's transform, including mirrored and flattened objects, and survives saving, reloading and undo. Axis colors follow the active accessibility palette.

Press **G**, **R** or **S** to start a modal preview, then move the pointer or type an amount. Use X/Y/Z for an axis in the chosen orientation, repeat it to switch between Local and Global, and repeat again to release the constraint. Shift-X/Y/Z excludes that axis (a plane), using the same orientation cycle. Press R again during rotation for trackball rotation. Ctrl snaps movement to 1 metre, rotation to 15° and scale to 0.1; Shift gives finer mouse control. The toolbar Snap preference keeps snapping enabled.

During a constrained transform, a colored line extends along the active axis. Plane restrictions show both allowed axes and a faint plane through the shared pivot: **G → Shift-Y** previews the XZ plane. The guides follow the chosen Global/Local orientation and accessibility colors, and disappear when the transform ends or its constraint is released.

Type distances, angles in degrees or scale factors directly; Tab cycles numeric components. Minus toggles the sign and `/` toggles a reciprocal in simple input. `=` enables expressions such as `25cm+5mm` or `sqrt(9)`; Ctrl-= returns to simple input. Invalid or incomplete numbers cannot be confirmed. Enter or a left click confirms, while Esc or a right click restores the exact starting transforms. Cancel also occurs on pointer loss, window blur, selection/floor changes and camera replacement. Every confirmed selection transform is one Undo step.

The inspector uses one consistent layout with **Whole exhibit placement** above the hardware list. Selecting hardware opens its matching component parameters without moving the whole-exhibit section. Component positions are local to their owning exhibit. Opening the whole-exhibit menu does not change the selection; its absolute fields always move the parent group while preserving component placements. Clicking the owning exhibit in the list selects all its hardware again. Selection colors consistently identify selected hardware in purple and unselected siblings within those exhibits in muted blue.

For multiple component or exhibit selections, the same top menu temporarily becomes **Transform together**. **Move by** and **Rotate by** apply relative amounts in the chosen Global/Local orientation, using the same shared center as the gizmos. **Scale factor** resizes the selection uniformly. These action fields reset to zero (movement/rotation) or one (scale) after each confirmed change. Returning to a single selection restores the whole-exhibit menu and its existing absolute parameters. The hardware list stays in place, grouped by owning exhibit for selections spanning several exhibits. Every field identifies its owner, including when component indexes repeat across exhibits. Shared transforms require placed objects on the same floor. Joining selected exhibits remains an explicit collapsible action below placement.

Changing exhibits triggers the original right inspector slide (**R**). The original left-list twitch (**L**) accompanies that change only when the action originated from the left list or its edit controls. Viewport and inspector actions trigger R alone. Component changes within the same exhibit, renames and clicks on an already selected exhibit trigger neither animation. Both motions retain their original spring settings.

Multiple selected exhibits retain one interactive inspector with decorative backing cards, one per additional exhibit. Each new front panel arrives using R with its contents already populated. The previous panel's content, live field values and scroll position remain rendered underneath until covered; rapid additions retain the intervening panels too. Removing a top panel withdraws it with the same spring to reveal the updated inspector underneath. Temporary outgoing views are inert and hidden from assistive technology, and are released after the transition. Resting backing cards contain no controls, follow panel resizing, and are hidden in the full-width phone layout. Reduced motion settles the panels and cards immediately.

Click a value to type, or drag horizontally on the value or its axis label; Shift gives precision and Ctrl snaps. A drag previews changes and creates one Undo step on release; Esc cancels it. Hardware selection, orientation, axis and snapping preferences are retained with an unsaved edit draft. All changes remain local until the signed Save.

An empty or invalid GLB is skipped with a map warning so the remaining floor and hardware stay usable. Its source file and metadata are preserved.

#### Saved views: 2D and 3D

Floors and exhibits use the same `views` format, with the keys **`2D`** and **`3D`**. Either preset can be supplied independently. Omit a preset, or use `"views": {}`, to leave it automatic. Each preset contains only `position`, `target` and `span`; the key already identifies the camera type, so no `mode` field is needed.

Older files using `top` and `three` are still read as `2D` and `3D`. If both naming styles are present, the new key takes precedence. The old `mode` field is ignored. New app saves write only the new keys and omit `mode`; floor metadata is never rewritten automatically.

| Preset field | Meaning |
| --- | --- |
| `position` | Camera location in world coordinates, as `[x, y, z]` in metres. |
| `target` | World point the camera looks at and orbits around. |
| `span` | Positive framing value. In 2D it is half the visible vertical extent in metres: `span: 5` shows 10 metres vertically before further zooming. 3D requires this field too, but its apparent size depends on camera distance and perspective. |

`position` and `target` must be different, and each must contain three finite numbers with absolute values at most `100000`. `span` must be greater than zero and at most `100000`. For a 2D preset, put the camera above its target. The small Z offset in the examples keeps the viewing direction just clear of the vertical pole. Camera positions and targets are world coordinates; they are **not** transformed with an exhibit when its hardware moves.

The app ignores invalid individual presets and uses automatic framing instead. Selecting an exhibit that is outside the visible map uses its preset for the current mode, or calculates a view from its hardware if none is saved. The Focus control uses the same presets. Floor framing uses its saved view when available, otherwise the building bounds.

Automatic **Focus** searches camera directions around the selection, scores projected surface area and surface-direction information, then checks the best separated candidates for occlusion by hardware and the building. The information score is a lightweight approximation inspired by [viewpoint entropy](https://vccimaging.org/Publications/Vazquez2001VSU/Vazquez2001VSU.pdf). It favors readable broad faces, fits the complete selection with padding, and centers it in the clear map area between panels and floating controls. Camera motion follows the shortest orbit with smooth zoom; reduced motion applies the result immediately. Repeating Focus keeps an already suitable view stable.

**2D Focus** uses a separate bird’s-eye solver: it fits the horizontal footprint, searches for a useful heading for the available screen shape, and preserves the current heading when rotating would offer little improvement. Model height determines camera clearance rather than footprint zoom. In edit mode, Focus targets the selected hardware components or all selected exhibits together. A saved view still takes priority for a single whole exhibit; component and multiple selections use automatic framing.

The app calculates identifiers, revision hashes and content tags while reading files. Do not add `id`, `name`, `floorId`, `placed`, `revision`, `structureRevision`, `contentTag` or journal records to these JSON files. Structural saves rewrite `.exhibit.json` with the supported fields listed above; extra custom fields will not be preserved by that save.

### Posts, photos and documentation links

#### Markdown posts: `Notizen/`

Save each post as a UTF-8 Markdown file named:

```text
<author> DD_MM_YYYY HH.MM.md
```

For example, `Lea 05_10_2026 09.30.md` means Lea posted on 5 October 2026 at 09:30. The filename provides the author and creation date; there is no JSON sidecar or Markdown front matter to maintain. Dates and times in filenames use leading zeros and the Europe/Berlin timezone. The interface displays dates as `5/10/2026`.

Posts are sorted by the date in their filenames, newest first. Changing that date changes their displayed date and ordering. When the app encounters a filename collision for the same author, it chooses the next free minute, advancing the date too if necessary. It does not append a random suffix. When adding posts manually, choose an unused filename yourself. Other filename formats are supported for older data; use the format above for new files. Files with an unrecognized name or a body larger than 100,000 bytes are not shown.

A post's body can contain headings, bold, italics, lists, links and photos, for example:

```markdown
## Wartung abgeschlossen

Das Display wurde gereinigt und die **Helligkeit** geprüft.

1. Bild geprüft.
2. Verkabelung kontrolliert.

![Display nach der Wartung](../Fotos/Lea%2005_10_2026%2009.30.jpg)
```

An edit through the app retains the filename and replaces the body, adding a final comment such as `<!-- edited by Alex -->`. That comment identifies the latest editor; the file's modification time supplies the edit date. It is not a version history.

Deleting a post through the app retains its file but replaces its entire contents with:

```text
deleted by Alex
```

The app recognizes that exact form, with the actual signer's name and no brackets, as a deleted post. Original author and creation date remain in the filename. You can use the same marker when maintaining files manually. Removing the file altogether removes the post without retaining that attribution.

#### Photos: `Fotos/`

Store JPEG, PNG or WebP photos in the **same exhibit's** `Fotos/` folder. Link to them from posts using `../Fotos/<filename>`. Encode spaces as `%20` and other special characters as URL escapes, as in the example above. Use a simple filename without `..`. External image URLs and paths outside that exhibit's `Fotos/` folder are not rendered as post photos.

App uploads use the same author/date/minute naming convention as posts, with the appropriate image extension. Manually added photos can use any valid filename; the date convention is not required for the photo itself. Renaming a photo requires updating every Markdown reference to it. Deleting a post does not delete its photos, so remove unused files separately after checking that no other post references them.

#### Documentation shortcuts: `Links/`

Each link is a Windows-compatible **`.url` file**, named after its title. For example, `Wartungsanleitung.url` contains:

```ini
[InternetShortcut]
URL=https://nas.example.org/atrium/wartungsanleitung.pdf
Comment=Anleitung für Reinigung und Wartung.
```

`URL` is required; `Comment` is the optional description shown in the app. Keep the description on one line. No signature, date or extra JSON file is needed. Save as UTF-8; Windows UTF-16LE files with a byte-order mark are also read. App-created files use Windows line endings.

Titles must be unique within an exhibit, including when compared without regard to capitalization. Use the same valid filename rules as exhibit folders. Links are displayed alphabetically by title. Renaming the file changes its title; removing it removes the link. Files larger than 5,000 bytes, malformed shortcuts and invalid URLs are skipped.

HTTP/HTTPS URLs, file and NAS links, and application deep links are supported. A valid domain or IP address without a scheme is interpreted as HTTP: `nas.example.org/manual.pdf` becomes `http://nas.example.org/manual.pdf`. For a single-label intranet host, supply the scheme explicitly, such as `http://nas/manual.pdf`. Deep links need their scheme, such as `smb://nas.example.org/manuals` or `myapp://open/item`. Spaces in URLs must be encoded; embedded credentials and script/data schemes are rejected. Opening a file or application link still depends on the browser and the receiving computer having permission and a suitable handler.

The shortcut stores only a destination, not a copy of its document. The target can remain on a NAS, intranet server or external website.

### Maintaining the folders by hand

Save JSON as UTF-8 using double quotes, without comments or trailing commas. Invalid JSON in either metadata file prevents the dataset from loading; a missing file is safe and uses the defaults described above. Only the documented metadata files are read—adding another JSON file does not register new content. Symbolic links are not supported for content roots or recognized content files and folders.

Changes to posts, links and metadata are normally picked up within about 15 seconds while the app is visible and idle. Refreshing pauses during active editing, so finish or cancel the current edit before expecting external changes to appear. Reload the page after replacing a GLB to ensure the newly exported model is loaded.

When editing files outside the app, avoid saving over the same exhibit at the same time as someone saving in the app. App saves are serialized and check for conflicting changes, but a text editor does not participate in that locking. For metadata updates, saving to a temporary file and then renaming it over the original avoids exposing half-written JSON. Keep backups of both content roots; there is no separate journal or version history to recover removed content.
