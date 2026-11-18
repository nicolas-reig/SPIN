# SPIN — Spatial Information Navigator

SPIN is a web app for exploring a building and its exhibits in 2D and 3D. It brings together exhibit locations, hardware, service posts, photos, and documentation links.

[![CI](https://github.com/nicolas-reig/SPIN/actions/workflows/ci.yml/badge.svg)](https://github.com/nicolas-reig/SPIN/actions/workflows/ci.yml)

## Getting started

SPIN runs on PHP 8.1+ with JSON, fileinfo, and mbstring. The browser loads the JavaScript, fonts, and libraries included in `frontend/`, so the same app can run on an intranet without internet access.

1. Copy [`backend/config.example.php`](backend/config.example.php) to `backend/config.php`.
2. Set `assets_dir` and `exhibits_dir` to your content folders. The example expects `Assets/` and `Exponate/` beside `WebApp/`.
3. Run the local server from the repository root and open <http://127.0.0.1:8000>.

```sh
php -S 127.0.0.1:8000 -t frontend
```

For a shared installation, serve `frontend/` as the document root. Give PHP read access to both content folders and write access to the exhibit folder and PHP's temporary directory.

When updating an existing installation, keep its content and local configuration. SPIN still reads an existing root `config.php` when `backend/config.php` is absent. If you move a custom config into `backend/`, check any paths that use `__DIR__`.

## Working with SPIN

- [Content format](backend/content-format.md) covers floor models, exhibit metadata, Markdown posts, photos, and Windows shortcuts.
- [Development and tests](tests/README.md) covers local checks and the GitHub workflow. Node.js and Python are used for development and testing. The installed app runs on PHP alone.
