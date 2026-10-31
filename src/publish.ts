// Fills the bucket: the GUI files of a finished build, and the latest release when one changes.

import {
	DEV_FILE_CACHE_CONTROL,
	DEV_FILES_PREFIX,
	DEV_KEY,
	DEV_PATH,
	type DevChannel,
	type DevRecord,
	devFileKeys,
	devFilePath,
	GUI_ASSETS,
	type ManifestAsset,
	numberedFileName,
	readJson,
	STABLE_KEY,
	type StableChannel,
	writeJson,
} from './builds.ts';
import { errorMessage } from './errors.ts';
import {
	type Artifact,
	getArtifactDownloadUrl,
	getLatestRelease,
	getRunArtifacts,
	getWorkflowRun,
} from './github.ts';
import type { TrustedRun } from './oidc.ts';

// Null for anything but a well-formed sha256.
function parseDigest(digest: string | null | undefined): string | null {
	return digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1] ?? null;
}

async function copyArtifact(
	env: Env,
	artifact: Artifact,
	buildNumber: number,
): Promise<ManifestAsset> {
	const sha256 = parseDigest(artifact.digest);

	if (sha256 === null) {
		throw new Error(`Artifact ${artifact.name} has no sha256`);
	}

	// The signed URL is only valid for a minute, so it is requested right before the copy.
	const url = await getArtifactDownloadUrl(env, artifact.id);
	const response = await fetch(url);

	if (!response.ok || response.body === null) {
		await response.body?.cancel();

		throw new Error(
			`Artifact ${artifact.name} download returned ${response.status}`,
		);
	}

	const fileName = numberedFileName(artifact.name, buildNumber);
	const path = devFilePath(sha256, artifact.name, buildNumber);

	// R2 checks the hash, so a truncated or altered download fails instead of being published.
	const object = await env.BUILDS.put(
		`${DEV_FILES_PREFIX}${path}`,
		response.body,
		{
			sha256,
			httpMetadata: {
				contentType: 'application/octet-stream',
				contentDisposition: `attachment; filename="${fileName}"`,
				cacheControl: DEV_FILE_CACHE_CONTROL,
			},
		},
	);

	if (object === null) {
		throw new Error(`Storing ${fileName} failed`);
	}

	return {
		name: artifact.name,
		url: `${env.PUBLIC_ORIGIN}${DEV_PATH}${path}`,
		size: object.size,
		sha256,
	};
}

// The artifact ids come from the job that built the files, so an artifact another job of the run
// uploaded under the same name is never published.
export async function publishDevBuild(
	env: Env,
	{ runId, runNumber }: TrustedRun,
	artifactIds: number[],
): Promise<string> {
	const record = await readJson<DevRecord>(env, DEV_KEY);
	const publishedBuild = record?.current.buildNumber ?? 0;

	// A re-run of an older build must not replace a newer one, and a re-run of the published build
	// must not replace its files, which are served as immutable.
	if (runNumber <= publishedBuild) {
		return `Build ${publishedBuild} is already published, leaving it in place of ${runNumber}`;
	}

	const [run, artifacts] = await Promise.all([
		getWorkflowRun(env, runId),
		getRunArtifacts(env, runId),
	]);
	const assets: Record<string, ManifestAsset> = {};

	for (const artifactId of artifactIds) {
		const artifact = artifacts.find((candidate) => candidate.id === artifactId);

		if (artifact === undefined) {
			throw new Error(`Run ${runId} has no artifact ${artifactId}`);
		}

		const runtime = GUI_ASSETS.get(artifact.name);

		if (runtime === undefined) {
			throw new Error(`Artifact ${artifact.name} is not a GUI file`);
		}

		if (assets[runtime] !== undefined) {
			throw new Error(`Artifact ${artifact.name} was given more than once`);
		}

		assets[runtime] = await copyArtifact(env, artifact, runNumber);
	}

	for (const [name, runtime] of GUI_ASSETS) {
		if (assets[runtime] === undefined) {
			throw new Error(`Run ${runId} has no ${name} artifact`);
		}
	}

	const current: DevChannel = {
		buildNumber: runNumber,
		commit: run.head_sha,
		title: run.display_title,
		date: new Date().toISOString(),
		runUrl: run.html_url,
		assets,
	};
	const updated: DevRecord = { current, previous: record?.current ?? null };

	// Written after the files, so it never names a file that is not there yet.
	await writeJson(env, DEV_KEY, updated);

	// The build that was kept as previous is no longer linked from any manifest.
	const dropped = record?.previous;

	if (dropped) {
		try {
			await env.BUILDS.delete(devFileKeys(dropped));
		} catch (error) {
			console.error(
				`Removing build ${dropped.buildNumber} failed: ${errorMessage(error)}`,
			);
		}
	}

	return `Published build ${runNumber}`;
}

// Pushing a tag builds, attests and releases that commit, so the repository's tag ruleset, which
// lets only admins create tags, is what makes the latest release trusted.
export async function publishStableRelease(env: Env): Promise<string> {
	const release = await getLatestRelease(env);
	const assets: Record<string, ManifestAsset> = {};

	for (const asset of release.assets) {
		const runtime = GUI_ASSETS.get(asset.name);

		if (runtime === undefined) {
			continue;
		}

		const sha256 = parseDigest(asset.digest);

		if (sha256 === null) {
			throw new Error(`Release asset ${asset.name} has no sha256`);
		}

		assets[runtime] = {
			name: asset.name,
			url: asset.browser_download_url,
			size: asset.size,
			sha256,
		};
	}

	// The stored release is only replaced by one the GUI can update to.
	for (const [name, runtime] of GUI_ASSETS) {
		if (assets[runtime] === undefined) {
			throw new Error(`Release ${release.tag_name} has no ${name} asset`);
		}
	}

	const stable: StableChannel = {
		version: release.tag_name.replace(/^v/, ''),
		date: release.published_at,
		releaseNotesUrl: release.html_url,
		assets,
	};

	await writeJson(env, STABLE_KEY, stable);

	return `Stored release ${stable.version}`;
}
