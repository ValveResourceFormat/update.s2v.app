import { UpstreamError } from './errors.js';

const API_BASE = 'https://api.github.com';
const USER_AGENT =
	'update.s2v.app (+https://github.com/ValveResourceFormat/ValveResourceFormat)';

// Hosts GitHub has served artifact downloads from. An unknown host is only reported, not rejected,
// because GitHub has moved storage before and rejecting would break every download on the next move.
const KNOWN_DOWNLOAD_HOSTS = [
	'.blob.core.windows.net',
	'.githubusercontent.com',
	'.github.com',
];

function headers(env, withToken) {
	const result = {
		Accept: 'application/vnd.github+json',
		'User-Agent': USER_AGENT,
		'X-GitHub-Api-Version': '2026-03-10',
	};

	if (withToken && env.GITHUB_TOKEN) {
		result.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
	}

	return result;
}

async function apiJson(env, path) {
	let response = await fetch(`${API_BASE}${path}`, {
		headers: headers(env, true),
	});

	// GitHub rejects every request carrying an expired or revoked token, including ones for public
	// data that needs no token at all. Retrying anonymously keeps the manifest alive until it is rotated.
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

	return response.json();
}

export function getLatestRelease(env) {
	return apiJson(env, `/repos/${env.GITHUB_REPO}/releases/latest`);
}

// Events whose runs can only be triggered from the repository itself. The branch filter alone is not
// enough, because it matches the head branch name and a pull request from a fork can also be on a
// branch called master. The API accepts a single event per query, so each is queried separately and
// the newest run wins. Scheduled runs matter because they keep artifacts from expiring on a quiet branch.
// A tag named like the branch would also pass, but pushing tags already requires write access.
// These are fetched concurrently alongside the release, and a Worker may only have six
// requests in flight at once, so keep the list short.
const TRUSTED_EVENTS = ['push', 'schedule', 'workflow_dispatch'];

async function getLatestRunForEvent(env, event) {
	const query = new URLSearchParams({
		branch: env.GITHUB_BRANCH,
		event,
		status: 'success',
		per_page: '1',
	});

	const data = await apiJson(
		env,
		`/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/runs?${query}`,
	);

	const run = data.workflow_runs?.[0];

	if (
		run?.conclusion !== 'success' ||
		run.head_branch !== env.GITHUB_BRANCH ||
		run.head_repository?.full_name?.toLowerCase() !==
			env.GITHUB_REPO.toLowerCase()
	) {
		return null;
	}

	return run;
}

export async function getLatestWorkflowRun(env) {
	const runs = await Promise.all(
		TRUSTED_EVENTS.map((event) => getLatestRunForEvent(env, event)),
	);

	return runs.reduce(
		(best, run) =>
			run && (!best || run.run_number > best.run_number) ? run : best,
		null,
	);
}

export async function getRunArtifacts(env, runId) {
	// A run uploads well under a hundred artifacts, so a single page is enough.
	const data = await apiJson(
		env,
		`/repos/${env.GITHUB_REPO}/actions/runs/${runId}/artifacts?per_page=100`,
	);

	return data.artifacts ?? [];
}

// The artifact download endpoint answers with a short-lived signed URL in the Location header.
// It requires authentication even for public repositories, which is the whole reason this worker exists.
export async function getArtifactDownloadUrl(env, artifactId) {
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

	// Only the headers matter, the body of a redirect is never read.
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

	let target;

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
