import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Inject,
  Optional,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import type { AuthenticatedRequest } from './authenticated-request.js';
import type {
  McpProposalIdentity,
  RequestIdentity,
} from './request-identity.js';
import type { FastifyRequest } from 'fastify';
import { JoseJwtVerifier } from './jose-jwt-verifier.js';
import { CliTokenVerifier } from './cli-token-verifier.js';
import { CLI_SCOPE_POLICY, routeKey } from './cli-scope-policy.js';
import {
  MCP_READ_ADMISSION,
  MCP_READ_METADATA,
  type McpReadAdmission,
  type McpReadDeclaration,
} from './mcp-read-auth.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  public constructor(
    private readonly verifier: JoseJwtVerifier,
    private readonly cliTokenVerifier: CliTokenVerifier,
    @Optional()
    @Inject(MCP_READ_ADMISSION)
    private readonly admitMcpRead?: McpReadAdmission,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (token === undefined) throw new UnauthorizedException();

    let identity: RequestIdentity;
    try {
      identity = await (token.startsWith('svt_')
        ? this.cliTokenVerifier.verify(token)
        : this.verifier.verify(token));
    } catch {
      if (token.startsWith('svt_') || !this.admitMcpRead)
        throw new UnauthorizedException();
      const declaration = Reflect.getOwnMetadata(
        MCP_READ_METADATA,
        context.getHandler(),
      ) as McpReadDeclaration | undefined;
      if (!declaration) throw new UnauthorizedException();
      let mcp: McpProposalIdentity;
      try {
        mcp = await this.verifier.verifyProposal(token);
      } catch {
        throw new UnauthorizedException();
      }
      const workspaceIds = await this.admitMcpRead(mcp, declaration, request);
      if (!workspaceIds?.length) throw new ForbiddenException();
      identity = { ...mcp, authMethod: 'mcp_read', workspaceIds };
    }
    request.identity = identity;
    if (identity.authMethod === 'cli_token') {
      const requiredScopes = CLI_SCOPE_POLICY.get(
        routeKey(request.method, request.routeOptions.url ?? request.url),
      );
      if (
        requiredScopes === undefined ||
        !requiredScopes.every((scope) => identity.scopes.includes(scope))
      ) {
        throw new ForbiddenException();
      }
    }
    return true;
  }
}

export interface McpProposalRequest extends FastifyRequest {
  proposalIdentity: McpProposalIdentity;
}

@Injectable()
export class McpProposalAuthGuard implements CanActivate {
  public constructor(private readonly verifier: JoseJwtVerifier) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<McpProposalRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token || token.startsWith('svt_')) throw new UnauthorizedException();
    try {
      request.proposalIdentity = await this.verifier.verifyProposal(token);
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

export function extractBearerToken(
  authorization: string | undefined,
): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? '');
  return match?.[1];
}
