# Working on SPIN

`WebApp/` is the Git repository for SPIN, a file-based 2D and 3D exhibit service hub. Run repository commands from this directory. See [README.md](README.md) for installation and usage, the [content format](backend/content-format.md) for the file contract, and [Development and tests](tests/README.md) for test setup.

## Branches, commits, and pull requests

1. Check `git status` and preserve existing work. Use Git locally and `gh` for GitHub. Run `git fetch origin main` and start a new short-lived branch from `origin/main` for each task. Keep follow-up fixes for the same review on that branch. If a task depends on an unmerged change, identify that dependency in the pull request.
2. Commit by coherent, reviewable change. Use one commit for a small task and split larger tasks at boundaries that reviewers can understand and verify independently. Keep an implementation, its affected tests, and closely related documentation together. Fold incidental fixes into their logical change when safe. Use short, specific commit subjects.
3. Push the branch and open a pull request targeting `main`. Summarize what changed, give a short verification path, and report which checks ran. Keep `CI / required` green before merge. The repository owner decides when to merge.
4. Keep automatic source-branch deletion enabled on GitHub. After merge, verify that GitHub removed the source branch and prune its stale remote-tracking ref. Remove a local task branch only after verifying its work was merged. Preserve unmerged branches unless the user explicitly asks to discard them.

## Runtime and data contracts

- Keep `frontend/` as the public web root. Keep PHP 8.1+ as the server runtime and serve browser dependencies locally. Preserve ordinary HTTP with WebGL 2 and WebGPU on supported origins. Use Node.js and Python for development and tests. Keep development dependencies and generated test output under `tests/`. GitHub Actions validates changes. Packaging and deployment belong outside the repository.
- Keep the ignored local `config.php` at the repository root and the tracked example in `backend/`. Support a read-only application directory and configurable content directories outside it, including on Windows with Apache and FastCGI. Use disposable synthetic content for development and tests. Keep live config, content, and screenshots containing that data out of commits.
- Treat the content files as the source of truth. Preserve existing data compatibility and reuse the filename validation, revision checks, and locked file writes. Keep Markdown posts, exhibit-relative photo references, and Windows `.url` shortcuts editable by hand. Update the [content format reference](backend/content-format.md) when the file contract changes.
- Discover floors by canonical integer folder names and exhibits by folder name, including exhibits without metadata. Keep placement independent of service status. Manage the floor and shared hardware libraries on disk. Derive optional list groups from the first hyphen and display the full exhibit name. Keep grouping in list sections and filters.

## UI and editing

- Use the existing German and English strings, Inter typography, Lucide icons, and palette tokens. Preserve responsive navigation, keyboard access, status text, and reduced-motion behavior.
- Keep 2D as the default and use the same floor geometry in both map modes. Preserve camera focus on the selection. Use one interactive inspector for multiple selections, and keep it in place when stepping between components of the same exhibit or confirming a new exhibit's name. Keep inspector movement tied to exhibit context changes and list movement tied to changes that originate in the list.
- Keep drafts and Undo in the current browser session. Structural changes persist on signed Save and record the last editor. Keep Save and Cancel together and preserve confirmations for destructive changes. Standalone service status changes save immediately without a signature.
- Preserve the distinction between whole-exhibit and local component transforms, including rotated local axes after saving and reloading. Keep transform and camera values to at most six decimal places. Make each confirmed transform or join one undoable operation. A single-component exhibit opens its component controls directly.

## Tests and verification

- When a change intentionally alters behavior covered by a test, update the affected tests and fixtures in the same commit as the implementation. Preserve unrelated assertions and fix unintended regressions in the implementation. Add focused coverage when a new behavior or regression warrants it.
- Run `node tests/check-source.mjs` for JavaScript and PHP syntax, unit, and file-contract checks. With the Python test requirements installed, `npm --prefix tests test` also exercises the test fixtures, PHP transport, and screenshot comparator. Run `npm --prefix tests run test:browser` for desktop and mobile interaction changes with Chromium. See [test setup](tests/README.md).
- Use synthetic data with varied floor numbers, geometry, and filenames. Verify changes to interaction and rendering in the running app. Use comparable conditions and a fixed baseline for visual or performance claims. Report any checks you could not run.
