/**
 * Browser-native file download functionality for compass-web
 *
 * Provides web-compatible file downloads using the File API instead of Node.js fs.
 * Uses Blob + URL.createObjectURL for browser-native downloads.
 */

export function downloadDataAsFile(
  data: string,
  filename: string,
  mimeType: string = 'application/json'
) {
  // Ensure we're in a browser environment
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error(
      'downloadDataAsFile is only supported in browser environments'
    );
  }

  // Get browser's native URL object (bypassing webpack polyfills)
  const BrowserURL = (window as any).URL || (window as any).webkitURL;
  if (!BrowserURL || typeof BrowserURL.createObjectURL !== 'function') {
    throw new Error('URL.createObjectURL is not supported in this environment');
  }

  // Create blob and download link
  const blob = new Blob([data], { type: mimeType });
  const url = BrowserURL.createObjectURL(blob);

  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();

  // Cleanup resources
  setTimeout(() => {
    link.remove();
    BrowserURL.revokeObjectURL(url);
  }, 0);
}

/**
 * Simple WriteStream implementation for direct browser downloads
 * Alternative to the full fs.createWriteStream polyfill for simple use cases
 */
export function createSimpleWriteStream(filePath: string) {
  const chunks: string[] = [];

  return {
    write(chunk: string) {
      chunks.push(chunk);
    },
    end() {
      const filename = filePath.split('/').pop() || 'export';
      const extension = filename.split('.').pop()?.toLowerCase();

      const mimeType =
        extension === 'json'
          ? 'application/json'
          : extension === 'csv'
          ? 'text/csv'
          : 'application/octet-stream';

      const data = chunks.join('');
      downloadDataAsFile(data, filename, mimeType);
    },
    close() {
      this.end();
    },
    path: filePath,
  };
}
