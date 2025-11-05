// @ts-expect-error import vs require
import { ipVersion } from 'is-ip';
import type { ConnectionOptions } from 'mongodb-data-service';
import { Duplex } from 'stream';
import { WS_PROXY_URL } from './ws-url';

/**
 * net.Socket interface that works over the WebSocket connection. For now, only
 * used when running compass-web in a local sandbox, mms has their own
 * implementation
 */

type LookupResult = {
  wsURL?: string;
  clusterName?: string;
};

type SocketConnectionOptions = {
  host?: string;
  port?: number;
  path?: string;
  tls?: boolean;
};

type SocketConnectOptions = SocketConnectionOptions & {
  lookup?: ConnectionOptions['lookup'];
};

enum MESSAGE_TYPE {
  JSON = 0x01,
  BINARY = 0x02,
}

class Socket extends Duplex {
  private _ws: WebSocket | null = null;
  constructor() {
    super();
  }
  connect({ lookup, ...options }: SocketConnectOptions) {
    // Validate connection parameters
    const hasHostPort = options.host && options.port;
    const hasPath = options.path;

    if (!hasHostPort && !hasPath) {
      throw new Error(
        'Connection requires either host+port or path for Unix socket'
      );
    }

    if (hasHostPort && hasPath) {
      throw new Error(
        'Connection cannot have both host+port and path - choose one'
      );
    }

    const { wsURL, ...atlasOptions } = lookup?.() ?? ({} as LookupResult);
    const finalWsUrl = wsURL ?? WS_PROXY_URL ?? '/ws-proxy';

    console.log('[Compass Web] Establishing WebSocket connection:', {
      targetHost: options.host,
      targetPort: options.port,
      targetPath: options.path,
      useTLS: options.tls ?? false,
      atlasWsURL: wsURL || '(not provided)',
      configuredProxyURL: WS_PROXY_URL,
      finalWebSocketURL: finalWsUrl,
    });

    this._ws = new WebSocket(finalWsUrl);
    this._ws.binaryType = 'arraybuffer';

    // Add detailed WebSocket connection debugging
    this._ws.addEventListener('open', () => {
      console.log(
        '[Compass Web] (I) WebSocket opened successfully to:',
        finalWsUrl
      );
    });

    this._ws.addEventListener('error', (error) => {
      console.error('[Compass Web] (E) WebSocket connection error:', {
        url: finalWsUrl,
        error: error,
        readyState: this._ws?.readyState,
        readyStateText:
          this._ws?.readyState === 0
            ? 'CONNECTING'
            : this._ws?.readyState === 1
            ? 'OPEN'
            : this._ws?.readyState === 2
            ? 'CLOSING'
            : this._ws?.readyState === 3
            ? 'CLOSED'
            : 'UNKNOWN',
      });
    });

    this._ws.addEventListener(
      'open',
      () => {
        // Build connection message based on connection type
        const connectMsg = options.path
          ? JSON.stringify({
              // Unix socket connection
              connectOptions: {
                path: options.path,
              },
              tls: options.tls ?? false,
              setOptions: {
                setKeepAlive: { enabled: true, initialDelay: 300000 },
                setTimeout: { timeout: 30000 },
                setNoDelay: { noDelay: true },
              },
            })
          : JSON.stringify({
              // TCP connection (legacy format)
              connectOptions: {
                host: options.host,
                port: options.port,
              },
              tls: options.tls ?? false,
              clusterName: atlasOptions.clusterName,
              setOptions: {
                setKeepAlive: { enabled: true, initialDelay: 300000 },
                setTimeout: { timeout: 30000 },
                setNoDelay: { noDelay: true },
              },
            });

        console.log(
          '[Compass Web] (I) Sending connection message:',
          JSON.parse(connectMsg)
        );

        setTimeout(() => {
          this._ws?.send(this.encodeStringMessageWithTypeByte(connectMsg));
        });
      },
      { once: true }
    );
    this._ws.addEventListener('close', (event) => {
      console.log('[Compass Web] (I) WebSocket closed:', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        url: finalWsUrl,
      });
      this.emit('close');
    });

    this._ws.addEventListener('error', (event) => {
      console.error('[Compass Web] (E) WebSocket error event:', {
        event: event,
        url: finalWsUrl,
        readyState: this._ws?.readyState,
      });
      this.emit(
        'error',
        new Error(`WebSocket connection failed to ${finalWsUrl}: ${event.type}`)
      );
    });
    this._ws.addEventListener(
      'message',
      ({ data }: MessageEvent<ArrayBuffer>) => {
        const dataView = new Uint8Array(data);
        if (dataView[0] === 0x01) {
          try {
            const res = this.decodeMessageWithTypeByte(dataView);
            if (res.preMessageOk) {
              setTimeout(() => {
                this.emit(options.tls ? 'secureConnect' : 'connect');
              });
            } else if (res.error) {
              // Handle detailed error messages from proxy
              const errorMsg = `WebSocket proxy error: ${res.message} (event: ${res.event}, code: ${res.code}, target: ${res.target})`;
              console.error('[Compass Web] (E) WebSocket Proxy Error:', res);
              setTimeout(() => {
                this.emit('error', new Error(errorMsg));
              });
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('error parsing proxy message "%s":', data, err);
          }
        } else {
          setTimeout(() => {
            this.emit('data', this.decodeMessageWithTypeByte(dataView));
          });
        }
      }
    );
    return this;
  }
  _read() {
    // noop
  }
  _write(chunk: ArrayBufferLike, _encoding: BufferEncoding, cb: () => void) {
    this._ws?.send(this.encodeBinaryMessageWithTypeByte(new Uint8Array(chunk)));
    setTimeout(() => {
      cb();
    });
  }
  destroy() {
    this._ws?.close();
    return this;
  }
  end(fn?: () => void) {
    if (this._ws?.readyState === this._ws?.CLOSED) {
      setTimeout(() => {
        fn?.();
      });
      return this;
    }
    this._ws?.addEventListener(
      'close',
      () => {
        fn?.();
      },
      { once: true }
    );
    this._ws?.close();
    return this;
  }
  setKeepAlive() {
    return this;
  }
  setTimeout() {
    return this;
  }
  setNoDelay() {
    return this;
  }

  encodeStringMessageWithTypeByte(message: string) {
    const utf8Encoder = new TextEncoder();
    const utf8Array = utf8Encoder.encode(message);
    return this.encodeMessageWithTypeByte(utf8Array, MESSAGE_TYPE.JSON);
  }

  encodeBinaryMessageWithTypeByte(message: Uint8Array) {
    return this.encodeMessageWithTypeByte(message, MESSAGE_TYPE.BINARY);
  }

  encodeMessageWithTypeByte(message: Uint8Array, type: MESSAGE_TYPE) {
    const encoded = new Uint8Array(message.length + 1);
    encoded[0] = type;
    encoded.set(message, 1);
    return encoded;
  }

  decodeMessageWithTypeByte(message: Uint8Array) {
    const typeByte = message[0];
    if (typeByte === Number(MESSAGE_TYPE.JSON)) {
      const jsonBytes = message.subarray(1);
      const textDecoder = new TextDecoder('utf-8');
      const jsonStr = textDecoder.decode(jsonBytes);
      return JSON.parse(jsonStr);
    } else if (typeByte === Number(MESSAGE_TYPE.BINARY)) {
      return message.subarray(1);
    } else {
      // eslint-disable-next-line no-console
      console.error('message does not have valid type byte "%s"', message);
    }
  }
}

// @ts-expect-error import vs require
export { isIPv4, isIPv6 } from 'is-ip';
export const isIP = (input: string) => ipVersion(input) ?? 0;
export const createConnection = (options: SocketConnectionOptions) => {
  const socket = new Socket();
  setTimeout(() => {
    socket.connect(options);
  });
  return socket;
};
