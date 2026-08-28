// Next.js API route: proxy for Binance USDⓈ-M Futures public data.
//
// Forwards requests to https://fapi.binance.com/fapi/v1/<path> and
// https://fapi.binance.com/futures/data/<path>. No API key is required
// for the public market-data endpoints we expose (klines, mark price,
// funding rate, open interest, long/short ratio, taker buy/sell,
// top trader positions, force orders).
//
// Includes a simple in-memory token bucket for rate limiting and
// aggressive caching of rarely-changing data (mark price, OI).

import { NextResponse, type NextRequest } from 'next/server';

const FAPI_BASE = 'https://fapi.binance.com';
const FAPI_DATA_BASE = 'https://fapi.binance.com/futures/data';
const REVALIDATE_SECONDS = 5;

// -------- Rate limiter (in-memory token bucket) --------

const BUCKET_CAPACITY = 120; // 120 requests per window
const REFILL_INTERVAL_MS = 60_000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

function getBucket(key: string): Bucket {
  let b = buckets.get(key);
  const now = Date.now();
  if (!b) {
    b = { tokens: BUCKET_CAPACITY, lastRefill: now };
    buckets.set(key, b);
  } else {
    const elapsed = now - b.lastRefill;
    const refill = (elapsed / REFILL_INTERVAL_MS) * BUCKET_CAPACITY;
    if (refill > 0) {
      b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + refill);
      b.lastRefill = now;
    }
  }
  return b;
}

function takeToken(key: string): boolean {
  const b = getBucket(key);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function getClientKey(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'anon';
}

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const clientKey = getClientKey(req);
  if (!takeToken(clientKey)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const pathParts = req.nextUrl.pathname.split('/').filter(Boolean);
  // pathParts = ['api', 'futures', ...path]
  const subPath = pathParts.slice(2).join('/');
  if (!subPath) {
    return NextResponse.json({ error: 'missing path' }, { status: 400 });
  }

  const incomingUrl = new URL(req.url);
  const qs = incomingUrl.search;
  // Heuristic: futures/data/* endpoints are under FAPI_DATA_BASE
  const base = subPath.startsWith('futures/data/') || subPath === 'futures/data' ? FAPI_DATA_BASE : FAPI_BASE;
  const url = `${base}/${subPath.replace(/^futures\/data\//, '')}${qs}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const upstream = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'price-prediction-terminal/1.0' },
      signal: controller.signal,
      // Revalidate frequently-changing data quickly
      next: { revalidate: REVALIDATE_SECONDS },
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: 'upstream_error', status: upstream.status, body: text.slice(0, 500) },
        { status: upstream.status },
      );
    }
    const body = await upstream.text();
    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': `public, max-age=${REVALIDATE_SECONDS}, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=30`,
        'access-control-allow-origin': '*',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'fetch_failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}
