import { Agent, setGlobalDispatcher } from 'undici';

const SIDECAR_HTTP_CONNECT_TIMEOUT_MS = 10_000;
const SIDECAR_HTTP_KEEP_ALIVE_TIMEOUT_MS = 60_000;
const SIDECAR_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;
const SIDECAR_HTTP_CONNECTIONS_PER_ORIGIN = 10;
const SIDECAR_HTTP_PIPELINING = 1;

let configured = false;

export const configureGlobalHttpTransport = (): void => {
  if (configured) {
    return;
  }

  setGlobalDispatcher(new Agent({
    keepAliveTimeout: SIDECAR_HTTP_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: SIDECAR_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS,
    connections: SIDECAR_HTTP_CONNECTIONS_PER_ORIGIN,
    pipelining: SIDECAR_HTTP_PIPELINING,
    connect: {
      timeout: SIDECAR_HTTP_CONNECT_TIMEOUT_MS,
    },
  }));

  configured = true;
};
