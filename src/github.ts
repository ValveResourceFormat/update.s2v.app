import { UpstreamError } from './errors.ts';

const API_BASE = 'https://api.github.com';
const USER_AGENT =
	'update.s2v.app (+https://github.com/ValveResourceFormat/ValveResourceFormat)';

// An unknown host is logged, not rejected: GitHub has moved artifact storage before, and rejecting
// would break every download on the next move.
const KNOWN_DOWNLOAD_HOSTS = [
	'.blob.core.windows.net',
	'.githubusercontent.com',
	'.github.com',
];

// Only the fields this worker reads. Responses are not validated at runtime.

interface ReleaseAsset {
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
	id: number;
	run_number: number;
	head_sha: string;
	head_branch: string | null;
	display_title: string;
	updated_at: string;
	html_url: string;
	conclusion: string | null;
	head_repository: { full_name: string };
}

export interface Artifact {
	id: number;
	name: string;
	size_in_bytes: number;
	digest?: string | null;
	expired: boolean;
	expires_at: string | null;
}

function headers(env: Env, withToken: boolean): Record<string, string> {
	const result: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'User-Agent': USER_AGENT,
		'X-GitHub-Api-Version': '2026-03-10',
	};

	if (withToken && env.GITHUB_TOKEN) {
		result.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
	}

	return result;
}

async function apiJson<T>(env: Env, path: string): Promise<T> {
	let response = await fetch(`${API_BASE}${path}`, {
		headers: headers(env, true),
	});

	// An expired or revoked token gets every request rejected, even for public data.
	// Retrying anonymously keeps the manifest alive until the token is rotated.
	if (response.status === 401 && env.GITHUB_TOKEN) {
		console.error('GITHUB_TOKEN was rejected, retrying without it');

		response = await fetch(`${API_BASE}${path}`, {
			headers: headers(env, false),
		});
	}

	if (!response.ok) {
		throw new UpstreamError(
			'upstream',
			`GitHub API ${path} returned ${response.status}`,
		);
	}

	return response.json<T>();
}

export function getLatestRelease(env: Env): Promise<Release> {
	return apiJson<Release>(env, `/repos/${env.GITHUB_REPO}/releases/latest`);
}

// Events that can only be triggered from the repository itself. The branch filter alone is not
// enough, since a pull request from a fork can also have a head branch called master. The API
// takes one event per query, so each is queried and the newest run wins. Scheduled runs are
// included because they keep artifacts from expiring on a quiet branch.
const TRUSTED_EVENTS = ['push', 'schedule'];

async function getLatestRunForEvent(
	env: Env,
	event: string,
): Promise<WorkflowRun | null> {
	const query = new URLSearchParams({
		branch: env.GITHUB_BRANCH,
		event,
		status: 'success',
		per_page: '1',
	});

	const data = await apiJson<{ workflow_runs: WorkflowRun[] }>(
		env,
		`/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/runs?${query}`,
	);

	const run = data.workflow_runs[0];

	if (
		run?.conclusion !== 'success' ||
		run.head_branch !== env.GITHUB_BRANCH ||
		run.head_repository.full_name.toLowerCase() !==
			env.GITHUB_REPO.toLowerCase()
	) {
		return null;
	}

	return run;
}

export async function getLatestWorkflowRun(
	env: Env,
): Promise<WorkflowRun | null> {
	const runs = await Promise.all(
		TRUSTED_EVENTS.map((event) => getLatestRunForEvent(env, event)),
	);

	return runs.reduce<WorkflowRun | null>(
		(best, run) =>
			run && (!best || run.run_number > best.run_number) ? run : best,
		null,
	);
}

export async function getRunArtifacts(
	env: Env,
	runId: number,
): Promise<Artifact[]> {
	// A run uploads far fewer than a hundred artifacts, so one page is enough.
	const data = await apiJson<{ artifacts: Artifact[] }>(
		env,
		`/repos/${env.GITHUB_REPO}/actions/runs/${runId}/artifacts?per_page=100`,
	);

	return data.artifacts;
}

// Answers with a short-lived signed URL in the Location header. Needs authentication even for
// public repositories, which is the reason this worker exists.
export async function getArtifactDownloadUrl(
	env: Env,
	artifactId: number,
): Promise<string> {
	if (!env.GITHUB_TOKEN) {
		throw new UpstreamError('config', 'GITHUB_TOKEN is not configured');
	}

	const response = await fetch(
		`${API_BASE}/repos/${env.GITHUB_REPO}/actions/artifacts/${artifactId}/zip`,
		{
			headers: headers(env, true),
			redirect: 'manual',
		},
	);

	// Only the headers are needed.
	await response.body?.cancel();

	if (response.status === 410) {
		throw new UpstreamError('not_found', 'Artifact has expired');
	}

	const location = response.headers.get('Location');

	if (!location) {
		throw new UpstreamError(
			'upstream',
			`GitHub API artifact download returned ${response.status}`,
		);
	}

	let target: URL;

	try {
		target = new URL(location);
	} catch {
		throw new UpstreamError(
			'upstream',
			'GitHub returned an unparseable download URL',
		);
	}

	if (target.protocol !== 'https:') {
		throw new UpstreamError(
			'upstream',
			'GitHub returned a non-https download URL',
		);
	}

	if (
		!KNOWN_DOWNLOAD_HOSTS.some((suffix) => target.hostname.endsWith(suffix))
	) {
		console.error(`Unexpected artifact download host: ${target.hostname}`);
	}

	return target.toString();
}
