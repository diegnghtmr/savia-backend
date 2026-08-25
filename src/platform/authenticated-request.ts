import type { FastifyRequest } from 'fastify';

import type { RequestIdentity } from './request-identity.js';

export interface AuthenticatedRequest extends FastifyRequest {
  identity: RequestIdentity;
}
