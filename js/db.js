const DB_NAME = 'skai-food';
const DB_VER = 2;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('products')) {
        db.createObjectStore('products', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      // v2: свои блюда
      if (!db.objectStoreNames.contains('dishes')) {
        db.createObjectStore('dishes', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode) {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function put(name, value) {
  return reqToPromise((await store(name, 'readwrite')).put(value));
}

export async function del(name, key) {
  return reqToPromise((await store(name, 'readwrite')).delete(key));
}

export async function get(name, key) {
  return reqToPromise((await store(name, 'readonly')).get(key));
}

export async function getAll(name) {
  return reqToPromise((await store(name, 'readonly')).getAll());
}

export async function count(name) {
  return reqToPromise((await store(name, 'readonly')).count());
}

export async function clearStore(name) {
  return reqToPromise((await store(name, 'readwrite')).clear());
}

export async function entriesByDate(date) {
  const s = await store('entries', 'readonly');
  return reqToPromise(s.index('date').getAll(date));
}
