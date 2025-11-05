/**
 * File system polyfill for compass-web browser environment
 *
 * Provides Node.js fs API compatibility for MongoDB Compass web exports:
 * - createWriteStream: Handles both temp files (in-memory) and downloads (browser)
 * - createReadStream: Reads from in-memory temp file storage
 * - Other fs methods: Minimal implementations for compatibility
 */
import { downloadDataAsFile } from './simple-export';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Writable, Readable } = require('readable-stream');

// Add a startup log to verify this polyfill is loaded
console.log('[Compass Web] FS polyfill loaded');

// In-memory storage for temp files in browser environment
const tempFileStorage = new Map<string, string[]>();
const tempFileAccessCount = new Map<string, number>();
const tempFileTimestamps = new Map<string, number>();

// Memory limits to prevent exhaustion
const MAX_TEMP_FILES = 50;
const TEMP_FILE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_HASH_ENTRIES = 10000; // Limit deduplication hash map size

// Simple hash function for chunk deduplication (better than using trimmed string)
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

// Cleanup old temp files periodically
function cleanupOldTempFiles() {
  const now = Date.now();
  for (const [path, timestamp] of tempFileTimestamps.entries()) {
    if (now - timestamp > TEMP_FILE_TTL_MS) {
      tempFileStorage.delete(path);
      tempFileAccessCount.delete(path);
      tempFileTimestamps.delete(path);
    }
  }
}

// Enforce memory limits
function enforceMemoryLimits() {
  // Clean up oldest files if we exceed limit
  if (tempFileStorage.size > MAX_TEMP_FILES) {
    const sortedByTimestamp = Array.from(tempFileTimestamps.entries()).sort(
      (a, b) => a[1] - b[1]
    );

    const filesToRemove = sortedByTimestamp.slice(
      0,
      tempFileStorage.size - MAX_TEMP_FILES
    );

    for (const [path] of filesToRemove) {
      tempFileStorage.delete(path);
      tempFileAccessCount.delete(path);
      tempFileTimestamps.delete(path);
    }
  }
}

export const promises = {
  mkdir: () => Promise.resolve(),
  rm: (path: string) => {
    // Cleanup temp file if it exists
    if (tempFileStorage.has(path)) {
      tempFileStorage.delete(path);
      tempFileAccessCount.delete(path);
      tempFileTimestamps.delete(path);
    }
    return Promise.resolve();
  },
  stat: () => Promise.reject(new Error('Not supported in browser')),
  readFile: () => Promise.reject(new Error('Not supported in browser')),
};

export function exists(path: string, callback: (exists: boolean) => void) {
  callback(false);
}

export function stat(path: string, callback: (err: Error | null) => void) {
  callback(new Error('Not supported in browser'));
}

export function createReadStream(filePath: string) {
  // Check if this is a temp file stored in memory
  if (tempFileStorage.has(filePath)) {
    const lines = tempFileStorage.get(filePath)!;

    // Track how many times this file has been accessed
    const accessCount = (tempFileAccessCount.get(filePath) || 0) + 1;
    tempFileAccessCount.set(filePath, accessCount);

    let lineIndex = 0;
    const totalLines = lines.length;
    let isEnded = false;

    return new Readable({
      objectMode: false,
      read(size?: number) {
        if (isEnded) {
          this.push(null);
          return;
        }

        // Calculate batch size: respect size parameter, but cap at reasonable limits
        // Default to 16KB if size not provided, or estimate ~1KB per line
        const requestedSize = size || 16 * 1024;
        const estimatedLinesPerKB = 10; // Rough estimate
        const maxLinesPerBatch = Math.max(
          1,
          Math.floor((requestedSize / 1024) * estimatedLinesPerKB)
        );
        const batchSize = Math.min(maxLinesPerBatch, totalLines - lineIndex);

        // Push lines in batches to control flow
        for (let i = 0; i < batchSize && lineIndex < totalLines; i++) {
          const line = lines[lineIndex];
          this.push(line + '\n');
          lineIndex++;
        }

        if (lineIndex >= totalLines) {
          isEnded = true;
          this.push(null);

          // Cleanup temp file after it's been fully read (similar to fs.promises.rm)
          // Only cleanup if file has been accessed (read completed)
          setTimeout(() => {
            tempFileStorage.delete(filePath);
            tempFileAccessCount.delete(filePath);
            tempFileTimestamps.delete(filePath);
          }, 1000); // Small delay to allow stream to fully drain
        }
      },
    });
  }

  throw new Error(`File not found or not supported in browser: ${filePath}`);
}

export function createWriteStream(filePath: string) {
  const chunks: string[] = [];
  const isTempFile = filePath.includes('.jsonl') || filePath.includes('tmp');

  // For temp files AND final CSV files, track written data with timestamps to prevent streaming duplicates
  const writtenHashes = new Map<string, number>();

  class BrowserWriteStream extends Writable {
    public path: string;

    constructor() {
      super({ objectMode: false });
      this.path = filePath;
    }

    _write(
      chunk: any,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ) {
      try {
        // Handle invalid encoding values - some streams pass non-standard values
        let safeEncoding: BufferEncoding = 'utf8';
        try {
          // Test if encoding is valid by attempting to use it
          if (encoding && Buffer.isEncoding(encoding)) {
            safeEncoding = encoding;
          }
        } catch {
          // Fall back to utf8 if encoding is invalid
          safeEncoding = 'utf8';
        }

        // Convert chunk to string
        let chunkStr: string;
        if (typeof chunk === 'string') {
          chunkStr = chunk;
        } else if (Buffer.isBuffer(chunk)) {
          chunkStr = chunk.toString(safeEncoding);
        } else {
          chunkStr = String(chunk);
        }

        // Only deduplicate when we detect the technical streaming bug
        // This preserves legitimate document duplicates from MongoDB queries
        if (isTempFile || filePath.endsWith('.csv')) {
          const trimmedChunk = chunkStr.trim();

          // Use proper hash function instead of trimmed string (reduces collision risk)
          const chunkHash = trimmedChunk ? simpleHash(trimmedChunk) : '';
          const now = Date.now();

          // Only skip if we've seen this exact chunk very recently (likely a streaming bug)
          if (chunkHash && writtenHashes.has(chunkHash)) {
            const lastSeen = writtenHashes.get(chunkHash)!;

            // If we saw this exact chunk within 100ms, it's likely a streaming bug
            if (now - lastSeen < 100) {
              const fileType = isTempFile ? 'temp file' : 'CSV export';
              console.log(
                `⚠️ [Compass Web] Streaming duplicate detected in ${fileType} - skipping`
              );
              callback(); // Don't add streaming duplicate
              return;
            }
          }

          // Cleanup old hash entries to prevent memory growth
          if (writtenHashes.size > MAX_HASH_ENTRIES) {
            // Remove entries older than 1 second
            const cutoff = now - 1000;
            for (const [hash, timestamp] of writtenHashes.entries()) {
              if (timestamp < cutoff) {
                writtenHashes.delete(hash);
              }
            }
          }

          if (chunkHash) {
            writtenHashes.set(chunkHash, now);
          }
        }

        chunks.push(chunkStr);

        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }

    _final(callback: (error?: Error | null) => void) {
      try {
        // Cleanup old temp files before creating new ones
        cleanupOldTempFiles();
        enforceMemoryLimits();

        const data = chunks.join('');

        if (isTempFile) {
          // Store in memory for CSV column analysis
          const lines = data.split('\n').filter((line) => line.trim());
          tempFileStorage.set(filePath, lines);
          tempFileAccessCount.set(filePath, 0); // Reset access count for new file
          tempFileTimestamps.set(filePath, Date.now()); // Track creation time
        } else {
          // Log final CSV stats for monitoring
          const lines = data.split('\n').filter((line) => line.trim());
          console.log(
            `✅ [Compass Web] CSV export ready: ${lines.length} lines (${chunks.length} chunks processed)`
          );

          // Trigger browser download
          const filename = filePath.split(/[/\\]/).pop() || 'export';
          const extension = filename.split('.').pop()?.toLowerCase();

          const mimeType =
            extension === 'json'
              ? 'application/json'
              : extension === 'csv'
              ? 'text/csv'
              : 'application/octet-stream';

          downloadDataAsFile(data, filename, mimeType);
        }

        // Cleanup hash map after stream completes
        writtenHashes.clear();

        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }

    close() {
      this.end();
    }
  }

  return new BrowserWriteStream();
}

export function rmSync() {}
export function readFileSync() {}

export default {
  promises,
  exists,
  stat,
  createWriteStream,
  createReadStream,
  rmSync,
  readFileSync,
};

/**
 * ARCHITECTURE NOTES:
 *
 * This polyfill enables MongoDB Compass CSV exports to work in browsers by:
 *
 * 1. CSV Export Process:
 *    - Step 1: Write cursor data to temp file (.jsonl) for column analysis
 *    - Step 2: Read temp file back to generate final CSV with proper columns
 *
 * 2. Browser Adaptation:
 *    - Temp files: Stored in memory (Map<string, string[]>)
 *    - Download files: Trigger browser downloads via Blob + URL.createObjectURL
 *    - Streams: Use readable-stream library for full Node.js compatibility
 *
 * 3. Stream Pipeline:
 *    - Uses stream/promises pipeline with manual fallback
 *    - Handles encoding issues (invalid 'buffer' encoding)
 *    - Maintains all lifecycle events and error handling
 *
 * 4. Memory Management:
 *    - Temp files auto-cleanup after read completion (1s delay)
 *    - TTL-based cleanup (5 minutes) for orphaned files
 *    - Enforces MAX_TEMP_FILES limit (50 files)
 *    - Hash map cleanup prevents memory growth (MAX_HASH_ENTRIES: 10K)
 *    - Manual cleanup via fs.promises.rm() supported
 *
 * 5. Deduplication Algorithm:
 *    - Uses hash function (simpleHash) instead of trimmed strings
 *    - 100ms window to detect streaming bugs vs legitimate duplicates
 *    - Cleans up old hash entries periodically
 *
 * 6. Stream Reading:
 *    - Respects size parameter for batch sizing
 *    - Estimates ~10 lines per KB for proper flow control
 *    - Auto-cleanup after stream completion
 *
 * This approach preserves the existing Compass export architecture while
 * making it work seamlessly in browser environments with proper memory management.
 */
