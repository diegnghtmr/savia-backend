import { createServer } from 'node:http';
import { once } from 'node:events';
export interface JwksResponse {
  readonly kind: 'jwks' | 'text' | 'delay' | 'close';
  readonly body?: unknown;
  readonly statusCode?: number;
  readonly milliseconds?: number;
}
export interface JwksServer {
  readonly uri: string;
  readonly requestCount: number;
  setResponse(response: JwksResponse): void;
  close(): Promise<void>;
}
export async function createJwksServer(initialResponse: JwksResponse) {
  let response = initialResponse;
  let requestCount = 0;
  const server = createServer((_request, reply) => {
    requestCount += 1;
    if (response.kind === 'delay') {
      // Captured, so a later setResponse cannot change what this in-flight
      // request eventually sends. With a body, the delayed reply is a VALID
      // JWKS: that is what lets a caller prove its own fetch timeout fired,
      // because without the timeout the verification would simply succeed.
      const delayed = response;
      setTimeout(() => {
        if (delayed.body === undefined) {
          reply.end();
          return;
        }
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify(delayed.body));
      }, delayed.milliseconds ?? 0);
      return;
    }
    if (response.kind === 'close') {
      reply.destroy();
      return;
    }
    if (response.kind === 'text') {
      reply
        .writeHead(response.statusCode ?? 500, { 'content-type': 'text/plain' })
        .end(String(response.body));
      return;
    }
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(response.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('JWKS server did not bind a TCP address.');
  }
  return {
    uri: `http://127.0.0.1:${address.port}/jwks`,
    get requestCount(): number {
      return requestCount;
    },
    setResponse(nextResponse: JwksResponse): void {
      response = nextResponse;
    },
    async close(): Promise<void> {
      server.close();
      await once(server, 'close');
    },
  };
}
