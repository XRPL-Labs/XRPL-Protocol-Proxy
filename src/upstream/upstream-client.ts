import { EventEmitter } from 'events';
import { log } from '../logging';

/**
 * TODO:
 *    On ready: add required subscriptions, etc.
 */

export interface UpstreamTypes {
  fullhistory: UpstreamClient[];
  currentledger: UpstreamClient[];
  pathfinding: UpstreamClient[];
  submission: UpstreamClient[];
}

export interface UpstreamOptions {
  connectTimeout: number;
  readyTimeout: number;
}

export type UpstreamClientMetadata = {
  type: keyof UpstreamTypes;
} & AnyJson;

type UpstreamClientEvents = {
  alive: [isAlive: boolean, instance: UpstreamClient];
};

export type AnyJson = {
  [key: string]: any;
};

type XrplProtocolComandResponse = {
  id?: XrplProtocolCommandId;
  result?: AnyJson;
  status?: string;
  type?: string;
};

type XrplProtocolServerInfo = XrplProtocolComandResponse & {
  result: {
    info: AnyJson & {
      build_version: string;
      complete_ledgers: string;
      hostid: string;
      pubkey_node: string;
      peers: number;
      load_factor: number;
      network_id: number;
      server_state: string;
      time: string;
      uptime: number;
      validated_ledger: {
        age: number;
        base_fee_xrp: number;
        hash: string;
        reserve_base_xrp: number;
        reserve_inc_xrp: number;
        seq: number;
      };
    };
  };
  status: string;
  type: string;
};

type XrplProtocolCommandId =
  | string
  | number
  | (AnyJson & {
      suppressResponse?: boolean;
    });

type XrplProtocolCommand = {
  id?: XrplProtocolCommandId;
  command: string;
  [key: string]: any;
};

class UpstreamClient extends EventEmitter<UpstreamClientEvents> {
  public isAlive: boolean | null = null; // Not only connected, but also received first server_info
  public endpoint: string;
  public metadata: UpstreamClientMetadata;
  public options: UpstreamOptions = {
    connectTimeout: 5000,
    readyTimeout: 5000,
  };
  public unansweredPings = 0;

  private socket?: WebSocket;
  private keepaliveInterval?: ReturnType<typeof setInterval>;
  private lastServerInfo?: XrplProtocolServerInfo;

  private connectTimeout: ReturnType<typeof setTimeout>;
  private readyTimeout?: ReturnType<typeof setTimeout>;

  constructor(
    endpoint: string,
    metadata: UpstreamClientMetadata,
    options?: UpstreamOptions,
  ) {
    super();

    Object.assign(this.options, options || {});

    this.connectTimeout = setTimeout(() => {
      log(
        'CONNECT TIMEOUT, KILLING',
        endpoint,
        metadata.type,
        this.options.connectTimeout,
      );
      this.close();
    }, this.options.connectTimeout);

    this.endpoint = endpoint;
    this.metadata = metadata;

    log('Websocket Upstream Client to', this.endpoint);

    try {
      this.socket = new WebSocket(this.endpoint, {
        headers: {
          // custom headers
        },
      });

      // message is received
      this.socket.addEventListener('message', (event) => {
        const data: XrplProtocolComandResponse = JSON.parse(
          String(event?.data || '') || '{}',
        );
        if (
          typeof data === 'object' &&
          data !== null &&
          Object.keys(data).length > 0
        ) {
          const suppressResponse =
            typeof data?.id === 'object' &&
            data.id !== null &&
            data.id?.suppressResponse === true;

          if (!suppressResponse) {
            log('Websocket MESSAGE', this.endpoint, data);
          }

          if (
            data.type === 'response' &&
            typeof data?.id === 'object' &&
            data?.id !== null
          ) {
            if (data?.id?.pong) {
              /**
               * TODO:
               *   Flag connection as dead if no response for a while
               */
              // log('Received pong from', this.endpoint)

              this.unansweredPings = 0;
              /**
               * Only signal to be back alive if previously had full server contact
               */
              if (this.lastServerInfo?.result?.info?.build_version) {
                this.setAlive(true);
              }
            }
          }

          /**
           * Handle server_info response
           */
          if (
            data.status === 'success' &&
            data.type === 'response' &&
            data?.result?.info?.build_version
          ) {
            const server_info = (data as XrplProtocolServerInfo).result.info;

            // First server_info response
            if (!this.lastServerInfo) {
              log('First `server_info` response', {
                endpoint: this.endpoint,
                hostid: server_info.hostid,
                network_id: server_info.network_id,
                build_version: server_info.build_version,
                complete_ledgers: server_info.complete_ledgers,
              });

              // TODO: Check if meets params to be ready
              this.setAlive(true);
            }

            this.lastServerInfo = data as XrplProtocolServerInfo;
          }
        }
      });

      /**
       * Socket opened
       */
      this.socket.addEventListener('open', (event) => {
        clearTimeout(this.connectTimeout);

        this.readyTimeout = setTimeout(() => {
          log(
            'READY TIMEOUT, KILLING',
            endpoint,
            metadata.type,
            this.options.connectTimeout,
          );
          this.close();
        }, this.options.readyTimeout);

        this.startKeepalive();

        log('Websocket OPEN', {
          endpoint: this.endpoint,
          open: (event.target as WebSocket)?.readyState === this.socket?.OPEN,
          eventType: event.type,
        });

        this.sendRaw({
          id: {
            suppressResponse: true,
          },
          command: 'server_info',
        });
      });

      /**
       * Socket closed
       * TODO: Cleanup
       */
      this.socket.addEventListener('close', (event) => {
        this.setAlive(false);
        log(
          'Websocket CLOSE',
          this.endpoint,
          event.type,
          event.reason,
          event.code,
          event.wasClean,
          (event.target as WebSocket)?.readyState,
        );
      });

      /**
       * Error on socket
       */
      this.socket.addEventListener('error', (event) => {
        // TODO
        log('Websocket ERROR', event);
      });
    } catch (e) {
      log('Could not connect Websocket', (e as Error).message);
      /**
       * Don't close / isAlive(false) here!
       * The keepalive time-out timer will take care of this!
       */
    }
  }

  /**
   * Keepalive to prevent websocket from falling dry
   */
  startKeepalive() {
    this.keepaliveInterval = setInterval(() => {
      if (this.socket && this.socket.readyState === this.socket.OPEN) {
        /**
         * Send a PING to keep the connection alive
         */
        this.sendRaw({
          id: {
            suppressResponse: true,
            pong: true,
          },
          command: 'ping',
        });

        this.unansweredPings++;

        if (this.unansweredPings > 3) {
          // Assume offline, signal
          this.setAlive(false);
        }
      } else {
        /**
         * Socket ready state no longer in OPEN state
         */
        this.close();
      }
    }, 1_500);
  }

  sendRaw(command: XrplProtocolCommand) {
    return this.socket?.send(JSON.stringify(command));
  }

  close() {
    this.setAlive(false);
    this?.socket?.close();

    clearInterval(this.keepaliveInterval);
    clearTimeout(this.connectTimeout);
    clearTimeout(this.readyTimeout);
  }

  setAlive(isAlive: boolean) {
    if (isAlive) {
      clearTimeout(this.readyTimeout);
    }

    if (this.isAlive !== isAlive) {
      log('Uplink changing ready state', {
        endpoint: this.endpoint,
        was: this.isAlive,
        is: isAlive,
      });

      this.isAlive = isAlive;
      this.emit('alive', isAlive, this);
    }
  }
}

export { UpstreamClient };
