import type { FusionDirectoryHandle } from "../types/player-browser";

const DATABASE_NAME = "fusion-player-local";
const DATABASE_VERSION = 1;
const SECRETS_STORE = "secrets";
const HANDLES_STORE = "handles";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SECRETS_STORE)) {
        database.createObjectStore(SECRETS_STORE);
      }
      if (!database.objectStoreNames.contains(HANDLES_STORE)) {
        database.createObjectStore(HANDLES_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local player storage."));
  });
}

async function readValue<T>(storeName: string, key: string): Promise<T | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error || new Error("Could not read local player storage."));
    });
  } finally {
    database.close();
  }
}

async function writeValue(storeName: string, key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not write local player storage."));
      transaction.onabort = () => reject(transaction.error || new Error("Local player storage write was aborted."));
    });
  } finally {
    database.close();
  }
}

async function deleteValue(storeName: string, key: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not clear local player storage."));
    });
  } finally {
    database.close();
  }
}

async function getEncryptionKey(): Promise<CryptoKey> {
  let key = await readValue<CryptoKey>(SECRETS_STORE, "device-key");
  if (!key) {
    key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await writeValue(SECRETS_STORE, "device-key", key);
  }
  return key;
}

export async function savePlayerToken(token: string): Promise<void> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  await writeValue(SECRETS_STORE, "device-token", { iv, ciphertext });
}

export async function loadPlayerToken(): Promise<string | null> {
  const stored = await readValue<{ iv: Uint8Array; ciphertext: ArrayBuffer }>(
    SECRETS_STORE,
    "device-token",
  );
  if (!stored) return null;

  const key = await getEncryptionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: stored.iv },
    key,
    stored.ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

export async function clearPlayerToken(): Promise<void> {
  await deleteValue(SECRETS_STORE, "device-token");
}

export async function saveLibraryDirectory(handle: FusionDirectoryHandle): Promise<void> {
  await writeValue(HANDLES_STORE, "library-directory", handle);
}

export async function loadLibraryDirectory(): Promise<FusionDirectoryHandle | null> {
  return readValue<FusionDirectoryHandle>(HANDLES_STORE, "library-directory");
}
