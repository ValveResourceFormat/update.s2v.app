# update.s2v.app

Cloudflare Worker that backs the Source 2 Viewer update checker and the dev build download link on the website.

GitHub Actions artifacts cannot be downloaded without being logged in, so the worker holds a read-only token
and redirects to the short-lived signed URL that GitHub hands out. It also combines the latest stable release
and the latest dev build into a single manifest, so the GUI makes one request.

## Endpoints

| Path | Description |
| --- | --- |
| `GET /v1/latest.json` | Latest stable release and latest successful dev build, with per-platform assets |
| `GET /dev/{fileName}` | Redirects to the signed download URL of that file from the latest dev build |

Only assets listed in `GUI_ASSETS` in `src/manifest.js` are included in the manifest. Adding a platform
means adding its file name and runtime identifier there, and uploading it from CI under that name with
`archive: false`.

Manifest fields are only ever added, never removed or renamed; a breaking change gets a new path prefix.

## Setup

```sh
npm install
npx wrangler secret put GITHUB_TOKEN
npm run deploy
```

The token is a fine-grained personal access token with read-only access to Actions on the repository.

## Local development

```sh
npm run dev
```

Serves on `http://localhost:8787`. Put `GITHUB_TOKEN=...` in a `.dev.vars` file to test redirects locally.
