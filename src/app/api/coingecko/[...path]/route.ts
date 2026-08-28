// Next.js API route: proxy for CoinGecko requests.
//
// The browser-side CoinGeckoProvider calls /api/coingecko/<path>?<query>
// and this route forwards to https://api.coingecko.com/api/v3/<path>.
// We add cache headers and a simple in-memory token bucket for rate
// limiting (so a misbehaving client cannot bring down the proxy).

import { NextResponse, type NextRequest } from 'next/server';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const REVALIDATE_SECONDS = 30;

// -------- Rate limiter (in-memory token bucket) --------

const BUCKET_CAPACITY = 60; // 60 requests per window
const REFILL_INTERVAL_MS = 60_000; // 1 minute

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

// -------- Route handlers --------

export const dynamic = 'force-dynamic';

function clientKey(req: NextRequest): string {
  // Prefer x-forwarded-for; fall back to a global bucket if not available.
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0];
    if (first) return first.trim();
  }
  return 'global';
}

interface RouteContext {
  params: Promise<{ path?: string[] }>;
}

async function handle(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const key = clientKey(req);
  if (!takeToken(key)) {
    return new NextResponse(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '60',
        'cache-control': 'no-store',
      },
    });
  }

  const segments = (await context.params)?.path ?? [];
  // Reject path traversal attempts
  for (const seg of segments) {
    if (seg.includes('..') || seg.includes('\\')) {
      return new NextResponse(JSON.stringify({ error: 'bad_path' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
  }
  const path = segments.join('/');
  const qs = req.nextUrl.search ?? '';
  const target = `${COINGECKO_BASE}/${path}${qs}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'price-prediction-terminal/1.0',
      },
      next: { revalidate: REVALIDATE_SECONDS },
    });
    const body = await upstream.text();
    const headers = new Headers();
    headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json');
    headers.set('cache-control', `public, max-age=${REVALIDATE_SECONDS}, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=${REVALIDATE_SECONDS * 2}`);
    headers.set('access-control-allow-origin', '*');
    headers.set('x-proxy-target', 'coingecko');
    return new NextResponse(body, { status: upstream.status, headers });
  } catch (err) {
    return new NextResponse(
      JSON.stringify({ error: 'upstream_error', message: err instanceof Error ? err.message : String(err) }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }
}

export async function GET(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(req, context);
}

export async function POST(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(req, context);
}
