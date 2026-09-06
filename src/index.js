import { cachedValue } from './cache.js';
import { UpstreamError } from './errors.js';
import { getArtifactDownloadUrl } from './github.js';
import { buildManifest } from './manifest.js';

// How long a manifest is served before GitHub is asked again, and how long an old copy may be
// served while that refresh runs or GitHub is unavailable.
const MANIFEST_TTL = 600;
const MANIFEST_STALE_TTL = 86400;

// GitHub documents the signed artifact URL as valid for one minute, so a cached one must
// still leave the client enough time to start the download.
const ARTIFACT_URL_TTL = 20;

// Edge cache lifetimes. The manifest stays fresh for five minutes, is served stale while a refresh
// runs, and stays available for a day if the worker fails. s-maxage must not be used here, since
// it disables both stale behaviours. The redirect is shared for as long as its signed URL is cached.
const MANIFEST_CACHE_CONTROL =
	'public, max-age=300, stale-while-revalidate=60, stale-if-error=86400';
const REDIRECT_CACHE_CONTROL = `public, max-age=${ARTIFACT_URL_TTL}`;

// Bump when the shape of the cached manifest entry changes, so entries written by the previous
// deployment are not read by the new code.
const MANIFEST_CACHE_KEY = 'manifest.v3';

const HOME_URL = 'https://s2v.app/';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
};

function jsonError(status, message, extraHeaders) {
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

function errorResponse(error) {
	if (error instanceof UpstreamError) {
		return error.kind === 'not_found'
			? jsonError(404, 'No such dev build artifact')
			: jsonError(502, 'Upstream unavailable', { 'Retry-After': '60' });
	}

	console.error(error);

	return jsonError(500, 'Internal error');
}

function decodeSegment(segment) {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

// A single customer holds a whole IPv6 /64, so the address alone is not an identity.
function rateLimitKey(request) {
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

	if (!ip.includes(':')) {
		return ip;
	}

	// Everything after a :: is zeros or the tail of the address, neither of which is in the first four groups.
	const groups = ip.split('::')[0].split(':').filter(Boolean);

	return [...groups, '0', '0', '0', '0']
		.slice(0, 4)
		.map((group) => group.padStart(4, '0'))
		.join(':');
}

async function computeEtag(body) {
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
function matchesEtag(header, etag) {
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

// The serialized body and its ETag are computed once per manifest rather than on every request.
function getManifest(ctx, env, origin) {
	return cachedValue(
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

async function handleManifest(request, env, ctx, origin) {
	const { value, stale } = await getManifest(ctx, env, origin);

	const headers = {
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

// Only file names and hashes present in the current or a recent manifest can be redirected to.
// Anything else is rejected before touching GitHub, so the token's rate limit cannot be burned from outside.
async function handleArtifact(env, ctx, origin, fileName, sha256) {
	const { value } = await getManifest(ctx, env, origin);

	if (!Object.hasOwn(value.artifactIds, fileName)) {
		throw new UpstreamError('not_found', 'No such dev build artifact');
	}

	const builds = value.artifactIds[fileName];
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

async function handleRequest(request, env, ctx) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonError(405, 'Method not allowed');
	}

	const url = new URL(request.url);

	if (url.pathname === '/') {
		return Response.redirect(HOME_URL, 302);
	}

	const artifactMatch = url.pathname.match(/^\/dev\/([^/]+)$/);

	if (url.pathname !== '/v1/latest.json' && !artifactMatch) {
		return jsonError(404, 'Not found');
	}

	// The limiter fails open: the routes behind it are cached and cheap, and a missing
	// binding must not turn every request into an error.
	const { success } = (await env.RATE_LIMITER?.limit({
		key: rateLimitKey(request),
	})) ?? { success: true };

	if (!success) {
		return jsonError(429, 'Too many requests', { 'Retry-After': '60' });
	}

	// Never derived from the request: it prefixes cache keys and is embedded in the cached
	// manifest that every client receives.
	const origin = env.PUBLIC_ORIGIN ?? url.origin;

	if (!artifactMatch) {
		return handleManifest(request, env, ctx, origin);
	}

	const fileName = decodeSegment(artifactMatch[1]);
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
};
