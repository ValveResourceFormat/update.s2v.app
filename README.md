# update.s2v.app

Cloudflare Worker that backs the Source 2 Viewer update checker and the dev build page on the website.

Dev builds are served from an R2 bucket, since downloading GitHub Actions artifacts is slow and needs a login.
When a push to master has built, the `publish-dev` job of the CI workflow calls `/v1/publish` with its OIDC token.
The worker verifies that the token belongs to a push build of master, copies that run's viewer artifact into the
bucket, and makes it the published dev build. It also combines the latest stable release and the published dev
build into a single manifest, so the GUI makes one request. The `update-manifest` job of the website workflow
calls `/v1/publish-stable` whenever a release is published, edited or deleted, and the worker stores the latest
release in the bucket, so serving the manifest does not depend on the GitHub API.

## Endpoints

| Path                                        | Description                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /v1/latest.json`                       | Latest stable release and published dev build, with per-platform assets |
| `GET /v1/dev/{sha256}/{name}-{build}.{ext}` | That file of a kept dev build, which is what the manifest links to      |
| `POST /v1/publish`                          | Publishes a build, called by the CI workflow                            |
| `POST /v1/publish-stable`                   | Stores the latest release, called by the release workflow               |

Both publish routes take the job's GitHub Actions OIDC token in the `Authorization` header. `/v1/publish` takes the
artifacts to publish as `{"artifactIds": [...]}`, from the run the token belongs to.

The published build and the one it replaced are kept, so a client holding the previous manifest can still download.

The edge caches the manifest for a day, and both publish routes purge it, so a publish shows up right away.

Only assets listed in `GUI_ASSETS` in `src/builds.ts` are included in the manifest. Adding a platform
means adding its file name and runtime identifier there, and uploading it from CI under that name with
`archive: false`.

Manifest fields are only ever added, never removed or renamed; a breaking change gets a new path prefix.

## Setup

Create an R2 bucket named `s2v-builds`, then:

```sh
npm install
npx wrangler secret put GITHUB_TOKEN
npm run deploy
```

The token is a fine-grained personal access token with read-only access to Actions on the repository.

The manifest answers 503 until a release has been stored. Run the Website workflow by hand after the first deploy
to store it.

## Local development

```sh
npm run dev
```

Serves on `http://localhost:8787` with a local bucket. Put `GITHUB_TOKEN=...` in a `.dev.vars` file to test
against GitHub locally.

`npm test` type-checks and lints. `worker-configuration.d.ts` holds the Workers runtime types and the `Env`
interface, generated from `wrangler.jsonc`. Run `npm run types` after changing the config or upgrading wrangler.
