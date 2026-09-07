// Stale-on-error cache over the per-location Cache API. Each key keeps the last good value and the
// last failure. An expired value is refreshed before being served; if that fails, the old value is
// served and the producer is left alone for FAILURE_TTL, so a GitHub outage degrades to a slightly
// old manifest rather than errors or a request storm.

import { errorMessage, UpstreamError } from './errors.ts';

const FAILURE_TTL = 60;

type CachedFailure = Pick<UpstreamError, 'kind' | 'message'>;

interface Produced<T> {
	value: T;
	producedAt: number;
}

interface Failed {
	failure: CachedFailure;
	failedAt: number;
}

interface CacheEntry<T> {
	produced: Produced<T> | null;
	failed: Failed | null;
}

interface CacheLifetime {
	ttl: number;
	staleTtl: number;
}

export interface CachedResult<T> {
	value: T;
	stale: boolean;
}

type Producer<T> = (previous: T | undefined) => Promise<T>;

// Concurrent refreshes of one key within an isolate share a single producer call.
const inflight = new Map<string, Promise<CachedResult<unknown>>>();

function cacheKey(origin: string, name: string): Request {
	return new Request(`${origin}/.cache/${name}`);
}

function isRecent(timestamp: number, ttl: number): boolean {
	return Date.now() - timestamp < ttl * 1000;
}

async function readEntry<T>(
	cache: Cache,
	key: Request,
): Promise<CacheEntry<T> | undefined> {
	try {
		const response = await cache.match(key);

		return response ? await response.json<CacheEntry<T>>() : undefined;
	} catch {
		// A corrupt entry is treated as a miss and gets overwritten.
		return undefined;
	}
}

function writeEntry<T>(
	ctx: ExecutionContext,
	cache: Cache,
	key: Request,
	entry: CacheEntry<T>,
	ttl: number,
): void {
	const response = new Response(JSON.stringify(entry), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': `public, s-maxage=${ttl}`,
		},
	});

	ctx.waitUntil(cache.put(key, response).catch(() => {}));
}

function singleFlight<T>(
	key: string,
	run: () => Promise<CachedResult<T>>,
): Promise<CachedResult<T>> {
	let pending = inflight.get(key);

	if (!pending) {
		pending = run().finally(() => inflight.delete(key));
		inflight.set(key, pending);
	}

	return pending as Promise<CachedResult<T>>;
}

function describeFailure(error: unknown): CachedFailure {
	return error instanceof UpstreamError
		? { kind: error.kind, message: error.message }
		: { kind: 'upstream', message: errorMessage(error) };
}

async function refresh<T>(
	ctx: ExecutionContext,
	cache: Cache,
	key: Request,
	previous: CacheEntry<T> | undefined,
	staleTtl: number,
	produce: Producer<T>,
): Promise<CachedResult<T>> {
	const produced = previous?.produced ?? null;

	try {
		const value = await produce(produced?.value);

		writeEntry(
			ctx,
			cache,
			key,
			{ produced: { value, producedAt: Date.now() }, failed: null },
			staleTtl,
		);

		return { value, stale: false };
	} catch (error) {
		const failure = describeFailure(error);

		writeEntry(
			ctx,
			cache,
			key,
			{ produced, failed: { failure, failedAt: Date.now() } },
			produced ? staleTtl : FAILURE_TTL,
		);

		if (!produced) {
			throw error;
		}

		console.error(`Serving stale ${key.url}: ${failure.message}`);

		return { value: produced.value, stale: true };
	}
}

export async function cachedValue<T>(
	ctx: ExecutionContext,
	origin: string,
	name: string,
	{ ttl, staleTtl }: CacheLifetime,
	produce: Producer<T>,
): Promise<CachedResult<T>> {
	const cache = caches.default;
	const key = cacheKey(origin, name);
	const entry = await readEntry<T>(cache, key);
	const produced = entry?.produced;
	const failed = entry?.failed;

	if (produced && isRecent(produced.producedAt, ttl)) {
		return { value: produced.value, stale: false };
	}

	if (failed && isRecent(failed.failedAt, FAILURE_TTL)) {
		if (produced) {
			return { value: produced.value, stale: true };
		}

		throw new UpstreamError(failed.failure.kind, failed.failure.message);
	}

	// Not served stale while revalidating: the edge cache in front would hold the old value for
	// another full cycle, delaying a new build at every layer.
	return singleFlight(key.url, () =>
		refresh(ctx, cache, key, entry, staleTtl, produce),
	);
}
