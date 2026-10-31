import { errorMessage } from './errors.ts';

const API_BASE = 'https://api.github.com';
const USER_AGENT =
	'update.s2v.app (+https://github.com/ValveResourceFormat/ValveResourceFormat)';

const REQUEST_TIMEOUT = 10_000;

// Only the fields this worker reads. Responses are not validated at runtime.

export interface ReleaseAsset {
	name: string;
	size: number;
	digest?: string | null;
	browser_download_url: string;
}

export interface Release {
	tag_name: string;
	published_at: string | null;
	html_url: string;
	assets: ReleaseAsset[];
}

export interface WorkflowRun {
	head_sha: string;
	display_title: string;
	html_url: string;
}

export interface Artifact {
	id: number;
	name: string;
	size_in_bytes: number;
	digest?: string | null;
}

async function apiRequest(
	env: Env,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	try {
		return await fetch(`${API_BASE}${path}`, {
			...init,
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				'User-Agent': USER_AGENT,
				'X-GitHub-Api-Version': '2026-03-10',
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT),
		});
	} catch (error) {
		throw new Error(`GitHub API request failed: ${errorMessage(error)}`);
	}
}

async function apiJson<T>(env: Env, path: string): Promise<T> {
	const response = await apiRequest(env, path);

	if (!response.ok) {
		throw new Error(`GitHub API ${path} returned ${response.status}`);
	}

	return response.json<T>();
}

export function getLatestRelease(env: Env): Promise<Release> {
	return apiJson<Release>(
		env,
		`/repositories/${env.GITHUB_REPO_ID}/releases/latest`,
	);
}

export function getWorkflowRun(env: Env, runId: string): Promise<WorkflowRun> {
	return apiJson<WorkflowRun>(
		env,
		`/repositories/${env.GITHUB_REPO_ID}/actions/runs/${runId}`,
	);
}

export async function getRunArtifacts(
	env: Env,
	runId: string,
): Promise<Artifact[]> {
	// A run uploads far fewer than a hundred artifacts, so one page is enough.
	const data = await apiJson<{ artifacts: Artifact[] }>(
		env,
		`/repositories/${env.GITHUB_REPO_ID}/actions/runs/${runId}/artifacts?per_page=100`,
	);

	return data.artifacts;
}

// Answers with a signed URL in the Location header, valid for about a minute.
export async function getArtifactDownloadUrl(
	env: Env,
	artifactId: number,
): Promise<string> {
	const response = await apiRequest(
		env,
		`/repositories/${env.GITHUB_REPO_ID}/actions/artifacts/${artifactId}/zip`,
		{ redirect: 'manual' },
	);

	// Only the headers are needed.
	await response.body?.cancel();

	const location = response.headers.get('Location');

	if (response.status !== 302 || location === null) {
		throw new Error(
			`GitHub API artifact ${artifactId} download returned ${response.status}`,
		);
	}

	if (new URL(location).protocol !== 'https:') {
		throw new Error(
			`GitHub API artifact ${artifactId} redirected to non-https`,
		);
	}

	return location;
}
