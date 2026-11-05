/**
 * Small, exact statistics for `dsa bench`: interval bounds on a rate seen as k of n.
 */

/** Wilson score interval for k of n (two-sided, 95% by default). [0, 1] when n is 0. */
export function wilson(k: number, n: number, z = 1.959964): [number, number] {
  if (!n) return [0, 1];
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/**
 * The one-sided lower bound on a rate seen as k of n (Clopper-Pearson, exact): the true rate is at
 * least this with confidence 1 - alpha. With no errors it is alpha^(1/n), so about 300 of 300 right
 * proves 99% at 95% (the "rule of three"). 0 when n is 0.
 */
export function lowerBound(k: number, n: number, alpha = 0.05): number {
  if (!n || !k) return 0;
  if (k === n) return Math.pow(alpha, 1 / n);
  // The p where P(X >= k | n, p) = alpha, i.e. the regularized incomplete beta I_p(k, n-k+1) = alpha.
  let lo = 0, hi = k / n;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (betaInc(mid, k, n - k + 1) > alpha) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/** The regularized incomplete beta function I_x(a, b) (Numerical Recipes' continued fraction). */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betacf(x, a, b)) / a : 1 - (front * betacf(1 - x, b, a)) / b;
}

function betacf(x: number, a: number, b: number): number {
  const TINY = 1e-300;
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}

/** log Γ(x), Lanczos. */
export function lgamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let s = 1.000000000190015;
  for (const c of g) s += c / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}

/** Rounded to 4 places, for reports. */
export const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
