// Errors are classified by what the caller should be told, not by where they came from:
// not_found is the caller's concern, config and upstream are ours and are reported generically.
export class UpstreamError extends Error {
	constructor(kind, message) {
		super(message);
		this.name = 'UpstreamError';
		this.kind = kind;
	}
}
