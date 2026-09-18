import { getManifest, MANIFEST_STALE_TTL, MANIFEST_TTL } from './cache.ts';
import { UpstreamError } from './errors.ts';
import { getArtifactDownloadUrl } from './github.ts';

// Edge cache lifetimes. s-maxage must not be used here, since it disables both stale behaviours.
const MANIFEST_CACHE_CONTROL = `public, max-age=${MANIFEST_TTL}, stale-while-revalidate=30, stale-if-error=${MANIFEST_STALE_TTL}`;
// GitHub documents the signed URL as valid for one minute, and a replayed redirect must
// still leave the client time to start the download.
const REDIRECT_CACHE_CONTROL = 'public, max-age=20';

const HOME_URL = 'https://s2v.app/';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
};

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
			? jsonError(404, error.message)
			: jsonError(502, 'Upstream unavailable', { 'Retry-After': '60' });
	}

	console.error(error);

	return jsonError(500, 'Internal error');
}

interface RouteContext {
	request: Request;
	env: Env;
	ctx: ExecutionContext;
	url: URL;
	// Named groups of the matched path, percent-decoded.
	params: Record<string, string>;
}

interface Route {
	pattern: URLPattern;
	// The edge cache is keyed on the full URL, so every spelling of a request other than the
	// canonical one is rejected, or each would reach GitHub on its own. Null accepts any query string.
	query: string[] | null;
	handle: (context: RouteContext) => Response | Promise<Response>;
}

function route(
	pathname: string,
	handle: Route['handle'],
	query: string[] | null,
): Route {
	return { pattern: new URLPattern({ pathname }), query, handle };
}

// Null when a group is malformed, or is not encoded the way the manifest encodes it.
function decodeParams(
	groups: Record<string, string>,
): Record<string, string> | null {
	const params: Record<string, string> = {};

	try {
		for (const [name, value] of Object.entries(groups)) {
			const decoded = decodeURIComponent(value);

			if (encodeURIComponent(decoded) !== value) {
				return null;
			}

			params[name] = decoded;
		}
	} catch {
		return null;
	}

	return params;
}

// The query string with only the allowed keys, once each, in their declared order.
function canonicalSearch(url: URL, allowed: string[]): string {
	const canonical = new URLSearchParams();

	for (const key of allowed) {
		const value = url.searchParams.get(key);

		if (value !== null) {
			canonical.set(key, value);
		}
	}

	return canonical.size > 0 ? `?${canonical}` : '';
}

function handleHome(): Response {
	return Response.redirect(HOME_URL, 302);
}

async function handleManifest({
	request,
	env,
	ctx,
}: RouteContext): Promise<Response> {
	const { manifest } = await getManifest(ctx, env);

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
async function handleArtifact({
	env,
	ctx,
	url,
	params,
}: RouteContext): Promise<Response> {
	const fileName = params.fileName ?? '';
	const sha256 = url.searchParams.get('sha256');

	if (sha256 !== null && !/^[0-9a-f]{64}$/.test(sha256)) {
		return jsonError(400, 'Malformed sha256');
	}

	const { artifactIds } = await getManifest(ctx, env);

	// hasOwn keeps a name like "constructor" from hitting the prototype.
	const builds = Object.hasOwn(artifactIds, fileName)
		? artifactIds[fileName]
		: undefined;

	if (!builds) {
		return jsonError(404, 'No such dev build artifact');
	}

	const build = sha256
		? builds.find((entry) => entry.sha256 === sha256)
		: builds[0];

	if (!build) {
		return jsonError(
			404,
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

const ROUTES: Route[] = [
	route('/', handleHome, null),
	route('/v1/latest.json', handleManifest, []),
	route('/v1/dev/:fileName', handleArtifact, ['sha256']),
];

async function handleRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonError(405, 'Method not allowed');
	}

	const url = new URL(request.url);

	for (const { pattern, query, handle } of ROUTES) {
		const match = pattern.exec(url.href);

		if (!match) {
			continue;
		}

		if (query && url.search !== canonicalSearch(url, query)) {
			return jsonError(400, 'Unexpected query string');
		}

		const params = decodeParams(match.pathname.groups);

		if (params === null) {
			return jsonError(400, 'Malformed path');
		}

		return handle({
			request,
			env,
			ctx,
			url,
			params,
		});
	}

	return jsonError(404, 'Not found');
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
