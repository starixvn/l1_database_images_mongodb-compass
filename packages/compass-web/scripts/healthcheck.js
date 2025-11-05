#!/usr/bin/env node
'use strict';

const net = require('net');

// Get port from environment variable or default to 8081
const port = process.env.WS_PROXY_PORT || 8081;
const host = 'localhost';

// Create a socket connection to test if the WebSocket proxy is listening
const socket = net.createConnection({ port, host }, () => {
  // Connection successful - service is healthy
  socket.end();
  process.exit(0);
});

// Set a timeout for the connection attempt
socket.setTimeout(2000, () => {
  socket.destroy();
  console.error(`Health check failed: timeout connecting to ${host}:${port}`);
  process.exit(1);
});

// Handle connection errors
socket.on('error', (err) => {
  console.error(`Health check failed: ${err.message}`);
  process.exit(1);
});

socket.on('close', () => {
  // If we get here and haven't exited yet, the connection was successful
  process.exit(0);
});
