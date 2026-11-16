# Working on SPIN

## Review before release

- For a new batch of changes, start from the latest clean `main` and create a
  `review/<short-name>` branch. Continue an existing review branch when the user
  asks to add changes to that same batch. Multiple commits belong in one branch
  when the user wants to test and approve them together.
- Preserve unrelated uncommitted work. Do not reset, overwrite or silently move
  the user's work to make a clean checkout.
- Commit and push work to the review branch, never directly to `main`.
- Open a pull request into `main` when the batch is ready. Include a short change
  summary, relevant automated checks and clear manual testing steps.
- Tell the user the branch and exact commit they should test. After further
  commits, explicitly say that the manual check needs to be repeated for the
  updated version. A clean checkout of that branch contains the complete batch.
- The user decides whether the application works and whether to merge. Do not
  mark their manual acceptance checkbox, merge, enable auto-merge, push release
  tags or deploy unless they explicitly ask for that action.
- Automated CI runs on branches and pull requests. The verified installation
  package is generated after passing CI on `main`, or for a version tag. Publishing
  a named GitHub Release is a separate, explicit version-tag action.

## Validation and installation state

- Run checks appropriate to the change. Source checks: `node tools/review-source.mjs`.
  With development dependencies installed, `npm test` adds harness and release
  checks; `npm run test:browser` runs the Chromium smoke checks.
- If local tooling is missing, report that limitation and use the GitHub CI
  results. Do not claim a test was run merely because its command exists.
- `config.php`, `Assets/` and `Exponate/` are local installation state. Preserve
  them; use disposable synthetic data for automated tests.
- Serve only `frontend/`. For manual local testing, use the existing development
  server or `php -S 127.0.0.1:8000 -t frontend` when that port is available.
  Editing through the app can change local content; use a separate content copy
  for destructive manual scenarios. Do not use the Windows production server as
  a test environment without an explicit request.

The practical user guide is [docs/review-workflow.md](docs/review-workflow.md).
