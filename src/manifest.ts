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
const GUI_ASSETS = {
	'Source2Viewer.exe': 'win-x64',
} as const satisfies Record<string, string>;

type GuiFileName = keyof typeof GUI_ASSETS;

interface FileItem {
	name: string;
	digest?: string | null;
	size?: number;
	size_in_bytes?: number;
}

type GuiFile<T extends FileItem> = T & { name: GuiFileName };

interface ManifestAsset {
	name: string;
	url: string;
	size: number | null;
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

function parseDigest(digest: string | null | undefined): string | null {
	const [algorithm, hash] = digest?.split(':') ?? [];

	return algorithm === 'sha256' && hash ? hash.toLowerCase() : null;
}

function isGuiFileName(name: string): name is GuiFileName {
	return Object.hasOwn(GUI_ASSETS, name);
}

// GitHub lists newest first, so the first occurrence of a name wins.
function guiFiles<T extends FileItem>(items: T[]): GuiFile<T>[] {
	const seen = new Set<string>();

	return items.filter((item): item is GuiFile<T> => {
		if (!isGuiFileName(item.name) || seen.has(item.name)) {
			return false;
		}

		seen.add(item.name);

		return true;
	});
}

function collectAssets<T extends FileItem>(
	items: GuiFile<T>[],
	url: (item: T) => string,
): Record<string, ManifestAsset> {
	const assets: Record<string, ManifestAsset> = {};

	for (const item of items) {
		assets[GUI_ASSETS[item.name]] = {
			name: item.name,
			url: url(item),
			size: item.size ?? item.size_in_bytes ?? null,
			sha256: parseDigest(item.digest),
		};
	}

	return assets;
}

function buildStable(release: Release): StableChannel {
	return {
		version: release.tag_name.replace(/^v/, ''),
		date: release.published_at,
		releaseNotesUrl: release.html_url,
		assets: collectAssets(
			guiFiles(release.assets),
			(asset) => asset.browser_download_url,
		),
	};
}

function buildDev(
	run: WorkflowRun | null,
	artifacts: GuiFile<Artifact>[],
	origin: string,
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
		assets: collectAssets(artifacts, (artifact) => {
			const url = `${origin}/dev/${encodeURIComponent(artifact.name)}`;
			const digest = parseDigest(artifact.digest);

			return digest ? `${url}?sha256=${digest}` : url;
		}),
	};
}

// How many builds of each file stay downloadable after a newer one replaces them.
const KEPT_BUILDS = 5;

// Artifact ids stay out of the public manifest so they cannot be enumerated. Ids from the
// previous manifest are carried along for clients holding a slightly older one.
function collectArtifactIds(
	artifacts: Artifact[],
	previous: ArtifactIds | undefined,
): ArtifactIds {
	const ids: ArtifactIds = {};

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

// A dev channel failure must not take the stable channel down with it.
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

		return { run: null, artifacts: [] };
	}
}

export async function buildManifest(
	env: Env,
	origin: string,
	previousArtifactIds: ArtifactIds | undefined,
): Promise<{ manifest: Manifest; artifactIds: ArtifactIds }> {
	const [release, { run, artifacts }] = await Promise.all([
		getLatestRelease(env),
		loadDev(env),
	]);

	return {
		manifest: {
			stable: buildStable(release),
			dev: buildDev(run, artifacts, origin),
		},
		artifactIds: collectArtifactIds(artifacts, previousArtifactIds),
	};
}
