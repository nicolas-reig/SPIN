# SPIN — Spatial Information Navigator

[![CI](https://github.com/nicolas-reig/SPIN/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nicolas-reig/SPIN/actions/workflows/ci.yml)

SPIN is a file-based service hub for exploring a building and its exhibits in 2D and 3D. Find equipment on the map, track its service status, and keep maintenance posts, photos, and documentation links with the exhibit they belong to.

## Usage

SPIN needs PHP 8.1 or newer with JSON, fileinfo, and mbstring. Use a JavaScript-enabled browser with WebGPU or WebGL 2 for the map. Browser libraries, fonts, and icons are bundled so the app can run on an intranet without internet access. Documentation links still depend on access to their destinations.

1. Use **`frontend/` as the web document root**. Keep `backend/`, `config.php`, and both content directories outside the public root. Keep `frontend/` and `backend/` next to each other.
2. Copy [`backend/config.example.php`](backend/config.example.php) to **`config.php` at the repository root**, next to `frontend/`. Set `assets_dir` to the floor and hardware library and `exhibits_dir` to the exhibit folders. The sample points to sibling `Assets/` and `Exhibits/` directories. You can use other names and locations outside the repository.
3. Give the account running PHP read access to the application and both content directories, and write access to the exhibit directory and its contents and to PHP's temporary directory. For photo uploads, ensure PHP's upload and request limits accommodate the files your team uses. SPIN accepts up to eight JPEG, PNG, or WebP photos per post, up to 8 MiB per upload.

Open the app's address in your browser. SPIN is designed for a trusted intranet. Signatures record the name entered for attribution, and access control is handled by the deployment.

When updating the app, preserve your local `config.php`, `Assets/`, and `Exhibits/`. The two content directories hold the building model and service records, so back them up together.

### File structure

The sample configuration uses this layout. The floor and exhibit names below are examples.

```text
installation/
├── WebApp/
│   ├── frontend/             # Public HTML, CSS, JavaScript, API, and bundled libraries
│   ├── backend/              # PHP storage code, config template, and content reference
│   ├── config.php            # Local installation settings (ignored by Git)
│   ├── tests/                # Development dependencies, fixtures, and tests
│   ├── README.md
│   └── AGENTS.md
├── Assets/
│   ├── Floors/
│   │   ├── .floors.json       # Optional floor labels and camera presets
│   │   ├── -1/
│   │   │   └── model.glb
│   │   └── 0/
│   │       └── model.glb
│   └── HardwareModels/
│       └── Display.glb
└── Exhibits/
    └── Atrium-Display/
        ├── .exhibit.json     # Optional status, placement, hardware, and saved views
        ├── Notizen/          # UTF-8 Markdown posts
        ├── Fotos/            # Photos referenced by posts
        └── Links/            # Windows .url shortcuts to documentation
```

- **Assets.** Add a directory named with a whole floor number such as `-1`, `0`, or `1` beneath `Floors/`. Put its geometry in `model.glb`. Use `.floors.json` for German and English floor names and optional default views. Put reusable, self-contained GLB files directly in `HardwareModels/`. SPIN reads both libraries from disk, and multiple exhibits can reference the same hardware model.
- **Exhibits.** Each direct child of `Exhibits/` is an exhibit and takes its name from the folder. SPIN lists an exhibit even when it has no metadata or map placement. To appear on the map, an exhibit needs an existing floor assignment and at least one recognized hardware model. A prefix before the first hyphen adds an optional list group. For example, `Atrium-Display` appears under **Atrium** with its full name.

The [content format reference](backend/content-format.md) covers JSON fields and defaults, GLB export requirements, filename rules, and examples for Markdown, photos, and shortcuts.

## Using SPIN

### Browse and navigate

- **Find an exhibit.** Search by name, post text, or documentation title and URL. Filter by floor, **Unplaced**, group, or status. Expand or collapse groups in the exhibit list.
- **Explore the map.** Pick a floor and select an exhibit from the list or its hardware on the map. Switch between the default top-down **2D** view and the **3D** perspective. Pan, orbit, zoom, use the compass to return north-up, or use **Focus** to frame a selection. With the map focused, the arrow keys pan. Moving the elevation slider to the top switches to 2D. Share the page URL to open the same floor, map mode, and placed exhibit.
- **Choose your display.** Switch between German and English. Drag the inspector edge to resize it on desktop. On a narrow screen, use the navigation bar to switch between Exhibits, Map, and Details. Open **Settings** from the three-dot menu for the accessibility palettes, **Top Circle** exhibit markers in the 2D service view, and **Group labels** centered on prefix groups on the current floor. These preferences are stored in the browser.
- **Clear browser data.** Use **Settings → Clear browser data** to reset this site's browser settings, drafts, and accessible cookies and storage. On supported secure connections the browser also receives a request to remove its HTTP cache and protected cookies for the site. On plain HTTP, use the browser's site settings to remove data that the page cannot clear.

### Work with service records

| In the exhibit inspector | What you can do |
| --- | --- |
| **Status** | Choose **Ok**, **In progress**, or **Out of service**. Changes save immediately without a signature. Unplaced describes map placement and is independent of service status. |
| **Posts** | Write formatted maintenance notes and attach photos by choosing, pasting, or dropping files. Publish with a name and optionally update the exhibit's status with the post. Edits record the latest editor. Deleting a post leaves an attribution marker and keeps its photos on disk. |
| **Documentation** | Open, copy, add, edit, or remove links. The tab adds a search field when an exhibit has more than six links. Each link has a title, destination, and optional description. Destinations can include websites, network or local files, and applications, depending on the browser and device. |

Shift-click list entries or map models to select several exhibits. You can also turn on **Select** and tap exhibits individually. On a narrow screen, tap the selection count to open the inspector. **Posts** shows every selected exhibit's posts newest first, and **Documentation** lists their links alphabetically. Each item shows its source exhibit. Use **Post to all** or **Add to all** to add the same item to every selected exhibit. A batch draft reopens when you select the same exhibits again.

### Edit exhibits and placement

1. Open **Edit mode** from the exhibit list's options menu. Use the list to create, rename, duplicate, or delete an exhibit. Duplicating copies its hardware placement and saved views. Posts, photos, and links stay with the original.
2. Assign a floor and add hardware from the shared library. Use the inspector to replace, duplicate, or remove a component. Use numeric fields or the map tools to move, rotate, and scale components or whole exhibits. The toolbar offers local or global axes, axis constraints, and snapping. **G**, **R**, and **S** start transform previews, **Enter** confirms, and **Esc** cancels. Shift-click to select several exhibits or components for joint placement edits.
3. Under **Default views**, preview, capture, or reset an exhibit's 2D and 3D camera views. To combine exhibits, Shift-click their list entries, choose **Join**, and select the exhibit to keep. The join preserves hardware placement and consolidates contents on Save.
4. Use **Undo** or **Redo** while editing, **Cancel** to discard the structural draft, or **Save** and confirm your name to write the changes. Renaming changes the folder name, so bookmarks that select it need the new name. Deleting an exhibit removes its folder and contents when saved.

Post, link, and structural drafts stay in the current browser tab's session and can recover after a reload if browser storage is available. SPIN remembers the last successfully used signature for up to ten days.

## How it works

- **Storage and API.** [`frontend/api.php`](frontend/api.php) reads the local configuration and uses [`backend/Store.php`](backend/Store.php) to assemble a JSON snapshot from the files. The API also serves recognized GLBs and photos and handles writes. The files are the source of truth. There is no database. Structural edits update metadata and exhibit folders, while posts and links keep their own file formats.
- **Browser and map.** [`frontend/js/app.js`](frontend/js/app.js) coordinates the list, map, inspector, and edit session. Three.js uses the same GLB geometry for the orthographic 2D map and perspective 3D view. The 2D map normally uses outlines and thickness shading. Hardware instances share library geometry and have their own local transforms within the exhibit's placement. Camera framing uses saved presets when available and fits the geometry otherwise.
- **Refresh and saves.** A visible, idle tab checks for file changes about every 15 seconds. Reload after replacing a GLB to load the new geometry. PHP validates each save, serializes app writes for the installation, and checks revisions for conflicting changes. If a structural draft conflicts with a newer edit, the app lets you reconcile the changes before saving.
