import { errorMessage } from './errors.ts';
import {
	type Artifact,
	getLatestRelease,
	getLatestWorkflowRun,
	getRunArtifacts,
	type Release,
	type WorkflowRun,
} from './github.ts';

// Files the GUI knows how to install, mapped to their runtime identifier. Artifacts must be
// uploaded with archive: false so the artifact name and digest are those of the file itself.
const GUI_ASSETS = new Map([['Source2Viewer.exe', 'win-x64']]);

interface ManifestAsset {
	name: string;
	url: string;
	size: number;
	sha256: string | null;
}

interface StableChannel {
	version: string;
	date: string | null;
	releaseNotesUrl: string;
	assets: Record<string, ManifestAsset>;
}

interface DevChannel {
	buildNumber: number;
	commit: string;
	title: string;
	date: string;
	expiresAt: string | null;
	runUrl: string;
	assets: Record<string, ManifestAsset>;
}

interface Manifest {
	stable: StableChannel;
	dev: DevChannel | null;
}

interface ArtifactRef {
	id: number;
	sha256: string | null;
}

// Recent builds of each file name, newest first.
export type ArtifactIds = Record<string, ArtifactRef[]>;

// Anything but a well-formed sha256 is dropped, so a hash that made it into a download link is
// one the download route accepts.
function parseDigest(digest: string | null | undefined): string | null {
	return digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1] ?? null;
}

// GitHub lists newest first, so the first occurrence of a name wins.
function guiFiles<T extends { name: string }>(items: T[]): T[] {
	const seen = new Set<string>();

	return items.filter((item) => {
		if (!GUI_ASSETS.has(item.name) || seen.has(item.name)) {
			return false;
		}

		seen.add(item.name);

		return true;
	});
}

function collectAssets(files: ManifestAsset[]): Record<string, ManifestAsset> {
	const assets: Record<string, ManifestAsset> = {};

	for (const file of files) {
		const runtime = GUI_ASSETS.get(file.name);

		if (runtime) {
			assets[runtime] = file;
		}
	}

	return assets;
}

function buildStable(release: Release): StableChannel {
	return {
		version: release.tag_name.replace(/^v/, ''),
		date: release.published_at,
		releaseNotesUrl: release.html_url,
		assets: collectAssets(
			guiFiles(release.assets).map((asset) => ({
				name: asset.name,
				url: asset.browser_download_url,
				size: asset.size,
				sha256: parseDigest(asset.digest),
			})),
		),
	};
}

function buildDev(
	env: Env,
	run: WorkflowRun | null,
	artifacts: Artifact[],
): DevChannel | null {
	if (!run) {
		return null;
	}

	return {
		buildNumber: run.run_number,
		commit: run.head_sha,
		title: run.display_title,
		date: run.updated_at,
		expiresAt:
			artifacts
				.map((artifact) => artifact.expires_at)
				.filter((expiresAt) => expiresAt !== null)
				.sort()[0] ?? null,
		runUrl: run.html_url,
		// The hash pins the download to this build, so a manifest cached just before a newer
		// build landed still fetches the file it describes.
		assets: collectAssets(
			artifacts.map((artifact) => {
				const url = `${env.PUBLIC_ORIGIN}/v1/dev/${encodeURIComponent(artifact.name)}`;
				const sha256 = parseDigest(artifact.digest);

				return {
					name: artifact.name,
					url: sha256 ? `${url}?sha256=${sha256}` : url,
					size: artifact.size_in_bytes,
					sha256,
				};
			}),
		),
	};
}

// How many builds of each file stay downloadable after a newer one replaces them.
const KEPT_BUILDS = 5;

// Artifact ids stay out of the public manifest so they cannot be enumerated. Ids from the
// previous manifest are carried along for clients holding a slightly older one, including those
// of a file the newest build happens to lack.
function collectArtifactIds(
	artifacts: Artifact[],
	previous: ArtifactIds | undefined,
): ArtifactIds {
	const ids: ArtifactIds = { ...previous };

	for (const artifact of artifacts) {
		const current: ArtifactRef = {
			id: artifact.id,
			sha256: parseDigest(artifact.digest),
		};
		const older = (previous?.[artifact.name] ?? []).filter(
			(entry) => entry.id !== current.id,
		);

		ids[artifact.name] = [current, ...older].slice(0, KEPT_BUILDS);
	}

	return ids;
}

// A dev channel failure must not take the stable channel down with it. Null when it failed.
async function loadDev(env: Env) {
	try {
		const run = await getLatestWorkflowRun(env);
		const artifacts = run ? await getRunArtifacts(env, run.id) : [];

		return {
			run,
			artifacts: guiFiles(artifacts.filter((artifact) => !artifact.expired)),
		};
	} catch (error) {
		console.error(`Dev channel unavailable: ${errorMessage(error)}`);

		return null;
	}
}

export interface BuiltManifest {
	manifest: Manifest;
	artifactIds: ArtifactIds;
}

export async function buildManifest(
	env: Env,
	previous: BuiltManifest | undefined,
): Promise<BuiltManifest> {
	const [release, dev] = await Promise.all([
		getLatestRelease(env),
		loadDev(env),
	]);

	const stable = buildStable(release);

	// The previous dev channel outlives a failure, or its download links would die with it.
	if (!dev) {
		return {
			manifest: { stable, dev: previous?.manifest.dev ?? null },
			artifactIds: previous?.artifactIds ?? {},
		};
	}

	return {
		manifest: { stable, dev: buildDev(env, dev.run, dev.artifacts) },
		artifactIds: collectArtifactIds(dev.artifacts, previous?.artifactIds),
	};
}
