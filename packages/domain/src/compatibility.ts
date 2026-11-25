export interface CompatibilityPolicy {
  readonly minimum_app_version: string;
  readonly supported_protocol_versions: readonly number[];
}

// Versões publicadas estáveis; pré-releases terão política própria em B02.
export function createCompatibilityPolicy(
  minimumAppVersion: string,
  supportedProtocols: readonly number[],
): CompatibilityPolicy {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(minimumAppVersion)) {
    throw new Error('INVALID_APP_VERSION');
  }
  if (supportedProtocols.length === 0 ||
      supportedProtocols.some((version) => !Number.isSafeInteger(version) || version < 1) ||
      new Set(supportedProtocols).size !== supportedProtocols.length) {
    throw new Error('INVALID_PROTOCOL_VERSIONS');
  }
  return Object.freeze({
    minimum_app_version: minimumAppVersion,
    supported_protocol_versions: Object.freeze([...supportedProtocols].sort((a, b) => a - b)),
  });
}
