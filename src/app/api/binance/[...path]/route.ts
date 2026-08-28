// Next.js API route: proxy for Binance requests.
//
// Binance's REST API generally allows browser CORS, but the proxy is kept
// available as a fallback (e.g. for corporate networks or rate-limit
// scenarios). CoinGecko is the one that strictly needs the proxy in
// browsers, so this one is simpler.

import { NextResponse, type NextRequest } from 'next/server';

const BINANCE_BASE = 'https://api.binance.com';
const REVALIDATE_SECONDS = 30;

const BUCKET_CAPACITY = 1200;
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

export const dynamic = 'force-dynamic';
export const revalidate = REVALIDATE_SECONDS;

function clientKey(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0];
    if (first) return first.trim();
  }
  return 'global';
}

interface RouteContext {
  params: { path?: string[] };
}

async function handle(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const key = clientKey(req);
  if (!takeToken(key)) {
    return new NextResponse(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    });
  }
  const segments = context.params?.path ?? [];
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
  const target = `${BINANCE_BASE}/${path}${qs}`;

  try {
    const upstream = await fetch(target, {
      headers: { Accept: 'application/json', 'User-Agent': 'price-prediction-terminal/1.0' },
      next: { revalidate: REVALIDATE_SECONDS },
    });
    const body = await upstream.text();
    const headers = new Headers();
    headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json');
    headers.set('cache-control', `public, max-age=${REVALIDATE_SECONDS}, s-maxage=${REVALIDATE_SECONDS}`);
    headers.set('access-control-allow-origin', '*');
    headers.set('x-proxy-target', 'binance');
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
