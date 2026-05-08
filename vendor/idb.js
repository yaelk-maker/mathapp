// Minimal Promise wrapper around IndexedDB. Vendored to avoid CDN dependency
// (PWA must work offline from first load).

export function openDB(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (event) => {
      try {
        upgrade(req.result, event.oldVersion, event.newVersion, req.transaction);
      } catch (err) {
        reject(err);
      }
    };
    req.onsuccess = () => resolve(wrapDB(req.result));
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function wrapDB(db) {
  return {
    raw: db,
    get(store, key) {
      return runRequest(db, store, 'readonly', (s) => s.get(key));
    },
    getAll(store, query) {
      return runRequest(db, store, 'readonly', (s) => s.getAll(query));
    },
    getAllFromIndex(store, indexName, query) {
      return runRequest(db, store, 'readonly', (s) => s.index(indexName).getAll(query));
    },
    put(store, value) {
      return runRequest(db, store, 'readwrite', (s) => s.put(value));
    },
    delete(store, key) {
      return runRequest(db, store, 'readwrite', (s) => s.delete(key));
    },
    clear(store) {
      return runRequest(db, store, 'readwrite', (s) => s.clear());
    },
    transaction(stores, mode = 'readonly') {
      return db.transaction(stores, mode);
    },
    close() {
      db.close();
    }
  };
}

function runRequest(db, store, mode, op) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const objectStore = tx.objectStore(store);
    const request = op(objectStore);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Run a callback inside a multi-store transaction. The callback receives the
// transaction object; resolves with whatever the callback returns once the
// transaction completes.
export function runInTransaction(db, stores, mode, callback) {
  return new Promise((resolve, reject) => {
    const tx = db.raw.transaction(stores, mode);
    let result;
    Promise.resolve()
      .then(() => callback(tx))
      .then((r) => {
        result = r;
      })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
