import type {
  ConnectionInfo,
  ConnectionStorage,
} from '@mongodb-js/connection-storage/provider';

const historyKey = process.env.COMPASS_WEB_CONNECTION_HISTORY_KEY || 'CONNECTIONS_HISTORY_V$';
const encryptionKey = process.env.COMPASS_WEB_ENCRYPTION_KEY || '';

// Derive a CryptoKey from the encryption key string
async function getCryptoKey(): Promise<CryptoKey | null> {
  if (!encryptionKey) {
    return null;
  }

  // Hash the key string to get a fixed-length key
  const keyData = new TextEncoder().encode(encryptionKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', keyData);

  return crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypt data using AES-GCM
async function encrypt(data: string): Promise<string> {
  const key = await getCryptoKey();
  if (!key) {
    // No encryption key, return data as-is
    return data;
  }

  const iv = crypto.getRandomValues(new Uint8Array(12)); // 12 bytes IV for AES-GCM
  const encodedData = new TextEncoder().encode(data);

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encodedData
  );

  // Combine IV and encrypted data
  const combined = new Uint8Array(iv.length + encryptedBuffer.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encryptedBuffer), iv.length);

  return String.fromCodePoint(...combined);
}

// Decrypt data using AES-GCM
async function decrypt(encryptedData: string): Promise<string> {
  const key = await getCryptoKey();
  if (!key) {
    // No encryption key, return data as-is
    return encryptedData;
  }

  const combined = Uint8Array.from(encryptedData, (v) => v.codePointAt(0) ?? 0);

  // Extract IV and encrypted data
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted
  );

  return new TextDecoder().decode(decryptedBuffer);
}

async function getHistory(): Promise<ConnectionInfo[]> {
  try {
    const b64Str = localStorage.getItem(historyKey);
    if (!b64Str) {
      return [];
    }
    const binStr = window.atob(b64Str);
    const decryptedStr = await decrypt(binStr);
    return JSON.parse(decryptedStr);
  } catch {
    return [];
  }
}

async function saveHistory(history: ConnectionInfo[]) {
  try {
    const jsonStr = JSON.stringify(history);
    const encryptedStr = await encrypt(jsonStr);
    const binStr = encryptedStr;
    const b64Str = window.btoa(binStr);
    localStorage.setItem(historyKey, b64Str);
  } catch {
    // noop
  }
}

class SandboxConnectionStorage implements ConnectionStorage {
  private _connections = new Map<string, ConnectionInfo>();
  private _initialized = false;
  private _initPromise: Promise<void>;

  constructor() {
    this._initPromise = this._initialize();
  }

  private async _initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }
    const history = await getHistory();
    history.forEach((info) => {
      this._connections.set(info.id, info);
    });
    this._initialized = true;
  }

  async loadAll(): Promise<ConnectionInfo[]> {
    await this._initPromise;
    return Array.from(this._connections.values());
  }

  async load({ id }: { id: string }): Promise<ConnectionInfo | undefined> {
    await this._initPromise;
    return this._connections.get(id);
  }

  async save({ connectionInfo }: { connectionInfo: ConnectionInfo }): Promise<void> {
    await this._initPromise;
    this._connections.set(connectionInfo.id, connectionInfo);
    setTimeout(() => {
      void saveHistory(Array.from(this._connections.values()));
    }, 0);
  }

  async delete({ id }: { id: string }): Promise<void> {
    await this._initPromise;
    this._connections.delete(id);
    setTimeout(() => {
      void saveHistory(Array.from(this._connections.values()));
    }, 0);
  }
}

export const sandboxConnectionStorage = new SandboxConnectionStorage();
