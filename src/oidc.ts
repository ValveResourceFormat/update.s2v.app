// Verifies the OIDC token a GitHub Actions job sends. Only a build of the trusted branch can publish
// a dev build, and only the run that token was issued to.

import { createRemoteJWKSet, errors, type JWTPayload, jwtVerify } from 'jose';
import { errorMessage } from './errors.ts';

const ISSUER = 'https://token.actions.githubusercontent.com';

// Kept per isolate, so the signing keys are not fetched for every request.
const SIGNING_KEYS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));

// A push can only come from the repository itself. The branch alone is not enough, since a pull
// request from a fork can also have a head branch called master.
const BUILD_EVENT = 'push';

interface ActionsClaims extends JWTPayload {
	repository?: string;
	repository_id?: string;
	ref?: string;
	event_name?: string;
	job_workflow_ref?: string;
	runner_environment?: string;
	run_id?: string;
	run_number?: string;
}

export interface TrustedRun {
	runId: string;
	runNumber: number;
}

// Failing to fetch or parse the signing keys is not the caller's fault. jose throws its generic
// error for a key set response that is not 200 or not JSON.
function isSigningKeysError(error: unknown): boolean {
	if (
		error instanceof errors.JWKSTimeout ||
		error instanceof errors.JWKSInvalid
	) {
		return true;
	}

	return (
		error instanceof errors.JOSEError && error.code === errors.JOSEError.code
	);
}

// Null unless the token is signed by GitHub, meant for this worker, and from this repository.
async function verifyClaims(
	env: Env,
	token: string,
): Promise<ActionsClaims | null> {
	let claims: ActionsClaims;

	try {
		const result = await jwtVerify<ActionsClaims>(token, SIGNING_KEYS, {
			issuer: ISSUER,
			audience: env.PUBLIC_ORIGIN,
			algorithms: ['RS256'],
			requiredClaims: ['exp', 'iat'],
		});
		claims = result.payload;
	} catch (error) {
		if (!(error instanceof errors.JOSEError) || isSigningKeysError(error)) {
			throw new Error(`Could not verify the token: ${errorMessage(error)}`);
		}

		return null;
	}

	if (claims.repository_id !== env.GITHUB_REPO_ID) {
		return null;
	}

	return claims;
}

// The job must come from this repository's own workflow, not a reusable one it calls.
function isFromWorkflow(
	claims: ActionsClaims,
	workflow: string,
	ref: string,
): boolean {
	const workflowRef = `${claims.repository}/.github/workflows/${workflow}@${ref}`;

	return claims.job_workflow_ref === workflowRef;
}

// Null when the token is not from a build of the trusted branch.
export async function verifyRunToken(
	env: Env,
	token: string,
): Promise<TrustedRun | null> {
	const claims = await verifyClaims(env, token);

	if (claims === null) {
		return null;
	}

	const branchRef = `refs/heads/${env.GITHUB_BRANCH}`;

	if (claims.ref !== branchRef || claims.event_name !== BUILD_EVENT) {
		return null;
	}

	if (!isFromWorkflow(claims, env.GITHUB_WORKFLOW, branchRef)) {
		return null;
	}

	// Matches what the GUI requires of a build's provenance.
	if (claims.runner_environment !== 'github-hosted') {
		return null;
	}

	const runId = claims.run_id ?? '';
	const runNumber = claims.run_number ?? '';

	if (!/^\d+$/.test(runId) || !/^\d+$/.test(runNumber)) {
		return null;
	}

	return { runId, runNumber: Number(runNumber) };
}

// The release workflow runs on the release's tag when a release changes, and on the trusted branch
// when it is started by hand to fill the store.
function isReleaseRef(env: Env, eventName: string, ref: string): boolean {
	if (eventName === 'release') {
		return ref.startsWith('refs/tags/');
	}

	if (eventName === 'workflow_dispatch') {
		return ref === `refs/heads/${env.GITHUB_BRANCH}`;
	}

	return false;
}

// False when the token is not from the release workflow.
export async function verifyReleaseToken(
	env: Env,
	token: string,
): Promise<boolean> {
	const claims = await verifyClaims(env, token);

	if (claims === null) {
		return false;
	}

	const eventName = claims.event_name ?? '';
	const ref = claims.ref ?? '';

	if (!isReleaseRef(env, eventName, ref)) {
		return false;
	}

	if (claims.runner_environment !== 'github-hosted') {
		return false;
	}

	return isFromWorkflow(claims, env.GITHUB_RELEASE_WORKFLOW, ref);
}
