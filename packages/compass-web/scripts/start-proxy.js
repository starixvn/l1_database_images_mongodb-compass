#!/usr/bin/env node
'use strict';

const { createWebSocketProxy } = require('./ws-proxy');

// Get port from environment variable or default to 8081
const port = process.env.WS_PROXY_PORT || 8081;

console.log(`Starting WebSocket proxy on port ${port}...`);

// Create and start the WebSocket proxy server
const server = createWebSocketProxy(port);

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('WebSocket proxy server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('WebSocket proxy server closed');
    process.exit(0);
  });
});

// Keep the process alive
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
