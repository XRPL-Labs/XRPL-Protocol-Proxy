import { EventEmitter } from 'events';
import { log } from '../logging';
import { UpstreamClient, UpstreamTypes } from './upstream-client';

type UpstreamConnectivityEvents = {
  remove: [endpoint: string, endpointType: keyof UpstreamTypes];
};

const upstreamEventBus = new EventEmitter<UpstreamConnectivityEvents>();

const upstreams: Record<keyof UpstreamTypes, UpstreamClient[]> = {
  fullhistory: [],
  currentledger: [],
  pathfinding: [],
  submission: [],
};

const endpointReconnectAttempts: Record<string, number> = {};

const onUpstreamReady = (online: boolean, instance: UpstreamClient) => {
  log(
    'ALIVE STATE UPSTREAMCLIENT',
    instance.endpoint,
    instance.metadata.type,
    online,
  );

  if (online) {
    endpointReconnectAttempts[instance.endpoint] = 0;
  }
  if (!online) {
    instance.close();
    // Remove listener to allow for GC
    instance.off('alive', onUpstreamReady);

    const upstreamIndex = upstreams[instance.metadata.type].indexOf(instance);

    if (upstreamIndex > -1) {
      endpointReconnectAttempts[instance.endpoint]++;

      /**
       * Kick off reconnection attempts
       */
      upstreamEventBus.emit(
        'remove',
        instance.endpoint,
        instance.metadata.type,
      );

      upstreams[instance.metadata.type].splice(upstreamIndex, 1);
    }
  }
};

const addUpstream = (uri: string, type: keyof UpstreamTypes) => {
  log('Add upstream', uri, type);

  if (Object.keys(endpointReconnectAttempts).indexOf(uri) < 0) {
    Object.assign(endpointReconnectAttempts, { [uri]: 0 });
  }

  if (Object.keys(upstreams).indexOf(type) < 0) {
    return false;
  }

  const upstream = new UpstreamClient(uri, { type });

  upstream.on('alive', onUpstreamReady);

  upstreams[type].push(upstream);

  return true;
};

/**
 * Reconnect
 */

upstreamEventBus.on('remove', (endpoint, type) => {
  const attempt = endpointReconnectAttempts[endpoint];
  const reconnectInMs =
    attempt < 10
      ? 1_000 // < 10 attempts: one second
      : attempt < 30
      ? 5_000 // < 30 attempts: five seconds
      : attempt < 100
      ? 30_000 // < 100 attempts: 30 seconds (half a minute)
      : 300_000; // Five minutes (offline for a long time)

  log('Reconnect in ms', reconnectInMs, endpoint, type, attempt);

  setTimeout(() => {
    addUpstream(endpoint, type);
  }, reconnectInMs);
});

/**
 * DEV
 */
const connectUplinks = () => {
  addUpstream('https://xrplcluster.com', 'currentledger');
};

export { connectUplinks };

setInterval(() => {
  const l: UpstreamClient[] = Object.values(upstreams).flat();

  console.log('-'.repeat(20) + ' ' + new Date() + ' ' + '-'.repeat(20));
  console.log(endpointReconnectAttempts);
  console.log(
    l
      .map((upstream: UpstreamClient) => {
        return {
          type: upstream.metadata.type,
          endpoint: upstream.endpoint,
          isAlive: upstream.isAlive,
          unansweredPings: upstream.unansweredPings,
        };
      })
      .filter((r) => r.isAlive),
  );
}, 3000);
