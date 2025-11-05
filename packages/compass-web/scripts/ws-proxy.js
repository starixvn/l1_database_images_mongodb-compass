'use strict';
const net = require('net');
const tls = require('tls');
const { WebSocketServer } = require('ws');

/**
 * Creates a simple passthrough proxy that accepts a websocket connection and
 * establishes a corresponding socket connection to a server. The connection
 * flow starts by the frontend sending a connection options message after which
 * every follow-up message is directly written to the opened socket stream
 */
function createWebSocketProxy(port = 1337, logger = console) {
  const wsServer = new WebSocketServer({ host: '0.0.0.0', port }, () => {
    logger.log(
      'ws-proxy.js',
      `ws server listening at ws://${wsServer.options.host}:${wsServer.options.port}`
    );
  });

  const SOCKET_ERROR_EVENT_LIST = ['error', 'close', 'timeout', 'parseError'];

  wsServer.on('connection', (ws) => {
    let socket;
    let socketConnected = false;
    let connectionEstablished = false; // Track if we've processed connection options
    const wsId = Math.random().toString(36).substring(7);
    const messageBuffer = []; // Buffer messages until connection is established
    logger.log(
      'ws-proxy.js',
      `new ws connection [${wsId}] (total ${wsServer.clients.size})`
    );
    ws.on('close', () => {
      logger.log('ws-proxy.js', `ws closed [${wsId}]`);
      socket?.removeAllListeners();
      socket?.end();
    });
    ws.on('message', async (data) => {
      try {
        logger.log(
          'ws-proxy.js',
          `[${wsId}] Received message: ${data.length} bytes, type: 0x${data[0]
            ?.toString(16)
            .padStart(
              2,
              '0'
            )}, socket=${!!socket}, connected=${socketConnected}, established=${connectionEstablished}`
        );

        if (socket && socketConnected) {
          // Socket is established and connected, forward message to MongoDB
          logger.log(
            'ws-proxy.js',
            `[${wsId}] Forwarding message to MongoDB socket`
          );
          socket.write(decodeMessageWithTypeByte(data), 'binary');
        } else if (socket && !socketConnected) {
          // Socket exists but not yet connected, buffer the message
          logger.log(
            'ws-proxy.js',
            `[${wsId}] Buffering message while socket is connecting`
          );
          messageBuffer.push(data);
        } else if (!connectionEstablished) {
          // No socket yet - try to find connection options in any message
          const decoded = decodeMessageWithTypeByte(data);
          if (!decoded || typeof decoded !== 'object') {
            throw new Error('Received non-object message');
          }
          logger.log('ws-proxy.js', `[${wsId}] Decoded message:`, decoded);

          // Check if this contains connection options
          const hasConnectionInfo =
            decoded.connectOptions || decoded.host || decoded.path;
          if (hasConnectionInfo) {
            logger.log(
              'ws-proxy.js',
              `[${wsId}] Found connection options, establishing connection`
            );
            connectionEstablished = true;
            const originalDecoded = decoded;

            // Process connection options
            await processConnectionOptions(originalDecoded);
          } else {
            logger.log(
              'ws-proxy.js',
              `[${wsId}] Non-connection message, buffering:`,
              decoded
            );
            messageBuffer.push(data);
          }
        } else {
          // Connection established but socket not ready, buffer
          logger.log(
            'ws-proxy.js',
            `[${wsId}] Connection established but socket not ready, buffering message`
          );
          messageBuffer.push(data);
        }

        // Helper function to process connection options
        async function processConnectionOptions(originalDecoded) {
          // Handle multiple connection option schema formats
          let connectOptions, useSecureConnection;

          if (
            originalDecoded.connectOptions &&
            typeof originalDecoded.connectOptions === 'object'
          ) {
            // New nested structure: { connectOptions: { host, port } or { path }, tls: boolean, setOptions: {...} }
            logger.log('ws-proxy.js', `[${wsId}] Using new nested schema`);
            connectOptions = originalDecoded.connectOptions;
            useSecureConnection = originalDecoded.tls || false;
          } else if (originalDecoded.host && originalDecoded.port) {
            // Old flat structure: { host, port, tls, clusterName, ok, ... }
            logger.log('ws-proxy.js', `[${wsId}] Using old flat schema`);
            const { tls, clusterName, ok, ...options } = originalDecoded;
            connectOptions = options;
            useSecureConnection = tls || false;
          } else if (originalDecoded.path) {
            // Unix socket structure: { path, tls, ... }
            logger.log('ws-proxy.js', `[${wsId}] Using Unix socket schema`);
            const { tls, ...options } = originalDecoded;
            connectOptions = options;
            useSecureConnection = tls || false;
          } else {
            // Fallback: try to extract any structure
            logger.log(
              'ws-proxy.js',
              `[${wsId}] Using fallback schema detection`
            );
            const { tls, ...options } = originalDecoded;
            connectOptions = options;
            useSecureConnection = tls || false;
          }

          // Validate required connection properties (either host/port or path for Unix socket)
          const hasHostPort = connectOptions.host && connectOptions.port;
          const hasPath = connectOptions.path;
          if (!hasHostPort && !hasPath) {
            throw new Error(
              `Missing connection properties: need either host+port or path`
            );
          }

          const connectionType = connectOptions.path ? 'Unix socket' : 'TCP';
          const connectionTarget =
            connectOptions.path ||
            `${connectOptions.host}:${connectOptions.port}`;

          logger.log('ws-proxy.js', `[${wsId}] Final connection options:`, {
            host: connectOptions.host,
            port: connectOptions.port,
            path: connectOptions.path,
            tls: useSecureConnection,
            type: connectionType,
            additionalOptions: Object.keys(connectOptions).filter(
              (k) => !['host', 'port', 'path'].includes(k)
            ),
          });

          logger.log(
            'ws-proxy.js',
            `[${wsId}] setting up new${
              useSecureConnection ? ' secure' : ''
            } ${connectionType} connection to ${connectionTarget}`
          );

          socket = useSecureConnection
            ? tls.connect(
                connectOptions.path
                  ? { path: connectOptions.path, ...connectOptions }
                  : {
                      host: connectOptions.host,
                      port: connectOptions.port,
                      servername: connectOptions.host,
                      // MongoDB Atlas TLS options
                      rejectUnauthorized: true,
                      checkServerIdentity: tls.checkServerIdentity,
                      secureProtocol: 'TLSv1_2_method',
                      ciphers:
                        'HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA',
                      ...connectOptions,
                    }
              )
            : net.createConnection(connectOptions);
          socket.setKeepAlive(true, 300000);
          socket.setTimeout(30000);
          socket.setNoDelay(true);
          const connectEvent = useSecureConnection
            ? 'secureConnect'
            : 'connect';

          SOCKET_ERROR_EVENT_LIST.forEach((evt) => {
            socket.on(evt, (err) => {
              logger.log(
                'ws-proxy.js',
                `[${wsId}] server socket error event (${evt})`,
                err
              );

              // Send detailed error message to client before closing
              try {
                const errorMsg = {
                  error: true,
                  event: evt,
                  message: err?.message || `Socket ${evt} event`,
                  code: err?.code || 'UNKNOWN',
                  target: connectionTarget,
                  tls: useSecureConnection,
                };
                const encoded = encodeStringMessageWithTypeByte(
                  JSON.stringify(errorMsg)
                );
                ws.send(encoded);
              } catch (sendErr) {
                logger.log(
                  'ws-proxy.js',
                  `[${wsId}] Failed to send error message:`,
                  sendErr
                );
              }

              // Close with specific error codes based on event type
              const closeCode =
                evt === 'close'
                  ? 1001
                  : evt === 'timeout'
                  ? 1008
                  : evt === 'error'
                  ? 1011
                  : 1002;
              const closeReason = err?.message
                ? err.message.length > 100
                  ? err.message.substring(0, 100) + '...'
                  : err.message
                : `Socket ${evt}`;

              ws.close(closeCode, closeReason);
            });
          });

          socket.on(connectEvent, () => {
            socketConnected = true;
            logger.log(
              'ws-proxy.js',
              `[${wsId}] server socket connected at ${connectionTarget}`
            );
            socket.setTimeout(0);

            // Send connection success message
            const encoded = encodeStringMessageWithTypeByte(
              JSON.stringify({ preMessageOk: 1 })
            );
            ws.send(encoded);

            // Process any buffered messages
            if (messageBuffer.length > 0) {
              logger.log(
                'ws-proxy.js',
                `[${wsId}] Processing ${messageBuffer.length} buffered messages`
              );
              messageBuffer.forEach((bufferedData, index) => {
                try {
                  logger.log(
                    'ws-proxy.js',
                    `[${wsId}] Forwarding buffered message ${index + 1}`
                  );
                  socket.write(
                    decodeMessageWithTypeByte(bufferedData),
                    'binary'
                  );
                } catch (err) {
                  logger.log(
                    'ws-proxy.js',
                    `[${wsId}] Error processing buffered message ${index + 1}:`,
                    err.message
                  );
                }
              });
              messageBuffer.length = 0; // Clear buffer
            }
          });

          socket.on('data', async (data) => {
            ws.send(encodeBinaryMessageWithTypeByte(data));
          });
        }
      } catch (err) {
        logger.log(
          'ws-proxy.js',
          `[${wsId}] Message handling error: ${err.message}`
        );
        // Keep close message under 123 bytes limit
        const shortError =
          err.message.length > 100
            ? err.message.substring(0, 100) + '...'
            : err.message;
        ws.close(1002, shortError);
      }
    });
  });

  return wsServer;
}

function encodeStringMessageWithTypeByte(message) {
  const utf8Encoder = new TextEncoder();
  const utf8Array = utf8Encoder.encode(message);
  return encodeMessageWithTypeByte(utf8Array, 0x01);
}

function encodeBinaryMessageWithTypeByte(message) {
  return encodeMessageWithTypeByte(message, 0x02);
}

function encodeMessageWithTypeByte(message, type) {
  const encoded = new Uint8Array(message.length + 1);
  encoded[0] = type;
  encoded.set(message, 1);
  return encoded;
}

function decodeMessageWithTypeByte(message) {
  if (!message || message.length === 0) {
    throw new Error('Empty or invalid message received');
  }

  const typeByte = message[0];
  if (typeByte === 0x01) {
    const jsonBytes = message.subarray(1);
    const textDecoder = new TextDecoder('utf-8');
    const jsonStr = textDecoder.decode(jsonBytes);
    try {
      return JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(`Failed to parse JSON message: ${err.message}`);
    }
  } else if (typeByte === 0x02) {
    return message.subarray(1);
  } else if (typeByte === 0x7b) {
    // '{' - raw JSON without type byte (backward compatibility)
    console.warn(
      'ws-proxy.js: Received raw JSON message without type byte. Please use encodeStringMessageWithTypeByte() on the client side.'
    );
    const textDecoder = new TextDecoder('utf-8');
    const jsonStr = textDecoder.decode(message);
    try {
      return JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(`Failed to parse raw JSON message: ${err.message}`);
    }
  } else {
    throw new Error(
      `Unknown message type byte: 0x${typeByte.toString(16).padStart(2, '0')}`
    );
  }
}

module.exports = { createWebSocketProxy };
