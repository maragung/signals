import { openDB, type IDBPDatabase } from 'idb';
import type { Candle, Timeframe } from '@/types';

const DB_NAME = 'pp-cache-v1';
const DB_VERSION = 1;
const STORE = 'candles';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available'));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      },
    });
  }
  return dbPromise;
}

function key(symbol: string, tf: Timeframe): string {
  return `${symbol}::${tf}`;
}

interface CacheRecord {
  symbol: string;
  tf: Timeframe;
  candles: Candle[];
  updatedAt: number;
}

export async function loadCachedCandles(
  symbol: string,
  tf: Timeframe,
): Promise<Candle[] | null> {
  try {
    const db = await getDB();
    const rec = (await db.get(STORE, key(symbol, tf))) as CacheRecord | undefined;
    if (!rec) return null;
    return rec.candles;
  } catch {
    return null;
  }
}

export async function saveCachedCandles(
  symbol: string,
  tf: Timeframe,
  candles: Candle[],
): Promise<void> {
  try {
    const db = await getDB();
    const rec: CacheRecord = { symbol, tf, candles, updatedAt: Date.now() };
    await db.put(STORE, rec, key(symbol, tf));
  } catch {
    // ignore cache write failures
  }
}

export async function clearCache(): Promise<void> {
  try {
    const db = await getDB();
    await db.clear(STORE);
  } catch {
    // ignore
  }
}
