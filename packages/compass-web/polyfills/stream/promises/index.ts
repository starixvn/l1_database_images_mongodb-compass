/**
 * Stream promises polyfill for compass-web browser environment
 *
 * Provides Node.js stream.pipeline API with fallback for browser compatibility.
 * Handles both native readable-stream pipeline and manual stream piping.
 */
import { promisify } from 'util';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pipeline: pipelineCallback } = require('readable-stream');

// Add a startup log to verify this polyfill is loaded
console.log('[Compass Web] Stream promises polyfill loaded');

const originalPipeline = promisify(pipelineCallback);

export const pipeline = async (...args: any[]) => {
  try {
    // Handle array format: pipeline([stream1, stream2, stream3], options)
    if (args.length === 2 && Array.isArray(args[0])) {
      const [streams, options] = args;

      // Try native pipeline first, fallback to manual if it fails
      try {
        return await originalPipeline(...streams, options);
      } catch (pipelineError) {
        // Fallback to manual stream piping for compatibility
        return await manualPipeline(streams, options);
      }
    } else {
      // Normal call: pipeline(stream1, stream2, stream3, options)
      return await originalPipeline(...args);
    }
  } catch (error) {
    console.error(
      'Export pipeline failed:',
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
};

/**
 * Manual stream pipeline implementation as fallback
 * Uses basic Node.js stream.pipe() when readable-stream pipeline fails
 */
async function manualPipeline(streams: any[], options: any = {}) {
  if (streams.length < 2) {
    throw new Error('Pipeline requires at least 2 streams');
  }

  return new Promise((resolve, reject) => {
    const abortSignal = options?.signal;
    let finished = false;

    // Handle abort signal
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        if (!finished) {
          finished = true;
          reject(new Error('Pipeline aborted'));
        }
      });
    }

    // Simple linear pipeline without complex event handling
    let result = streams[0];
    for (let i = 1; i < streams.length; i++) {
      result = result.pipe(streams[i]);
    }

    // Only handle completion on the final stream
    const finalStream = result;

    // Error handling
    streams.forEach((stream, index) => {
      stream.once('error', (err: Error) => {
        if (!finished) {
          console.error(`Pipeline error on stream ${index}:`, err.message);
          finished = true;
          reject(err);
        }
      });
    });

    // Completion handling - only on final stream
    const onComplete = () => {
      if (!finished) {
        finished = true;
        resolve(undefined);
      }
    };

    // Listen for completion events on final stream
    finalStream.once('finish', onComplete);
    finalStream.once('end', onComplete);
    finalStream.once('close', onComplete);
  });
}

export default { pipeline };
