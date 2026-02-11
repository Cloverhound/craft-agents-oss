/**
 * @craft-agent/credential-proxy
 *
 * Transparent MITM HTTPS proxy that auto-injects credentials into HTTP
 * requests matching URL patterns. Replaces auth-curl with a proxy that
 * works with any HTTP client.
 */

export { startProxy, type ProxyInstance, type ProxyOptions } from './proxy';
export { CallerRegistry, type CallerInfo, type CallerType, type PermissionMode } from './caller-registry';
export { generateCA, forgeServerCert, cleanupCA, type CACert, type ForgedCert } from './ca';
export { createCABundle, findSystemCABundle, cleanupCABundle } from './ca-bundle';
export {
  hostnameMatchesCredentials,
  matchCredentialForUrl,
  checkPermission,
  buildAuthHeaders,
  loadSecret,
  loadOAuthToken,
  loadCredentialSecret,
  interceptRequest,
  PermissionDeniedError,
  type InterceptedHeaders,
  type InterceptionResult,
  type PermissionCheckResult,
} from './interceptor';
