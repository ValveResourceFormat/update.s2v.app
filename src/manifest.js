import {
	getLatestRelease,
	getLatestWorkflowRun,
	getRunArtifacts,
} from './github.js';

// Release assets and workflow artifacts that the GUI knows how to install, keyed by file name.
// Artifacts must be uploaded with archive: false so that the artifact name is the file name
// and the digest is that of the file itself rather than of a zip wrapper.
const GUI_ASSETS = {
	'Source2Viewer.exe': 'win-x64',
};

function parseDigest(digest) {
	const [algorithm, hash] = digest?.split(':') ?? [];

	return algorithm === 'sha256' && hash ? hash.toLowerCase() : null;
}

// Keeps the GUI files only, and the first occurrence of each name since GitHub lists newest first.
function guiFiles(items) {
	const seen = new Set();

	return items.filter((item) => {
		if (!Object.hasOwn(GUI_ASSETS, item.name) || seen.has(item.name)) {
			return false;
		}

		seen.add(item.name);

		return true;
	});
}

function collectAssets(items, url) {
	const assets = {};

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

function buildStable(release) {
	let version = release.tag_name ?? '';

	if (version.startsWith('v')) {
		version = version.slice(1);
	}

	return {
		version,
		date: release.published_at ?? null,
		releaseNotesUrl: release.html_url ?? null,
		assets: collectAssets(
			guiFiles(release.assets ?? []),
			(asset) => asset.browser_download_url,
		),
	};
}

function buildDev(run, artifacts, origin) {
	if (!run) {
		return null;
	}

	return {
		buildNumber: run.run_number,
		commit: run.head_sha,
		title: run.display_title ?? null,
		date: run.updated_at ?? run.created_at ?? null,
		expiresAt:
			artifacts
				.map((artifact) => artifact.expires_at)
				.filter(Boolean)
				.sort()[0] ?? null,
		runUrl: run.html_url ?? null,
		assets: collectAssets(
			artifacts,
			(artifact) => `${origin}/dev/${encodeURIComponent(artifact.name)}`,
		),
	};
}

// The dev channel comes from endpoints unrelated to the release, so it degrades to nothing
// on its own rather than taking the stable channel down with it.
async function loadDev(env) {
	try {
		const run = await getLatestWorkflowRun(env);
		const artifacts = run ? await getRunArtifacts(env, run.id) : [];

		return {
			run,
			artifacts: guiFiles(artifacts.filter((artifact) => !artifact.expired)),
		};
	} catch (error) {
		console.error(`Dev channel unavailable: ${error?.message ?? error}`);

		return { run: null, artifacts: [] };
	}
}

export async function buildManifest(env, origin) {
	const [release, { run, artifacts }] = await Promise.all([
		getLatestRelease(env),
		loadDev(env),
	]);

	return {
		manifest: {
			stable: buildStable(release),
			dev: buildDev(run, artifacts, origin),
		},
		// Artifact ids are kept out of the public manifest so that they cannot be enumerated;
		// the redirect route resolves a file name through this map instead.
		artifactIds: Object.fromEntries(
			artifacts.map((artifact) => [artifact.name, artifact.id]),
		),
	};
}
