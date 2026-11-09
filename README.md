# Digital twin

## Assets and exhibit folders

The building and its content live in two folders outside `WebApp/`: `Assets/` and `Exponate/`. Models, placement, statuses, saved views, posts and documentation links belong to these folders. There is no content database to export.

The paths are set by `assets_dir` and `exhibits_dir` in [config.php](config.php). By default, both folders sit beside `WebApp/`. Their root names and locations can change through that configuration; the names **inside** them must follow the structure below, including capitalization. If you replace `WebApp/`, keep these content folders and point the new configuration to them.

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

The 2D view cuts the floor model 1.1 metres above its main floor surface. Walls at that height are filled dark, overhead geometry is hidden, and furniture below the cut remains visible. Doorways appear as gaps where the model has an opening at the cut height. Add `cutHeight=1.4` to the app URL to try a different height in metres (0.2 to 4).

To compare styles, use `map2d=thickness` for material thickness, `map2d=height` for surface height and outlines, or `map2d=shaded` for the original lighting. Use `map2d=section` to return to the cut. All styles use the same model and saved views.

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

Export at the intended size, with one world unit representing one metre and Y as the vertical axis. The model's origin is its placement and rotation pivot. The app replaces imported mesh materials with its own floor, status and selection materials, so original model colors and textures do not control their appearance.

All floor and hardware GLBs have their surface normals recalculated on load with a **30° smoothing threshold**. Faces meeting below that angle shade smoothly together; sharper edges retain a visible crease. This overrides exported normals in the viewer and leaves the GLB files unchanged.

Exhibits instance these shared files. Several exhibits can use the same file, and one exhibit can contain several instances of it. Renaming or removing a hardware file also affects every exhibit that references that path.

### Exhibit folders

Every valid direct child folder of `Exponate/` becomes an exhibit, and **its folder name is its exhibit name**. There is no separate name or ID to enter in metadata. Renaming the folder changes its identity in the app and any saved links that select it by name.

An exhibit can contain:

| Item | Contents |
| --- | --- |
| `.exhibit.json` | Optional placement and status metadata. |
| `Notizen/` | Markdown posts. The folder keeps this name even though the interface calls them **Posts**. |
| `Fotos/` | Photos referenced from the Markdown posts. |
| `Links/` | Windows `.url` documentation shortcuts. |

These subfolders can be absent or empty. A folder without `.exhibit.json` still appears in the app, with status **Ok**, no assigned floor and no hardware. Its posts and links remain available.

Use names compatible with Windows: avoid `<>:"/\|?*`, control characters, names starting with a dot, names ending in a dot or space, and reserved names such as `CON` or `NUL`. Names are limited to 160 UTF-8 bytes, including a file's extension when applicable. Avoid names that differ only in capitalization so the same dataset can be moved between operating systems.

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

| Stored status | German label | English label |
| --- | --- | --- |
| `ok` | Ok | Ok |
| `problem` | Aufmerksamkeit nötig | Needs attention |
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

When supplying a transform, include all three arrays, each with exactly three finite numbers. Position and rotation components must lie between `-100000` and `100000`; scale components must be between `0.001` and `1000`. A missing instance transform uses identity. An invalid shared transform falls back to identity when reading, but an invalid instance transform causes that instance to be skipped. Invalid transforms cannot be saved through the app.

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
