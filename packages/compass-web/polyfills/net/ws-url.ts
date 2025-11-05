/** WebSocket proxy URL with configurable protocol, host, and port */

// Allow complete URL override for maximum flexibility
const WS_PROXY_URL_OVERRIDE = process.env.COMPASS_WEBSOCKET_PROXY_URL;

// Individual URL components with defaults
const WS_PROXY_PROTOCOL = process.env.COMPASS_WEBSOCKET_PROXY_PROTOCOL || 'ws';
const WS_PROXY_HOST = process.env.COMPASS_WEBSOCKET_PROXY_HOST || 'localhost';
const WS_PROXY_PORT = process.env.COMPASS_WEBSOCKET_PROXY_PORT || '1337';

// Construct URL from components or use override
const WS_PROXY_URL = WS_PROXY_URL_OVERRIDE || `${WS_PROXY_PROTOCOL}://${WS_PROXY_HOST}:${WS_PROXY_PORT}`;

// Log the final WebSocket proxy URL configuration for debugging
console.log('📡 WebSocket Proxy Configuration:', {
  protocol: WS_PROXY_PROTOCOL,
  host: WS_PROXY_HOST,
  port: WS_PROXY_PORT,
  urlOverride: WS_PROXY_URL_OVERRIDE || '(not set)',
  finalUrl: WS_PROXY_URL,
});

export { WS_PROXY_URL };
