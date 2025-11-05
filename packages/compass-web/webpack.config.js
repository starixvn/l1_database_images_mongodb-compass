'use strict';
const path = require('path');

// Load environment variables from .env file with highest priority
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const {
  webpack,
  createWebConfig,
  isServe,
  merge,
} = require('@mongodb-js/webpack-config-compass');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { createWebSocketProxy } = require('./scripts/ws-proxy');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function localPolyfill(name) {
  const basePath = path.resolve(__dirname, 'polyfills', ...name.split('/'));
  // Check for .tsx first (for React components), then fall back to .ts
  const tsxPath = path.join(basePath, 'index.tsx');
  const tsPath = path.join(basePath, 'index.ts');
  try {
    if (require('fs').existsSync(tsxPath)) {
      return tsxPath;
    }
  } catch (e) {
    // Fall through to .ts
  }
  return tsPath;
}

function normalizeDepName(name) {
  return name.replaceAll('@', '').replaceAll('/', '__');
}

function resolveDepEntry(name) {
  const monorepoPackagesDir = path.resolve(__dirname, '..');
  const resolvedPath = require.resolve(name);
  if (resolvedPath.startsWith(monorepoPackagesDir)) {
    const packageJson = require(`${name}/package.json`);
    const packageRoot = path.dirname(require.resolve(`${name}/package.json`));
    const entrypoint = path.join(packageRoot, packageJson['main']);
    return entrypoint;
  }
  return require.resolve(name);
}

/**
 * Takes in a webpack configuration for a library package and creates a
 * multi-compiler config that splits the library into multiple parts that can be
 * properly processed by another webpack compilation.
 *
 * This is opposed to using a webpack chunk splitting feature that will generate
 * the code that uses internal webpack module runtime that will not be handled
 * by any other bundler (see TODO). This custom code splitting is way less
 * advanced, but works well for leaf node dependencies of the package.
 *
 * TODO(COMPASS-9445): This naive implementation works well only for leaf
 * dependencies with a single export file. A better approach would be to coerce
 * webpack to produce a require-able web bundle, which in theory should be
 * possible with a combination of `splitChunks`, `chunkFormat: 'commonjs'`, and
 * `target: 'web'`, but in practice produced bundle doesn't work due to webpack
 * runtime exports not being built correctly. We should investigate and try to
 * fix this to remove this custom chunk splitting logic.
 */
function createSiblingBundleFromLeafDeps(
  config,
  deps,
  moduleType = 'commonjs2'
) {
  const siblings = Object.fromEntries(
    deps.map((depName) => {
      return [depName, `${moduleType} ./${normalizeDepName(depName)}.js`];
    })
  );
  const baseConfig = merge(config, { externals: siblings });
  const configs = [baseConfig].concat(
    deps.map((depName) => {
      return merge(baseConfig, {
        entry: resolveDepEntry(depName),
        output: {
          filename: `${normalizeDepName(depName)}.js`,
          library: { type: moduleType },
        },
      });
    })
  );
  return configs;
}

/**
 * Atlas Cloud uses in-flight compression that doesn't compress anything that is
 * bigger than 10MB, we want to make sure that compass-web assets stay under the
 * limit so that they are compressed when served
 */
const MAX_COMPRESSION_FILE_SIZE = 10_000_000;

module.exports = (env, args) => {
  const serve = isServe({ env });
  const buildSandbox = env.BUILD_TARGET === 'sandbox';
  const useSandboxConfig = serve || buildSandbox;
  const basePath = process.env.COMPASS_WEB_BASE_PATH || '';

  // Parse port environment variables
  const webpackDevServerPort = process.env
    .COMPASS_WEB_HTTP_WEBPACK_DEV_SERVER_PORT
    ? Number(process.env.COMPASS_WEB_HTTP_WEBPACK_DEV_SERVER_PORT)
    : 4242;
  const wsProxyPort = process.env.COMPASS_WEBSOCKET_PROXY_PORT
    ? Number(process.env.COMPASS_WEBSOCKET_PROXY_PORT)
    : 1337;

  // Parse WebSocket proxy configuration for reverse proxy support
  const wsProxyProtocol = process.env.COMPASS_WEBSOCKET_PROXY_PROTOCOL || 'ws';
  const wsProxyHost = process.env.COMPASS_WEBSOCKET_PROXY_HOST || 'localhost';
  const wsProxyUrlOverride = process.env.COMPASS_WEBSOCKET_PROXY_URL;

  // Parse boolean environment variables with defaults
  const readOnly = process.env.COMPASS_WEB_READ_ONLY !== 'false'; // default: true
  const enableImportExport =
    process.env.COMPASS_WEB_ENABLE_IMPORT_EXPORT === 'true'; // default: false
  const enableShell = process.env.COMPASS_WEB_ENABLE_SHELL === 'true'; // default: false
  const enableDirectConnection =
    process.env.COMPASS_WEB_DIRECT_CONNECTION === 'true'; // default: false

  let config = createWebConfig({
    ...args,
    hot: serve,
    entry: path.resolve(
      __dirname,
      useSandboxConfig ? 'sandbox' : 'src',
      'index.tsx'
    ),
  });

  delete config.externals;

  config = merge(config, {
    context: __dirname,
    resolve: {
      alias: {
        // Dependencies for the unsupported connection types in data-service
        '@mongodb-js/devtools-proxy-support/proxy-options': require.resolve(
          '@mongodb-js/devtools-proxy-support/proxy-options'
        ),
        '@mongodb-js/devtools-proxy-support': localPolyfill(
          '@mongodb-js/devtools-proxy-support'
        ),

        // Replace 'devtools-connect' with a package that just directly connects
        // using the driver (= web-compatible driver) logic, because devtools-connect
        // contains a lot of logic that makes sense in a desktop application/CLI but
        // not in a web environment (DNS resolution, OIDC, CSFLE/QE, etc.)
        '@mongodb-js/devtools-connect': localPolyfill(
          '@mongodb-js/devtools-connect'
        ),

        // Polyfill for compass-welcome to customize welcome page content
        '@mongodb-js/compass-welcome': localPolyfill(
          '@mongodb-js/compass-welcome'
        ),

        // TODO(COMPASS-7407): compass-logging
        // hard to disable the whole thing while there are direct dependencies
        // on log-writer
        // 'mongodb-log-writer': localPolyfill('mongodb-log-writer'),
        v8: false,
        electron: false,
        'hadron-ipc': false,

        // TODO(COMPASS-7411): compass-user-data
        // can't disable the whole module, imports used directly in module scope
        // '@mongodb-js/compass-user-data': false,
        worker_threads: false,

        // Used by driver outside of the supported web connection path. Has to
        // be defined before `fs` so that webpack first reads the namespaced
        // alias before trying to resolve it relative to `fs` polyfill path
        'fs/promises': localPolyfill('fs/promises'),
        // TODO(COMPASS-7411): compass-utils
        fs: localPolyfill('fs'),

        // We can't polyfill connection-form because some shared methods from
        // connection-form are used in connection flow, so you can't connect
        // unless you import the whole connection-form. They should probably be
        // moved to connection-info package at least which is already a place
        // where shared connection types and methods that are completely not
        // platform specific and don't contain any UI are kept
        // '@mongodb-js/connection-form': localPolyfill(
        //   '@mongodb-js/connection-form'
        // ),

        // Things that are easier to polyfill than to deal with their usage
        'stream/promises': localPolyfill('stream/promises'),
        stream: require.resolve('readable-stream'),
        '@electron/remote': localPolyfill('@electron/remote'),
        path: require.resolve('path-browserify'),
        // The `/` so that we are resolving the installed polyfill version with
        // the same name as Node.js built-in, not a built-in Node.js one
        'util/types': localPolyfill('util/types'),
        util: require.resolve('util/'),
        buffer: require.resolve('buffer/'),
        events: require.resolve('events/'),
        // Used by export-to-language feature and there is no real way we can
        // remove the usage at the moment
        vm: require.resolve('vm-browserify'),

        // TODO(NODE-5408): requires a polyfill to be able to parse connection
        // string correctly at the moment
        url: require.resolve('whatwg-url'),
        // Make sure we're not getting multiple versions included
        'whatwg-url': require.resolve('whatwg-url'),
        // Heavy dependency of whatwg-url that we can replace in the browser
        // environment
        tr46: localPolyfill('tr46'),

        // Polyfills that are required for the driver to function in browser
        // environment
        net: localPolyfill('net'),
        'timers/promises': require.resolve('timers-browserify'),
        timers: require.resolve('timers-browserify'),
        os: require.resolve('os-browserify/browser'),
        crypto: require.resolve('crypto-browserify'),
        dns: localPolyfill('dns'),
        // Built-in Node.js modules imported by the driver directly and used in
        // ways that requires us to provide a no-op polyfill
        zlib: localPolyfill('zlib'),
        // Built-in Node.js modules imported by the driver directly, but used in
        // a way that allows us to just provide an empty module alias
        http: false,
        child_process: false,
        // Optional driver dependencies that should throw on import as a way for
        // driver to identify them as missing and so require a special
        // "polyfill" that throws in module scope on import. See
        // https://github.com/mongodb/node-mongodb-native/blob/main/src/deps.ts
        // for the full list of dependencies that fall under that rule
        kerberos: localPolyfill('throwError'),
        '@mongodb-js/zstd': localPolyfill('throwError'),
        '@aws-sdk/credential-providers': localPolyfill('throwError'),
        'gcp-metadata': localPolyfill('throwError'),
        snappy: localPolyfill('throwError'),
        socks: localPolyfill('throwError'),
        aws4: localPolyfill('throwError'),
        'mongodb-client-encryption': localPolyfill('throwError'),
      },
    },
    plugins: [
      // Add detailed build progress reporting
      new webpack.ProgressPlugin({
        activeModules: true, // Show currently processed modules
        entries: true, // Show entries being processed
        dependencies: true, // Show dependencies being processed
        modules: true, // Show modules being processed
        modulesCount: 5000, // Show progress for every N modules
        profile: false, // Enable profiling (can be verbose)
        handler: (percentage, message, ...args) => {
          // Custom progress handler for more detailed output
          const info = args.length > 0 ? ` (${args.join(' ')})` : '';
          console.log(
            `🔨 Build Progress: ${Math.round(
              percentage * 100
            )}% ${message}${info}`
          );
        },
      }),

      new webpack.DefinePlugin({
        // Can be either `web` or `webdriverio`, helpful if we need special
        // behavior for tests in sandbox
        'process.env.APP_ENV': JSON.stringify(process.env.APP_ENV ?? 'web'),
        'process.env.COMPASS_WEB_BASE_PATH': JSON.stringify(basePath),
        'process.env.COMPASS_WEB_READ_ONLY': JSON.stringify(
          readOnly.toString()
        ),
        'process.env.COMPASS_WEB_ENABLE_IMPORT_EXPORT': JSON.stringify(
          enableImportExport.toString()
        ),
        'process.env.COMPASS_WEB_ENABLE_SHELL': JSON.stringify(
          enableShell.toString()
        ),
        'process.env.COMPASS_WEB_DIRECT_CONNECTION': JSON.stringify(
          enableDirectConnection.toString()
        ),
        'process.env.COMPASS_WEB_DOCUMENTATION_LINK': JSON.stringify(
          process.env.COMPASS_WEB_DOCUMENTATION_LINK || ''
        ),
        'process.env.COMPASS_WEB_LOGOUT_PATH': JSON.stringify(
          process.env.COMPASS_WEB_LOGOUT_PATH || ''
        ),
        'process.env.COMPASS_WEBSOCKET_PROXY_PORT': JSON.stringify(
          wsProxyPort.toString()
        ),
        'process.env.COMPASS_WEBSOCKET_PROXY_PROTOCOL':
          JSON.stringify(wsProxyProtocol),
        'process.env.COMPASS_WEBSOCKET_PROXY_HOST': JSON.stringify(wsProxyHost),
        'process.env.COMPASS_WEBSOCKET_PROXY_URL': JSON.stringify(
          wsProxyUrlOverride || ''
        ),
      }),

      new webpack.ProvidePlugin({
        Buffer: ['buffer', 'Buffer'],
        // Required by the driver to function in browser environment
        process: [localPolyfill('process'), 'process'],
      }),
    ],
    performance: {
      hints: false, // Disable performance warnings/errors for bundle size
      maxEntrypointSize: MAX_COMPRESSION_FILE_SIZE,
      maxAssetSize: MAX_COMPRESSION_FILE_SIZE,
    },

    // Enhanced stats configuration for verbose build output
    stats: {
      preset: 'normal', // Base preset for detailed output
      colors: true, // Enable colored output
      hash: true, // Show compilation hash
      version: true, // Show webpack version
      timings: true, // Show timing information
      assets: true, // Show assets information
      chunks: true, // Show chunks information
      chunkModules: false, // Hide chunk modules (can be very verbose)
      modules: false, // Hide individual modules (can be very verbose)
      reasons: false, // Hide reasons for including modules
      source: false, // Hide source code of modules
      errorDetails: true, // Show error details
      warningsFilter: [], // Show all warnings
      moduleTrace: true, // Show module trace for errors
      builtAt: true, // Show build timestamp
      env: true, // Show environment info
      chunkGroupAuxiliary: true, // Show auxiliary chunk group info
      chunkGroupChildren: true, // Show children chunk groups
      chunkGroupMaxAssets: 5, // Limit assets shown per chunk group
    },

    // Infrastructure logging for detailed webpack internals
    infrastructureLogging: {
      level: 'info', // Show info level logs (error, warn, info)
      debug: false, // Disable debug logging (very verbose)
      colors: true, // Enable colored logging
    },
  });

  if (useSandboxConfig) {
    // Only create WebSocket proxy in actual serve mode, not sandbox build
    if (serve && !buildSandbox) {
      createWebSocketProxy(wsProxyPort);
    }

    config.output = {
      path: config.output.path,
      filename: buildSandbox
        ? '[name].[contenthash].js'
        : config.output.filename,
      assetModuleFilename: config.output.assetModuleFilename,
      publicPath: basePath ? `${basePath}/` : '/',
    };

    const sandboxConfig = {
      resolve: {
        alias: {
          // Local polyfill for tls that allow us to connect to any MongoDB
          // server, not only to the Atlas Cloud one
          tls: localPolyfill('tls'),
        },
      },
      plugins: [
        new webpack.DefinePlugin({
          // Matches the electron-proxy.js default value
          'process.env.COMPASS_WEB_HTTP_PROXY_CLOUD_CONFIG': JSON.stringify(
            process.env.COMPASS_WEB_HTTP_PROXY_CLOUD_CONFIG ?? 'dev'
          ),
          'process.env.E2E_TEST_CLOUD_WEB_ENABLE_PREFERENCE_SAVING':
            JSON.stringify(
              process.env.E2E_TEST_CLOUD_WEB_ENABLE_PREFERENCE_SAVING ?? 'false'
            ),
          'process.env.COMPASS_WEB_BASE_PATH': JSON.stringify(basePath),
          'process.env.COMPASS_WEB_READ_ONLY': JSON.stringify(
            readOnly.toString()
          ),
          'process.env.COMPASS_WEB_ENABLE_IMPORT_EXPORT': JSON.stringify(
            enableImportExport.toString()
          ),
          'process.env.COMPASS_WEB_ENABLE_SHELL': JSON.stringify(
            enableShell.toString()
          ),
          'process.env.COMPASS_WEB_DIRECT_CONNECTION': JSON.stringify(
            enableDirectConnection.toString()
          ),
          'process.env.COMPASS_WEB_DOCUMENTATION_LINK': JSON.stringify(
            process.env.COMPASS_WEB_DOCUMENTATION_LINK || ''
          ),
          'process.env.COMPASS_WEB_LOGOUT_PATH': JSON.stringify(
            process.env.COMPASS_WEB_LOGOUT_PATH || ''
          ),
          'process.env.COMPASS_WEBSOCKET_PROXY_PORT': JSON.stringify(
            wsProxyPort.toString()
          ),
          'process.env.COMPASS_WEBSOCKET_PROXY_PROTOCOL':
            JSON.stringify(wsProxyProtocol),
          'process.env.COMPASS_WEBSOCKET_PROXY_HOST':
            JSON.stringify(wsProxyHost),
          'process.env.COMPASS_WEBSOCKET_PROXY_URL': JSON.stringify(
            wsProxyUrlOverride || ''
          ),
        }),
        new HtmlWebpackPlugin({
          template: path.resolve(__dirname, 'sandbox', 'index.html'),
          filename: 'index.html',
          basePath: basePath || '',
          inject: 'body', // Let webpack automatically inject script tags with correct hashed filenames
          publicPath: basePath ? `${basePath}/` : '/',
        }),
      ],
    };

    // Add devServer configuration only for actual serve mode
    if (serve && !buildSandbox) {
      sandboxConfig.devServer = {
        hot: true,
        open: false,
        magicHtml: false,
        port: webpackDevServerPort,
        historyApiFallback: {
          index: basePath ? `${basePath}/index.html` : '/index.html',
          rewrites: basePath
            ? [
                {
                  from: new RegExp(
                    `^${basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
                  ),
                  to: `${basePath}/index.html`,
                },
              ]
            : [{ from: /./, to: '/index.html' }],
        },
        client: {
          overlay:
            process.env.DISABLE_DEVSERVER_OVERLAY === 'true'
              ? false
              : { warnings: false, errors: true, runtimeErrors: true },
        },
      };
    }

    return merge(config, sandboxConfig);
  }

  config.output = {
    path: config.output.path,
    filename: config.output.filename,
    library: {
      type: 'commonjs-static',
    },
  };

  const compassWebConfig = merge(config, {
    externals: {
      react: 'commonjs2 react',
      'react-dom': 'commonjs2 react-dom',

      // TODO(CLOUDP-228421): move Socket implementation from mms codebase when
      // active work on the communication protocol is wrapped up
      tls: 'commonjs2 tls',
    },
    plugins: [
      // Always package dist with NODE_ENV set to production, otherwise @emotion
      // dev mode behavior completely hangs code in the browser when applying
      // dev build to locally running mms
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify('production'),
      }),

      // Only applied when running webpack in --watch mode. In this mode we want
      // to constantly rebuild d.ts files when source changes, we also don't
      // want to fail and stop compilation if we failed to generate definitions
      // for whatever reason, we only print the error
      function (compiler) {
        compiler.hooks.watchRun.tapPromise('compile-ts', async function () {
          const logger = compiler.getInfrastructureLogger('compile-ts');
          try {
            await execFileAsync('npm', ['run', 'typescript']);
            logger.log('Compiled TypeScript definitions successfully');
          } catch (err) {
            logger.error('Failed to complie TypeScript definitions:');
            logger.error();
            logger.error(err.stdout);
          }
        });
      },
    ],
  });

  // Split production bundle into more chunks to make sure it's easier for us to
  // stay under the max chunk limit. Be careful when adding new packages here,
  // make sure you're only selecting big packages with the smallest amount of
  // shared dependencies possible
  const bundles = createSiblingBundleFromLeafDeps(compassWebConfig, [
    '@mongodb-js/compass-components',
    'ag-grid-community',
    'bson-transpilers',
    // bson is not that big, but is a shared dependency of compass-web,
    // compass-components and bson-transpilers, so splitting it out
    'bson',
  ]);

  return bundles;
};
