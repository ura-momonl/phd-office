// Smooth monotone cubic curves for sprite colours over the full 0–255 range.
// Shared by the editor and its real hero preview; source assets are never rewritten.
export const CHANNELS = ['r', 'g', 'b'];
const INPUTS = [0, 32, 64, 96, 128, 160, 192, 255];
export const IDENTITY_CURVES = Object.fromEntries(CHANNELS.map(c => [c, INPUTS.map(x => [x, x])]));
export const BROWN_CURVES = Object.fromEntries(CHANNELS.map((c, i) => [c, INPUTS.map(x => [x, Math.round(x + (x < 128 ? [48, 35, 28][i] * (1 - x / 128) ** 2 : 0))])]));

// Keep the existing saved selection and still-open old page usable: extend its
// previously locked highlights rather than discard the user's shadow edits.
export function fullRangeCurves(curves) {
  const full = Object.fromEntries(CHANNELS.map(c => {
    const p = curves?.[c];
    return [c, Array.isArray(p) && p.at(-1)?.[0] === 128 && p.at(-1)?.[1] === 128 ? [...p, [160,160], [192,192], [255,255]] : p];
  }));
  return validateCurves(full);
}

export function validateCurves(curves) {
  for (const c of CHANNELS) {
    const p = curves?.[c];
    if (!Array.isArray(p) || p.length < 2 || p.length > 32) throw new Error('每个通道需要 2–32 个控制点');
    p.forEach((v, i) => {
      if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite) || v.some(n => n < 0 || n > 255)) throw new Error('控制点须在 0–255 内');
      if (i && (v[0] <= p[i - 1][0] || v[1] < p[i - 1][1])) throw new Error('曲线须从左到右、单调上升');
    });
    if (p[0][0] !== 0 || p.at(-1)[0] !== 255) throw new Error('曲线须覆盖输入 0–255');
  }
  return curves;
}

export function curveTable(points) {
  const n = points.length, h = [], d = [], m = [];
  for (let i = 0; i < n - 1; i++) { h[i] = points[i + 1][0] - points[i][0]; d[i] = (points[i + 1][1] - points[i][1]) / h[i]; }
  m[0] = d[0];
  for (let i = 1; i < n - 1; i++) {
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    m[i] = d[i - 1] && d[i] ? (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]) : 0;
  }
  m[n - 1] = d[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (!d[i]) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], norm = Math.hypot(a, b);
    if (norm > 3) { m[i] *= 3 / norm; m[i + 1] *= 3 / norm; }
  }
  let j = 0;
  return Array.from({ length: 256 }, (_, x) => {
    while (j + 1 < n - 1 && x > points[j + 1][0]) j++;
    const t = (x - points[j][0]) / h[j], t2 = t * t, t3 = t2 * t;
    return Math.max(0, Math.min(255, (2 * t3 - 3 * t2 + 1) * points[j][1] + (t3 - 2 * t2 + t) * h[j] * m[j] + (-2 * t3 + 3 * t2) * points[j + 1][1] + (t3 - t2) * h[j] * m[j + 1]));
  });
}

export function curvePalette(palette, curves) {
  validateCurves(curves);
  const tables = CHANNELS.map(c => curveTable(curves[c]));
  // Curves are calibrated on greys; their RGB offsets are keyed to the pixel's
  // brightest channel, so the selected curves can adjust shadows and highlights
  // without a discontinuity or a separate highlight override.
  return palette.map(p => {
    const level = Math.max(...p.slice(0, 3));
    if (p[3] < 100) return p.slice();
    return p.map((v, i) => i < 3 ? Math.max(0, Math.min(255, Math.round(v + tables[i][level] - level))) : v);
  });
}
