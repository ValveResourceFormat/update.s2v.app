// What the bucket holds, written by the publish routes in the shape the manifest serves:
// - stable.json, the stable channel. Its files stay on GitHub.
// - dev.json, the published dev channel and the one it replaced.
// - dev/, the files of those two dev builds, with the build number in their name. A name is never
//   reused, so the files are served as immutable.

export const STABLE_KEY = 'stable.json';
export const DEV_KEY = 'dev.json';
export const DEV_FILES_PREFIX = 'dev/';

export const DEV_FILE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Files the GUI knows how to install, mapped to their runtime identifier. Artifacts must be
// uploaded with archive: false so the artifact name and digest are those of the file itself.
export const GUI_ASSETS = new Map([['Source2Viewer.exe', 'win-x64']]);

// Shipped GUIs and the website's dev page read these, so fields are only ever added, never removed
// or renamed.

export interface ManifestAsset {
	name: string;
	url: string;
	size: number;
	sha256: string | null;
}

export interface StableChannel {
	version: string;
	date: string | null;
	releaseNotesUrl: string;
	assets: Record<string, ManifestAsset>;
}

export interface DevChannel {
	buildNumber: number;
	commit: string;
	title: string;
	date: string;
	runUrl: string;
	assets: Record<string, ManifestAsset>;
}

export interface DevRecord {
	current: DevChannel;
	// Kept for clients still holding a manifest from before the current build was published.
	previous: DevChannel | null;
}

// Source2Viewer.exe of build 7670 is stored as Source2Viewer-7670.exe.
export function numberedFileName(name: string, buildNumber: number): string {
	const dot = name.lastIndexOf('.');

	if (dot <= 0) {
		return `${name}-${buildNumber}`;
	}

	return `${name.slice(0, dot)}-${buildNumber}${name.slice(dot)}`;
}

export function devFileKeys(build: DevChannel): string[] {
	return Object.values(build.assets).map(
		(asset) =>
			`${DEV_FILES_PREFIX}${numberedFileName(asset.name, build.buildNumber)}`,
	);
}

export async function readJson<T>(env: Env, key: string): Promise<T | null> {
	const object = await env.BUILDS.get(key);

	return object ? object.json<T>() : null;
}

export async function writeJson(
	env: Env,
	key: string,
	value: unknown,
): Promise<void> {
	await env.BUILDS.put(key, JSON.stringify(value), {
		httpMetadata: { contentType: 'application/json' },
	});
}
