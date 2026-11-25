import type { CompatibilityPolicy } from '../../domain/src/compatibility.js';

export function createGetCompatibility(policy: CompatibilityPolicy, backendVersion: string) {
  return () => ({
    backend_version: backendVersion,
    minimum_app_version: policy.minimum_app_version,
    supported_protocol_versions: [...policy.supported_protocol_versions],
  });
}
