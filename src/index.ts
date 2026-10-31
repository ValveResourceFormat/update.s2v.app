import {
	DEV_FILES_PREFIX,
	DEV_KEY,
	type DevRecord,
	readJson,
	STABLE_KEY,
	type StableChannel,
} from './builds.ts';
import { errorMessage } from './errors.ts';
import { verifyReleaseToken, verifyRunToken } from './oidc.ts';
import { publishDevBuild, publishStableRelease } from './publish.ts';

// The edge keeps the manifest until a publish purges it, while clients always ask the edge again.
// s-maxage must not be used here, since it disables both stale behaviours.
const MANIFEST_PATH = '/v1/latest.json';
const MANIFEST_EDGE_CACHE_CONTROL =
	'max-age=86400, stale-while-revalidate=60, stale-if-error=604800';
const MANIFEST_CACHE_CONTROL = 'public, no-cache';
const DEV_PATH = '/v1/dev/';
const FILE_NAME_PATTERN = /^[\w.-]{1,128}$/;

const HOME_URL = 'https://s2v.app/';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
};

function jsonError(
	status: number,
	message: string,
	cacheControl = 'no-store',
): Response {
	return Response.json(
		{ error: message },
		{
			status,
			headers: {
				'Cache-Control': cacheControl,
				...CORS_HEADERS,
			},
		},
	);
}

// Not cached, since the next build's file name is known before it is published.
function devFileNotFound(): Response {
	return jsonError(404, 'No such dev build file');
}

async function handleManifest(env: Env): Promise<Response> {
	const [stable, dev] = await Promise.all([
		readJson<StableChannel>(env, STABLE_KEY),
		readJson<DevRecord>(env, DEV_KEY),
	]);

	if (stable === null) {
		return jsonError(503, 'No release has been stored yet');
	}

	const manifest = { stable, dev: dev?.current ?? null };

	// The runtime drops the body of a HEAD response.
	return new Response(JSON.stringify(manifest), {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': MANIFEST_CACHE_CONTROL,
			'Cloudflare-CDN-Cache-Control': MANIFEST_EDGE_CACHE_CONTROL,
			'X-Content-Type-Options': 'nosniff',
			...CORS_HEADERS,
		},
	});
}

function devFileHeaders(object: R2Object): Headers {
	const headers = new Headers(CORS_HEADERS);

	// Content type, disposition and cache lifetime are stored with the file when it is published.
	object.writeHttpMetadata(headers);
	headers.set('ETag', object.httpEtag);
	headers.set('Content-Length', String(object.size));

	return headers;
}

// Range requests get the whole file, which the edge then caches and serves ranges from.
async function handleDevFile(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	const fileName = url.pathname.slice(DEV_PATH.length);

	if (!FILE_NAME_PATTERN.test(fileName)) {
		return devFileNotFound();
	}

	const key = `${DEV_FILES_PREFIX}${fileName}`;

	if (request.method === 'HEAD') {
		const object = await env.BUILDS.head(key);

		if (!object) {
			return devFileNotFound();
		}

		return new Response(null, { headers: devFileHeaders(object) });
	}

	const object = await env.BUILDS.get(key);

	if (!object) {
		return devFileNotFound();
	}

	return new Response(object.body, { headers: devFileHeaders(object) });
}

function bearerToken(request: Request): string {
	const authorization = request.headers.get('Authorization') ?? '';

	return authorization.replace(/^Bearer /, '');
}

async function purgeManifest(ctx: ExecutionContext): Promise<void> {
	if (ctx.cache === undefined) {
		throw new Error('the Workers cache is not available');
	}

	const result = await ctx.cache.purge({ pathPrefixes: [MANIFEST_PATH] });

	if (!result.success) {
		const reasons = result.errors.map((error) => error.message).join('; ');

		throw new Error(reasons);
	}
}

// Only CI calls the publish routes, so it gets the reason for a failure rather than a generic error.
// The manifest is purged even when nothing changed, so re-running a publish whose purge failed fixes it.
async function publishResponse(
	ctx: ExecutionContext,
	what: string,
	publishing: Promise<string>,
): Promise<Response> {
	let message: string;

	try {
		message = await publishing;
	} catch (error) {
		const reason = errorMessage(error);
		console.error(`Publishing ${what} failed: ${reason}`);

		return jsonError(502, reason);
	}

	try {
		await purgeManifest(ctx);
	} catch (error) {
		const failure = `${message}, but purging the cached manifest failed: ${errorMessage(error)}`;
		console.error(failure);

		return jsonError(502, failure);
	}

	return Response.json(
		{ message },
		{ headers: { 'Cache-Control': 'no-store' } },
	);
}

// Null unless the body is {"artifactIds": [...]} with at least one id.
async function readArtifactIds(request: Request): Promise<number[] | null> {
	let body: { artifactIds?: unknown };

	try {
		body = await request.json();
	} catch {
		return null;
	}

	const ids = body?.artifactIds;

	if (!Array.isArray(ids) || ids.length === 0) {
		return null;
	}

	for (const id of ids) {
		if (!Number.isSafeInteger(id) || id <= 0) {
			return null;
		}
	}

	return ids;
}

// Called by the publish-dev job of the CI workflow once a build has finished, with the ids of the
// artifacts the viewer job uploaded.
async function handlePublish(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const run = await verifyRunToken(env, bearerToken(request));

	if (run === null) {
		return jsonError(403, 'Token is not from a trusted build');
	}

	const artifactIds = await readArtifactIds(request);

	if (artifactIds === null) {
		return jsonError(400, 'Body must list the artifact ids to publish');
	}

	return publishResponse(
		ctx,
		`build ${run.runNumber}`,
		publishDevBuild(env, run, artifactIds),
	);
}

// Called by the release workflow whenever a release is published, edited or deleted.
async function handlePublishStable(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const trusted = await verifyReleaseToken(env, bearerToken(request));

	if (!trusted) {
		return jsonError(403, 'Token is not from the release workflow');
	}

	return publishResponse(ctx, 'the latest release', publishStableRelease(env));
}

async function handleRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (request.method === 'POST') {
		if (path === '/v1/publish') {
			return handlePublish(request, env, ctx);
		}

		if (path === '/v1/publish-stable') {
			return handlePublishStable(request, env, ctx);
		}
	}

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonError(405, 'Method not allowed');
	}

	if (path === '/') {
		return Response.redirect(HOME_URL, 302);
	}

	// The query string is part of the cache key, so any query would skip the cache and reach the bucket.
	if (url.search !== '') {
		return Response.redirect(`${url.origin}${path}`, 301);
	}

	if (path === MANIFEST_PATH) {
		return handleManifest(env);
	}

	if (path.startsWith(DEV_PATH)) {
		return handleDevFile(request, env, url);
	}

	return jsonError(404, 'Not found');
}

export default {
	async fetch(request, env, ctx) {
		try {
			return await handleRequest(request, env, ctx);
		} catch (error) {
			console.error(errorMessage(error));

			return jsonError(500, 'Internal error');
		}
	},
} satisfies ExportedHandler<Env>;
