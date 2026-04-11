export const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pdf-compressor-db', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pages');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const savePage = (db: IDBDatabase, key: string, data: ArrayBuffer): Promise<void> => {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pages', 'readwrite');
    const store = tx.objectStore('pages');
    const request = store.put(data, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getPage = (db: IDBDatabase, key: string): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pages', 'readonly');
    const store = tx.objectStore('pages');
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const clearPages = (db: IDBDatabase): Promise<void> => {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pages', 'readwrite');
    const store = tx.objectStore('pages');
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};
