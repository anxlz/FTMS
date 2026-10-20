/** Semantic version of the API package; bump alongside `package.json`. */
export const API_PACKAGE_VERSION = '0.0.0';

/** Version string reported by `/health`, suffixed with the deployed commit on Vercel. */
export function apiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const commit = env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
  return commit ? `${API_PACKAGE_VERSION}+${commit}` : API_PACKAGE_VERSION;
}
