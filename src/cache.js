// Wrapper over the per-location Cache API. One entry per key holds the last good value and when it
// was produced, plus the last failure and when it happened. A value older than its ttl is refreshed
// before being answered, and when that refresh fails the old value is served and the failure is not
// retried for a while, so a GitHub outage or rate limit degrades to a slightly old value rather than
// an error or a storm of requests.

import { UpstreamError } from './errors.js';

const FAILURE_TTL = 60;

// Concurrent refreshes for the same key inside one isolate share a single producer call.
const inflight = new Map();

function cacheKey(origin, name) {
	return new Request(`${origin}/.cache/${name}`);
}

function isRecent(timestamp, ttl) {
	return timestamp !== undefined && Date.now() - timestamp < ttl * 1000;
}

async function readEntry(cache, key) {
	try {
		const response = await cache.match(key);

		return response ? await response.json() : undefined;
	} catch {
		// A corrupt entry is treated as a miss and gets overwritten.
		return undefined;
	}
}

function writeEntry(ctx, cache, key, entry, ttl) {
	const response = new Response(JSON.stringify(entry), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': `public, s-maxage=${ttl}`,
		},
	});

	ctx.waitUntil(cache.put(key, response).catch(() => {}));
}

function singleFlight(key, run) {
	let pending = inflight.get(key);

	if (!pending) {
		pending = run().finally(() => inflight.delete(key));
		inflight.set(key, pending);
	}

	return pending;
}

async function refresh(ctx, cache, key, previous, staleTtl, produce) {
	try {
		const value = await produce(previous?.value);

		writeEntry(ctx, cache, key, { value, producedAt: Date.now() }, staleTtl);

		return { value, stale: false };
	} catch (error) {
		const failure = {
			kind: error?.kind ?? 'upstream',
			message: error?.message ?? String(error),
		};
		const hasValue = previous?.value !== undefined;

		writeEntry(
			ctx,
			cache,
			key,
			{ ...previous, failedAt: Date.now(), failure },
			hasValue ? staleTtl : FAILURE_TTL,
		);

		if (!hasValue) {
			throw error;
		}

		console.error(`Serving stale ${key.url}: ${failure.message}`);

		return { value: previous.value, stale: true };
	}
}

export async function cachedValue(
	ctx,
	origin,
	name,
	{ ttl, staleTtl },
	produce,
) {
	const cache = caches.default;
	const key = cacheKey(origin, name);
	const entry = await readEntry(cache, key);
	const hasValue = entry?.value !== undefined;

	if (hasValue && isRecent(entry.producedAt, ttl)) {
		return { value: entry.value, stale: false };
	}

	if (isRecent(entry?.failedAt, FAILURE_TTL)) {
		if (hasValue) {
			return { value: entry.value, stale: true };
		}

		throw new UpstreamError(entry.failure.kind, entry.failure.message);
	}

	// An expired value is refreshed before answering rather than served one more time. The edge cache
	// in front stores whatever is answered here for its own lifetime, so handing out the old value
	// would push a new build back by another full cycle at every cache layer.
	return singleFlight(key.url, () =>
		refresh(ctx, cache, key, entry, staleTtl, produce),
	);
}
