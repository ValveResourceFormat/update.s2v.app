// Wrapper over the per-location Cache API. One entry per key holds the last good value and when it
// was produced, plus the last failure and when it happened. A value older than its ttl is served
// while a refresh runs in the background, and a recent failure is not retried, so a GitHub outage
// or rate limit degrades to a slightly old value rather than an error or a storm of requests.

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

		return value;
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

		return previous.value;
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

	const pending = singleFlight(key.url, () =>
		refresh(ctx, cache, key, entry, staleTtl, produce),
	);

	if (hasValue) {
		ctx.waitUntil(pending.catch(() => {}));

		return { value: entry.value, stale: false };
	}

	return { value: await pending, stale: false };
}
