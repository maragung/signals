// Numeric utilities with strict guards against NaN/Infinity

export const EPS = 1e-12;

export function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export function safeDiv(a: number, b: number): number {
  if (!isFiniteNum(a) || !isFiniteNum(b) || Math.abs(b) < EPS) return NaN;
  return a / b;
}

export function safeNum(x: number, fallback = 0): number {
  return isFiniteNum(x) ? x : fallback;
}

export function clamp(x: number, min: number, max: number): number {
  if (!isFiniteNum(x)) return min;
  return Math.min(Math.max(x, min), max);
}

export function sum(arr: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] ?? 0;
  return s;
}

export function mean(arr: ArrayLike<number>): number {
  if (arr.length === 0) return NaN;
  return sum(arr) / arr.length;
}

export function stddev(arr: ArrayLike<number>, ddof = 0): number {
  const n = arr.length - ddof;
  if (n <= 0) return NaN;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = (arr[i] ?? 0) - m;
    s += d * d;
  }
  return Math.sqrt(s / n);
}

export function round(x: number, digits: number): number {
  if (!isFiniteNum(x)) return x;
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}

export function roundToTickSize(price: number, tickSize: number): number {
  if (!isFiniteNum(price) || !isFiniteNum(tickSize) || tickSize <= 0) return price;
  return Math.round(price / tickSize) * tickSize;
}

// Returns last N elements of an array (typed copy)
export function tail<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  if (arr.length <= n) return arr.slice();
  return arr.slice(arr.length - n);
}

// Filter out non-finite values from a number array
export function sanitize(arr: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (isFiniteNum(v)) out.push(v);
  }
  return out;
}

// Linear regression slope and intercept of (x, y) where x is index 0..n-1
export function linregSlope(y: ArrayLike<number>): { slope: number; intercept: number } {
  const n = y.length;
  if (n < 2) return { slope: NaN, intercept: NaN };
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const yi = y[i] ?? 0;
    sx += i;
    sy += yi;
    sxy += i * yi;
    sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < EPS) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

// Percent change helper
export function pctChange(from: number, to: number): number {
  if (!isFiniteNum(from) || !isFiniteNum(to) || Math.abs(from) < EPS) return 0;
  return ((to - from) / from) * 100;
}

// Format price for display
export function formatPrice(price: number, precision = 2): string {
  if (!isFiniteNum(price)) return '—';
  if (Math.abs(price) >= 1000) {
    return price.toLocaleString('en-US', { maximumFractionDigits: precision });
  }
  if (Math.abs(price) >= 1) {
    return price.toFixed(precision);
  }
  return price.toPrecision(6);
}

// Format percent
export function formatPercent(p: number, digits = 2): string {
  if (!isFiniteNum(p)) return '—';
  return `${p >= 0 ? '+' : ''}${p.toFixed(digits)}%`;
}
