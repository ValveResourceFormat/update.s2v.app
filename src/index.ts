import { createCache } from './cache.ts';
import { UpstreamError } from './errors.ts';
import { getArtifactDownloadUrl } from './github.ts';
import { buildManifest } from './manifest.ts';

// How long a manifest is served before GitHub is asked again, and how long an old one may be
// served while GitHub is unavailable.
const MANIFEST_TTL = 120;
const MANIFEST_STALE_TTL = 86400;

// Edge cache lifetimes. s-maxage must not be used here, since it disables both stale behaviours.
const MANIFEST_CACHE_CONTROL = `public, max-age=${MANIFEST_TTL}, stale-while-revalidate=30, stale-if-error=${MANIFEST_STALE_TTL}`;
// GitHub documents the signed URL as valid for one minute, and a replayed redirect must
// still leave the client time to start the download.
const REDIRECT_CACHE_CONTROL = 'public, max-age=20';

const HOME_URL = 'https://s2v.app/';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
};

// Bump the key when the shape of the cached entry changes.
const getManifest = createCache(
	'manifest.v5',
	{ ttl: MANIFEST_TTL, staleTtl: MANIFEST_STALE_TTL },
	buildManifest,
);

function jsonError(
	status: number,
	message: string,
	extraHeaders?: Record<string, string>,
): Response {
	return Response.json(
		{ error: message },
		{
			status,
			headers: {
				'Cache-Control': 'no-store',
				...CORS_HEADERS,
				...extraHeaders,
			},
		},
	);
}

function errorResponse(error: unknown): Response {
	if (error instanceof UpstreamError) {
		return error.kind === 'not_found'
			? jsonError(404, 'No such dev build artifact')
			: jsonError(502, 'Upstream unavailable', { 'Retry-After': '60' });
	}

	console.error(error);

	return jsonError(500, 'Internal error');
}

function decodeSegment(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

async function handleManifest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	origin: string,
): Promise<Response> {
	const { manifest } = await getManifest(ctx, env, origin);

	return new Response(
		request.method === 'HEAD' ? null : JSON.stringify(manifest),
		{
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': MANIFEST_CACHE_CONTROL,
				'X-Content-Type-Options': 'nosniff',
				...CORS_HEADERS,
			},
		},
	);
}

// Only files from a current or recent manifest are resolved, so artifact ids cannot be
// enumerated through the token.
async function handleArtifact(
	env: Env,
	ctx: ExecutionContext,
	origin: string,
	fileName: string,
	sha256: string | null,
): Promise<Response> {
	const { artifactIds } = await getManifest(ctx, env, origin);

	// hasOwn keeps a name like "constructor" from hitting the prototype.
	const builds = Object.hasOwn(artifactIds, fileName)
		? artifactIds[fileName]
		: undefined;

	if (!builds) {
		throw new UpstreamError('not_found', 'No such dev build artifact');
	}

	const build = sha256
		? builds.find((entry) => entry.sha256 === sha256)
		: builds[0];

	if (!build) {
		throw new UpstreamError(
			'not_found',
			'No dev build artifact with that hash is available anymore',
		);
	}

	return new Response(null, {
		status: 302,
		headers: {
			Location: await getArtifactDownloadUrl(env, build.id),
			'Cache-Control': REDIRECT_CACHE_CONTROL,
			...CORS_HEADERS,
		},
	});
}

async function handleRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonError(405, 'Method not allowed');
	}

	const url = new URL(request.url);

	if (url.pathname === '/') {
		return Response.redirect(HOME_URL, 302);
	}

	const devFile = url.pathname.match(/^\/dev\/([^/]+)$/)?.[1];

	if (url.pathname !== '/v1/latest.json' && devFile === undefined) {
		return jsonError(404, 'Not found');
	}

	// The edge cache is keyed on the full URL, so a stray query string would bypass it.
	const allowedParam = devFile === undefined ? null : 'sha256';

	for (const key of url.searchParams.keys()) {
		if (key !== allowedParam) {
			return jsonError(400, 'Unexpected query parameter');
		}
	}

	// Never taken from the request: it prefixes cache keys and is embedded in the shared manifest.
	const origin = env.PUBLIC_ORIGIN ?? url.origin;

	if (devFile === undefined) {
		return handleManifest(request, env, ctx, origin);
	}

	const fileName = decodeSegment(devFile);
	const sha256 = url.searchParams.get('sha256')?.toLowerCase() ?? null;

	if (
		fileName === null ||
		(sha256 !== null && !/^[0-9a-f]{64}$/.test(sha256))
	) {
		return jsonError(400, 'Malformed path');
	}

	return handleArtifact(env, ctx, origin, fileName, sha256);
}

export default {
	async fetch(request, env, ctx) {
		try {
			return await handleRequest(request, env, ctx);
		} catch (error) {
			return errorResponse(error);
		}
	},
} satisfies ExportedHandler<Env>;
