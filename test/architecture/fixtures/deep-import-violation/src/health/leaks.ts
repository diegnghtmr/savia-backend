import { internalIdentity } from '../identity/internal.js';

export function healthLeak(): string {
  return internalIdentity();
}
