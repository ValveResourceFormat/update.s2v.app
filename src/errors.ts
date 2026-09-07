// Classified by what the caller is told: not_found is theirs, config and upstream are ours
// and reported generically.
export type UpstreamErrorKind = 'not_found' | 'config' | 'upstream';

export class UpstreamError extends Error {
	constructor(
		readonly kind: UpstreamErrorKind,
		message: string,
	) {
		super(message);
		this.name = 'UpstreamError';
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
