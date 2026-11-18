# Working on SPIN

SPIN (Spatial Information Navigator) is a 2D and 3D exhibit and service hub for any building. Use the configured files and geometry so another team can bring its own dataset.

## Repository and review

- `WebApp/` is the Git repository. Keep its root to `AGENTS.md`, `README.md`, `frontend/`, `backend/`, `tests/`, `.gitignore`, `.git/`, and `.github/`. Put development dependencies and generated test output under `tests/`. Document the public setup in `README.md`, the file formats in `backend/content-format.md`, and test commands in `tests/README.md`.
- Use Git for local changes and `gh` for GitHub. Start a new batch from up-to-date `main` on a short-lived branch. Keep related commits on the same branch so the user can test the full batch. Use plain, specific commit messages and preserve unrelated changes and history.
- Open a pull request into `main` when the batch is ready. Give the user the branch, commit, check results, and a short way to verify the changed behavior. If the commit changes after review, give them the new one. The user decides when to merge. GitHub deletes merged source branches automatically. Before pruning branches, verify their work was merged or that the user asked to discard it.
- Keep `CI / required` as the aggregate GitHub check. GitHub Actions is for validation. Keep packaging, release publication, deployment scripts, and server configuration outside the repository.

## Runtime and content

- Serve `frontend/` as the public document root. Keep PHP 8.1+ as the only server runtime and ship browser libraries, fonts, and icons locally so SPIN works offline on an intranet. Preserve ordinary HTTP with WebGL and WebGPU on supported origins. Node.js and Python are development tools.
- Keep the local `config.php` at the repository root. The tracked example stays in `backend/`. Keep site configuration and content out of Git. The PHP application must be able to run from a read-only code directory, including on Windows with Apache and FastCGI.
- `Assets/` and `Exponate/` are configurable directories outside `WebApp/`. Preserve the live copies, any installation configuration, and existing content when replacing app code. Use disposable synthetic data for changes and tests.
- Treat the files as the source of truth. Keep content understandable and editable in a file browser. Preserve the floor and exhibit naming and metadata contracts, Markdown notes with relative photo links, and Windows `.url` shortcuts with per-exhibit titles and deep links. Reuse the existing file validation, conflict checks, and safe write paths. Update the content reference when a format changes.
- Derive floors from signed integer folder names and exhibit identity from folder names. Allow arbitrary floor numbers and locales for display names. Discover exhibits without metadata and distinguish unplaced exhibits from their maintenance status. The floor and shared hardware libraries are managed through files. Keep grouping optional and derive it from the first hyphen in the exhibit folder name. Show the full name in the list and limit grouping to collapsible sections and filters.

## Interaction and rendering

- Keep drafts and Undo in the browser until the user explicitly posts or saves. Drafts should survive a reload in the same tab and clear with the tab session. Keep Save and Cancel together, preserve confirmation for destructive actions, and retain the signed structural Save and last-editor attribution.
- Keep exhibit transforms separate from component transforms. Preserve local coordinates and rotated axes across editing, saving, and reloading. Round editable and saved transform and camera coordinates to six decimal places. Keep a confirmed transform or join as one undoable edit before Save. A single-component exhibit opens its component controls directly.
- Keep the three-panel interface concise and use the existing Inter typography, icon mappings, German and English locale strings, and palette tokens. Preserve keyboard use, responsive layouts, accessible status text, and accommodation for reduced motion.
- Keep 2D as the default view and share the real floor geometry between 2D and 3D. Fit focus to the selection with the existing 2D and 3D framing behavior. The inspector overlays the canvas. Its spring follows an exhibit context change, and the list spring runs when the change originates in the list. Keep the inspector in place when switching components within the same exhibit or confirming its new name. Multiple selections use one interactive inspector with visual backing cards.

## Verification

- Run `node tests/check-source.mjs` for source checks. With the Python requirements installed, `npm --prefix tests test` also checks fixtures, the PHP transport, and the frame comparator. Use `npm --prefix tests run test:browser` for desktop and mobile interactions.
- Use generated data that covers different floor numbers, geometry, and filenames. Keep live content out of automated tests and screenshots. Check behavior in the running app for interaction or rendering changes. Use a fixed baseline and comparable conditions when claiming pixel or performance results. Report what was actually verified.
