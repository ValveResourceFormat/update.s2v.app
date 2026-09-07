import { type CachedResult, cachedValue } from './cache.ts';
import { UpstreamError } from './errors.ts';
import { getArtifactDownloadUrl } from './github.ts';
import { type ArtifactIds, buildManifest } from './manifest.ts';

// How long a manifest is served before GitHub is asked again, and how long an old one may be
// served while GitHub is unavailable.
const MANIFEST_TTL = 120;
const MANIFEST_STALE_TTL = 86400;

// GitHub documents the signed artifact URL as valid for one minute; a cached one must
// still leave the client time to start the download.
const ARTIFACT_URL_TTL = 20;

// Edge cache lifetimes. s-maxage must not be used here, since it disables both stale behaviours.
const MANIFEST_CACHE_CONTROL =
	'public, max-age=120, stale-while-revalidate=30, stale-if-error=86400';
const REDIRECT_CACHE_CONTROL = `public, max-age=${ARTIFACT_URL_TTL}`;

// Bump when the shape of the cached manifest entry changes.
const MANIFEST_CACHE_KEY = 'manifest.v4';

const HOME_URL = 'https://s2v.app/';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
};

// Body and ETag are computed once per manifest, not per request.
interface CachedManifest {
	body: string;
	etag: string;
	artifactIds: ArtifactIds;
}

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

// IPv6 addresses are limited per /64, since a single customer holds a whole one.
function rateLimitKey(request: Request): string {
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

	if (!ip.includes(':')) {
		return ip;
	}

	// The first four groups are always before a ::, and the groups it elides are zeros.
	const [head = ''] = ip.split('::');
	const groups = head.split(':').filter(Boolean);

	return [...groups, '0', '0', '0', '0']
		.slice(0, 4)
		.map((group) => group.padStart(4, '0'))
		.join(':');
}

async function computeEtag(body: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-1',
		new TextEncoder().encode(body),
	);
	const hex = Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');

	return `W/"${hex}"`;
}

// If-None-Match is a list and uses weak comparison (RFC 9110 13.1.2).
function matchesEtag(header: string | null, etag: string): boolean {
	if (!header) {
		return false;
	}

	if (header.trim() === '*') {
		return true;
	}

	const target = etag.replace(/^W\//, '');

	return header
		.split(',')
		.some((candidate) => candidate.trim().replace(/^W\//, '') === target);
}

function getManifest(
	ctx: ExecutionContext,
	env: Env,
	origin: string,
): Promise<CachedResult<CachedManifest>> {
	return cachedValue<CachedManifest>(
		ctx,
		origin,
		MANIFEST_CACHE_KEY,
		{ ttl: MANIFEST_TTL, staleTtl: MANIFEST_STALE_TTL },
		async (previous) => {
			const { manifest, artifactIds } = await buildManifest(
				env,
				origin,
				previous?.artifactIds,
			);
			const body = JSON.stringify(manifest);

			return { body, etag: await computeEtag(body), artifactIds };
		},
	);
}

async function handleManifest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	origin: string,
): Promise<Response> {
	const { value, stale } = await getManifest(ctx, env, origin);

	const headers: Record<string, string> = {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': MANIFEST_CACHE_CONTROL,
		'X-Content-Type-Options': 'nosniff',
		'Access-Control-Expose-Headers': 'ETag',
		...CORS_HEADERS,
		ETag: value.etag,
	};

	if (stale) {
		headers['X-Manifest-Stale'] = '1';
	}

	if (matchesEtag(request.headers.get('If-None-Match'), value.etag)) {
		return new Response(null, { status: 304, headers });
	}

	return new Response(request.method === 'HEAD' ? null : value.body, {
		headers,
	});
}

// Only files from a current or recent manifest are looked up, so the token's rate limit
// cannot be burned from outside.
async function handleArtifact(
	env: Env,
	ctx: ExecutionContext,
	origin: string,
	fileName: string,
	sha256: string | null,
): Promise<Response> {
	const { value } = await getManifest(ctx, env, origin);

	// hasOwn keeps a name like "constructor" from hitting the prototype.
	const builds = Object.hasOwn(value.artifactIds, fileName)
		? value.artifactIds[fileName]
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

	const artifactId = build.id;

	const { value: location } = await cachedValue(
		ctx,
		origin,
		`artifact/${artifactId}`,
		{ ttl: ARTIFACT_URL_TTL, staleTtl: ARTIFACT_URL_TTL },
		() => getArtifactDownloadUrl(env, artifactId),
	);

	return new Response(null, {
		status: 302,
		headers: {
			Location: location,
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

	// Fails open: the routes are cheap, and a missing binding must not break every request.
	const { success } = (await env.RATE_LIMITER?.limit({
		key: rateLimitKey(request),
	})) ?? { success: true };

	if (!success) {
		return jsonError(429, 'Too many requests', { 'Retry-After': '60' });
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
