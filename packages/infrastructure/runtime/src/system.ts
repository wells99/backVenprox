import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator } from '../../../application/src/ports.js';

export const systemClock: Clock = { now: () => new Date() };
export const uuidGenerator: IdGenerator = { generate: () => randomUUID() };
export const backendVersion = '0.1.0';

export function assertSupportedRuntime(): void {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor === undefined || minor < 16) throw new Error('UNSUPPORTED_NODE_RUNTIME');
}
