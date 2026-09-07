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

type Producer<T> = (
	env: Env,
	origin: string,
	previous: T | undefined,
) => Promise<T>;

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

function describeFailure(error: unknown): CachedFailure {
	return error instanceof UpstreamError
		? { kind: error.kind, message: error.message }
		: { kind: 'upstream', message: errorMessage(error) };
}

export function createCache<T>(
	name: string,
	{ ttl, staleTtl }: CacheLifetime,
	produce: Producer<T>,
) {
	// Concurrent refreshes within an isolate share a single producer call.
	let pending: Promise<T> | undefined;

	async function refresh(
		ctx: ExecutionContext,
		env: Env,
		origin: string,
		cache: Cache,
		key: Request,
		produced: Produced<T> | null,
	): Promise<T> {
		try {
			const value = await produce(env, origin, produced?.value);

			writeEntry(
				ctx,
				cache,
				key,
				{ produced: { value, producedAt: Date.now() }, failed: null },
				staleTtl,
			);

			return value;
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

			return produced.value;
		}
	}

	return async (
		ctx: ExecutionContext,
		env: Env,
		origin: string,
	): Promise<T> => {
		const cache = caches.default;
		const key = new Request(`${origin}/.cache/${name}`);
		const entry = await readEntry<T>(cache, key);
		const produced = entry?.produced ?? null;
		const failed = entry?.failed;

		if (produced && isRecent(produced.producedAt, ttl)) {
			return produced.value;
		}

		if (failed && isRecent(failed.failedAt, FAILURE_TTL)) {
			if (produced) {
				return produced.value;
			}

			throw new UpstreamError(failed.failure.kind, failed.failure.message);
		}

		// Not served stale while revalidating: the edge cache in front would hold the old value for
		// another full cycle, delaying a new build at every layer.
		pending ??= refresh(ctx, env, origin, cache, key, produced).finally(() => {
			pending = undefined;
		});

		return pending;
	};
}
