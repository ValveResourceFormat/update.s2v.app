// The built manifest, kept in the per-location Cache API with stale-on-error behaviour. An expired
// manifest is rebuilt before being served; if that fails, the old one is served and GitHub is left
// alone for FAILURE_TTL, so an outage degrades to a slightly old manifest rather than errors or a
// request storm.

import { errorMessage, UpstreamError } from './errors.ts';
import { type BuiltManifest, buildManifest } from './manifest.ts';

// How long a manifest is served before GitHub is asked again, and how long an old one may be
// served while GitHub is unavailable.
export const MANIFEST_TTL = 120;
export const MANIFEST_STALE_TTL = 86400;

const FAILURE_TTL = 60;

// Bump the key when the shape of the cached entry changes.
const CACHE_PATH = '/.cache/manifest.v7';

interface CacheEntry {
	// The last good manifest, kept through failed rebuilds until staleAt.
	value: BuiltManifest | undefined;
	staleAt: number;
	// GitHub is not asked again before this.
	retryAt: number;
}

async function readEntry(key: Request): Promise<CacheEntry | undefined> {
	try {
		const response = await caches.default.match(key);

		return response ? await response.json<CacheEntry>() : undefined;
	} catch {
		// A corrupt entry is treated as a miss and gets overwritten.
		return undefined;
	}
}

function writeEntry(
	ctx: ExecutionContext,
	key: Request,
	entry: CacheEntry,
): void {
	const response = new Response(JSON.stringify(entry), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': `public, s-maxage=${MANIFEST_STALE_TTL}`,
		},
	});

	ctx.waitUntil(caches.default.put(key, response).catch(() => {}));
}

export async function getManifest(
	ctx: ExecutionContext,
	env: Env,
): Promise<BuiltManifest> {
	const key = new Request(`${env.PUBLIC_ORIGIN}${CACHE_PATH}`);
	const entry = await readEntry(key);
	const now = Date.now();
	const previous = entry && now < entry.staleAt ? entry.value : undefined;

	if (entry && now < entry.retryAt) {
		if (previous !== undefined) {
			return previous;
		}

		throw new UpstreamError('upstream', 'Manifest is unavailable');
	}

	// Not served stale while revalidating: the edge cache in front would hold the old value for
	// another full cycle, delaying a new build at every layer.
	try {
		const value = await buildManifest(env, previous);

		writeEntry(ctx, key, {
			value,
			staleAt: now + MANIFEST_STALE_TTL * 1000,
			retryAt: now + MANIFEST_TTL * 1000,
		});

		return value;
	} catch (error) {
		console.error(`Manifest rebuild failed: ${errorMessage(error)}`);

		writeEntry(ctx, key, {
			value: previous,
			staleAt: entry?.staleAt ?? 0,
			retryAt: now + FAILURE_TTL * 1000,
		});

		if (previous === undefined) {
			throw error;
		}

		return previous;
	}
}
