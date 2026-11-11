'use strict';
// Signal processing for two simultaneously captured ESP-SDR snapshots.
// Works as a classic browser script (global DualDSP) and as a CommonJS module
// for the Node tests. Complex signals are { re: Float64Array, im: Float64Array }.
(function (root) {
  const C = 299792458;
  const TAU = 2 * Math.PI;

  const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
  const wrap = (phi) => phi - TAU * Math.floor((phi + Math.PI) / TAU);

  // Iterative radix-2 FFT, in place. inverse=true computes the unscaled inverse.
  const twiddleCache = new Map();
  function twiddles(n) {
    let t = twiddleCache.get(n);
    if (!t) {
      t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
      for (let k = 0; k < n / 2; k++) {
        t.cos[k] = Math.cos((TAU * k) / n);
        t.sin[k] = Math.sin((TAU * k) / n);
      }
      twiddleCache.set(n, t);
    }
    return t;
  }
  function fft(re, im, inverse = false) {
    const n = re.length;
    if (n & (n - 1)) throw Error('FFT length must be a power of two');
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const { cos, sin } = twiddles(n);
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1,
        step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step],
            wi = sign * sin[k * step];
          const a = i + k,
            b = a + half;
          const xr = re[b] * wr - im[b] * wi,
            xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  function hann(n) {
    const w = new Float64Array(n);
    for (let j = 0; j < n; j++) w[j] = 0.5 - 0.5 * Math.cos((TAU * j) / n);
    return w;
  }

  // Interleaved Float32 I/Q (as decoded by radio.js) to a complex signal with
  // the mean removed. The ESP receivers have a noticeable DC offset.
  function fromInterleaved(iq) {
    const n = iq.length / 2,
      re = new Float64Array(n),
      im = new Float64Array(n);
    let mr = 0,
      mi = 0;
    for (let j = 0; j < n; j++) {
      re[j] = iq[2 * j];
      im[j] = iq[2 * j + 1];
      mr += re[j];
      mi += im[j];
    }
    mr /= n;
    mi /= n;
    for (let j = 0; j < n; j++) {
      re[j] -= mr;
      im[j] -= mi;
    }
    return { re, im };
  }

  // Parabolic peak interpolation; returns the fractional offset in [-0.5, 0.5].
  function parabolic(ym, y0, yp) {
    const d = ym - 2 * y0 + yp;
    return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (ym - yp)) / d)) : 0;
  }

  // Frequency offset between the two local oscillators. The product
  // a[t+k]*conj(b[t]) turns every signal both receivers see into a tone at the
  // LO difference, but only near the right time offset k: wideband signals
  // decorrelate within a sample or two. So search k in [-maxLag, maxLag]
  // (cross-ambiguity function), then refine the frequency at the best k.
  // Returns hz such that b * exp(+j*2*pi*hz*t) is frequency-aligned with a.
  function cfoSpectrum(a, b, k, N, w) {
    // Same length (that of the window) for every k, so scores are comparable.
    const n = Math.min(w.length, Math.min(a.re.length, b.re.length) - Math.abs(k)),
      offA = Math.max(0, k),
      offB = Math.max(0, -k),
      re = new Float64Array(N),
      im = new Float64Array(N);
    for (let j = 0; j < n; j++) {
      const ar = a.re[offA + j],
        ai = a.im[offA + j],
        br = b.re[offB + j],
        bi = b.im[offB + j];
      re[j] = w[j] * (ar * br + ai * bi);
      im[j] = w[j] * (ai * br - ar * bi);
    }
    fft(re, im);
    return { re, im };
  }
  // Coarse time offset that tolerates the LO offset: correlate short segments
  // (over which the LO difference turns the phase only a little) and add the
  // segment correlations non-coherently. Searches k in [-maxLag, maxLag] with
  // the same sign convention as crossCorrelate(): a[t+k] matches b[t].
  function coarseLag(a, b, maxLag = 2048, seg = 256) {
    const n = Math.min(a.re.length, b.re.length);
    maxLag = Math.max(0, Math.min(maxLag, n - seg));
    const N = nextPow2(seg + 2 * maxLag),
      score = new Float64Array(2 * maxLag + 1),
      ar = new Float64Array(N),
      ai = new Float64Array(N),
      br = new Float64Array(N),
      bi = new Float64Array(N);
    let segments = 0;
    for (let s = 0; s + seg <= n; s += seg) {
      ar.fill(0);
      ai.fill(0);
      br.fill(0);
      bi.fill(0);
      // a window [s - maxLag, s + seg + maxLag), zero outside the snapshot
      for (let j = 0; j < seg + 2 * maxLag; j++) {
        const t = s - maxLag + j;
        if (t >= 0 && t < n) {
          ar[j] = a.re[t];
          ai[j] = a.im[t];
        }
      }
      for (let j = 0; j < seg; j++) {
        br[j] = b.re[s + j];
        bi[j] = b.im[s + j];
      }
      fft(ar, ai);
      fft(br, bi);
      for (let k = 0; k < N; k++) {
        const r = ar[k] * br[k] + ai[k] * bi[k],
          i = ai[k] * br[k] - ar[k] * bi[k];
        ar[k] = r;
        ai[k] = i;
      }
      fft(ar, ai, true);
      // index j of the result is lag j - maxLag
      for (let k = 0; k <= 2 * maxLag; k++) score[k] += ar[k] * ar[k] + ai[k] * ai[k];
      segments++;
    }
    let best = 0,
      mean = 0;
    for (let k = 0; k < score.length; k++) {
      mean += score[k];
      if (score[k] > score[best]) best = k;
    }
    mean /= score.length || 1;
    return { lag: best - maxLag, quality: score[best] / (mean || 1e-300), segments };
  }

  function estimateCfo(a, b, fs, maxHz = 100e3, maxLag = 32, center = 0) {
    const n0 = Math.min(a.re.length, b.re.length);
    maxLag = Math.max(0, Math.min(maxLag, n0 >> 2));
    center = Math.max(-(n0 >> 2), Math.min(n0 >> 2, Math.round(center)));
    const n = n0 - maxLag - Math.abs(center),
      w = hann(n);
    const peakIn = ({ re, im }, N) => {
      const bins = Math.min(N / 2 - 2, Math.floor((maxHz * N) / fs)),
        power = (k) => {
          const i = (k + N) % N;
          return re[i] * re[i] + im[i] * im[i];
        };
      let best = 0,
        bestPower = -1,
        sum = 0;
      for (let k = -bins; k <= bins; k++) {
        const p = power(k);
        sum += p;
        if (p > bestPower) {
          bestPower = p;
          best = k;
        }
      }
      return { best, bestPower, mean: sum / (2 * bins + 1), power };
    };
    // Coarse search over the time offset at the plain FFT resolution.
    const N1 = nextPow2(n);
    let bestLag = 0,
      bestScore = -1;
    for (let k = center - maxLag; k <= center + maxLag; k++) {
      const pk = peakIn(cfoSpectrum(a, b, k, N1, w), N1),
        score = pk.bestPower / (pk.mean || 1e-300);
      if (score > bestScore) {
        bestScore = score;
        bestLag = k;
      }
    }
    // Fine frequency with zero padding at the best time offset.
    const N = N1 * 4,
      pk = peakIn(cfoSpectrum(a, b, bestLag, N, w), N);
    const lg = (x) => Math.log(x + 1e-300);
    const frac = parabolic(lg(pk.power(pk.best - 1)), lg(pk.bestPower), lg(pk.power(pk.best + 1)));
    return { hz: ((pk.best + frac) * fs) / N, quality: pk.bestPower / (pk.mean || 1e-300), lag: bestLag };
  }

  function rotate(x, hz, fs) {
    const n = x.re.length,
      re = new Float64Array(n),
      im = new Float64Array(n),
      w = (TAU * hz) / fs;
    for (let j = 0; j < n; j++) {
      const c = Math.cos(w * j),
        s = Math.sin(w * j);
      re[j] = x.re[j] * c - x.im[j] * s;
      im[j] = x.re[j] * s + x.im[j] * c;
    }
    return { re, im };
  }

  const energy = (x) => {
    let e = 0;
    for (let j = 0; j < x.re.length; j++) e += x.re[j] * x.re[j] + x.im[j] * x.im[j];
    return e;
  };

  // r[k] = sum_t a[t+k] * conj(b[t]). A peak at lag k means a[t+k] matches b[t],
  // i.e. the event appears k samples later in capture A than in capture B.
  function crossCorrelate(a, b, maxLag = Infinity) {
    const n = Math.min(a.re.length, b.re.length),
      N = nextPow2(2 * n),
      ar = new Float64Array(N),
      ai = new Float64Array(N),
      br = new Float64Array(N),
      bi = new Float64Array(N);
    ar.set(a.re.subarray(0, n));
    ai.set(a.im.subarray(0, n));
    br.set(b.re.subarray(0, n));
    bi.set(b.im.subarray(0, n));
    fft(ar, ai);
    fft(br, bi);
    for (let k = 0; k < N; k++) {
      const r = ar[k] * br[k] + ai[k] * bi[k],
        i = ai[k] * br[k] - ar[k] * bi[k];
      ar[k] = r;
      ai[k] = i;
    }
    fft(ar, ai, true);
    const norm = Math.sqrt(energy(a) * energy(b)) || 1;
    const limit = Math.min(n - 1, maxLag);
    const lags = new Int32Array(2 * limit + 1),
      magnitude = new Float64Array(2 * limit + 1);
    let best = 0;
    for (let k = -limit; k <= limit; k++) {
      const i = (k + N) % N,
        m = Math.hypot(ar[i], ai[i]) / N / norm;
      lags[k + limit] = k;
      magnitude[k + limit] = m;
      if (m > magnitude[best]) best = k + limit;
    }
    const at = (i) => magnitude[Math.max(0, Math.min(magnitude.length - 1, i))];
    const frac = parabolic(at(best - 1), at(best), at(best + 1));
    const peak = (best - limit + N) % N;
    let floor = 0;
    for (const m of magnitude) floor += m;
    floor /= magnitude.length || 1;
    // Coarse estimate: a strong tone flattens this curve and can bias the
    // peak by a few samples. crossSpectrum() refines the delay.
    return {
      lags,
      magnitude, // normalized |r|, 1 for identical signals
      lag: best - limit + frac,
      lagInt: best - limit,
      phase: Math.atan2(ai[peak], ar[peak]),
      coherence: magnitude[best],
      peakToFloor: magnitude[best] / (floor || 1e-300),
    };
  }

  // Welch cross spectrum of a and b after removing the lag found by
  // crossCorrelate (integer part by shifting, fractional part as a phase ramp).
  // Bins are ordered from -fs/2 to +fs/2.
  function crossSpectrum(a, b, lag, fs, nfft = 1024) {
    const k = Math.round(lag),
      frac = lag - k,
      offA = Math.max(0, k),
      offB = Math.max(0, -k),
      len = Math.min(a.re.length - offA, b.re.length - offB);
    nfft = Math.min(nfft, 2 ** Math.floor(Math.log2(Math.max(2, len))));
    const w = hann(nfft),
      hop = nfft / 2,
      sabRe = new Float64Array(nfft),
      sabIm = new Float64Array(nfft),
      saa = new Float64Array(nfft),
      sbb = new Float64Array(nfft),
      xr = new Float64Array(nfft),
      xi = new Float64Array(nfft),
      yr = new Float64Array(nfft),
      yi = new Float64Array(nfft);
    let segments = 0;
    for (let s = 0; s + nfft <= len; s += hop, segments++) {
      for (let j = 0; j < nfft; j++) {
        xr[j] = w[j] * a.re[offA + s + j];
        xi[j] = w[j] * a.im[offA + s + j];
        yr[j] = w[j] * b.re[offB + s + j];
        yi[j] = w[j] * b.im[offB + s + j];
      }
      fft(xr, xi);
      fft(yr, yi);
      for (let j = 0; j < nfft; j++) {
        sabRe[j] += xr[j] * yr[j] + xi[j] * yi[j];
        sabIm[j] += xi[j] * yr[j] - xr[j] * yi[j];
        saa[j] += xr[j] * xr[j] + xi[j] * xi[j];
        sbb[j] += yr[j] * yr[j] + yi[j] * yi[j];
      }
    }
    // Shift to -fs/2..fs/2 and undo the residual fractional delay.
    const out = {
      freq: new Float64Array(nfft),
      re: new Float64Array(nfft),
      im: new Float64Array(nfft),
      paa: new Float64Array(nfft),
      pbb: new Float64Array(nfft),
      segments,
      nfft,
    };
    for (let i = 0; i < nfft; i++) {
      const j = (i + nfft / 2) % nfft,
        f = ((i - nfft / 2) * fs) / nfft,
        ph = (TAU * f * frac) / fs,
        c = Math.cos(ph),
        s = Math.sin(ph);
      out.freq[i] = f;
      out.re[i] = sabRe[j] * c - sabIm[j] * s;
      out.im[i] = sabRe[j] * s + sabIm[j] * c;
      out.paa[i] = saa[j];
      out.pbb[i] = sbb[j];
    }
    // Refine the residual delay from the phase step between adjacent bins.
    // Only wideband components carry delay information: a CW tone looks the
    // same at every delay. So use runs of at least MIN_RUN contiguous coherent
    // bins, each run with its own (cancelling) constant phase.
    const MIN_RUN = 8,
      gamma = new Float64Array(nfft);
    for (let i = 0; i < nfft; i++)
      gamma[i] = (out.re[i] ** 2 + out.im[i] ** 2) / (out.paa[i] * out.pbb[i] || 1e-300);
    // Narrowband peaks (CW tones) carry no delay information and would
    // dominate the power-weighted slope, even inside a wideband signal. A
    // windowed tone falls off steeply beyond +-2 bins, a wideband signal does
    // not: mask bins more than 10 dB above both sides 3-6 bins away, and
    // their neighbours.
    const cross = Array.from(out.paa, (p, i) => Math.sqrt(p * out.pbb[i])),
      tonal = new Uint8Array(nfft);
    const side = (from, to) => {
      const v = cross.slice(Math.max(0, from), Math.max(0, Math.min(nfft, to))).sort((x, y) => x - y);
      return v.length ? v[v.length >> 1] : 0;
    };
    for (let i = 0; i < nfft; i++) {
      const around = Math.max(side(i - 6, i - 2), side(i + 3, i + 7));
      if (cross[i] > 10 * around)
        for (let k = Math.max(0, i - 2); k <= Math.min(nfft - 1, i + 2); k++) tonal[k] = 1;
    }
    const usable = (i) => gamma[i] >= 0.5 && !tonal[i];
    let sr = 0,
      si = 0,
      runs = 0;
    for (let i = 0; i < nfft; ) {
      if (!usable(i)) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < nfft && usable(j + 1)) j++;
      // Effective number of bins (participation ratio): a tone and its window
      // sidelobes concentrate the power in 2-3 bins, wideband signals do not.
      let sum = 0,
        sum2 = 0;
      for (let k = i; k <= j; k++) {
        const c = Math.sqrt(out.paa[k] * out.pbb[k]);
        sum += c;
        sum2 += c * c;
      }
      if (j - i + 1 >= MIN_RUN && (sum * sum) / (sum2 || 1e-300) >= MIN_RUN / 2) {
        let pr = 0,
          pi = 0;
        for (let k = i; k < j; k++) {
          pr += out.re[k + 1] * out.re[k] + out.im[k + 1] * out.im[k];
          pi += out.im[k + 1] * out.re[k] - out.re[k + 1] * out.im[k];
        }
        const m = Math.hypot(pr, pi) || 1;
        sr += (pr / m) * (j - i);
        si += (pi / m) * (j - i);
        runs++;
      }
      i = j + 1;
    }
    const residual = runs ? (-Math.atan2(si, sr) * nfft) / TAU : 0;
    for (let i = 0; i < nfft; i++) {
      const ph = (TAU * out.freq[i] * residual) / fs,
        c = Math.cos(ph),
        s = Math.sin(ph),
        r = out.re[i] * c - out.im[i] * s;
      out.im[i] = out.re[i] * s + out.im[i] * c;
      out.re[i] = r;
    }
    out.coherence = gamma;
    out.delayRuns = runs;
    out.lag = lag + residual;
    return out;
  }

  // Phase and coherence of the cross spectrum inside one frequency band.
  function bandPhase(cs, centerHz, widthHz) {
    let re = 0,
      im = 0,
      pa = 0,
      pb = 0,
      bins = 0;
    for (let i = 0; i < cs.freq.length; i++) {
      if (Math.abs(cs.freq[i] - centerHz) > widthHz / 2) continue;
      re += cs.re[i];
      im += cs.im[i];
      pa += cs.paa[i];
      pb += cs.pbb[i];
      bins++;
    }
    const coherence = pa && pb ? (re * re + im * im) / (pa * pb) : 0;
    return { phase: Math.atan2(im, re), coherence, powerA: pa, powerB: pb, bins };
  }

  // Angle of arrival from the phase difference between two antennas at
  // spacing d (m). Positive angles point towards antenna A. NaN if ambiguous.
  function angleFromPhase(dphi, freqHz, baselineM) {
    const s = (wrap(dphi) * C) / (TAU * freqHz * baselineM);
    return Math.abs(s) <= 1 ? (Math.asin(s) * 180) / Math.PI : NaN;
  }

  function circularMean(phases) {
    let re = 0,
      im = 0;
    for (const p of phases) {
      re += Math.cos(p);
      im += Math.sin(p);
    }
    const n = phases.length || 1,
      r = Math.hypot(re, im) / n;
    return { mean: Math.atan2(im, re), r, std: r > 0 ? Math.sqrt(-2 * Math.log(Math.min(1, r))) : Infinity };
  }

  // Complete analysis of one snapshot pair.
  function analyze(iqA, iqB, fs, opt = {}) {
    const a = fromInterleaved(iqA),
      b0 = fromInterleaved(iqB);
    // Time offsets of several microseconds occur between the two triggers, more
    // than the CFO search covers on its own: find the region first.
    const coarse = coarseLag(a, b0, opt.maxLagSearch ?? 2048);
    const cfo = estimateCfo(a, b0, fs, opt.maxCfoHz ?? 100e3, opt.cfoLagSearch ?? 32, coarse.lag);
    cfo.coarse = coarse;
    const b = rotate(b0, cfo.hz, fs);
    const xc = crossCorrelate(a, b, opt.maxLag ?? Infinity);
    // Re-align the data with each refined delay until it settles.
    let cs = crossSpectrum(a, b, xc.lag, fs, opt.nfft ?? 1024);
    for (let j = 0; j < 6; j++) {
      const next = crossSpectrum(a, b, cs.lag, fs, opt.nfft ?? 1024),
        done = Math.abs(next.lag - cs.lag) < 0.005;
      cs = next;
      if (done) break;
    }
    const ref = bandPhase(cs, opt.refHz ?? 0, opt.refWidthHz ?? fs);
    const target = bandPhase(cs, opt.targetHz ?? 0, opt.targetWidthHz ?? fs);
    const dphi = wrap(target.phase - ref.phase - (opt.calibration ?? 0));
    const angle = opt.baselineM ? angleFromPhase(dphi, opt.rfHz + (opt.targetHz ?? 0), opt.baselineM) : NaN;
    return { cfo, xc, cs, ref, target, dphi, angle, a, b };
  }

  // Envelope |x|^2 reduced to `points` maxima for display.
  function envelope(x, points = 800) {
    const n = x.re.length,
      out = new Float64Array(Math.min(points, n)),
      step = n / out.length;
    for (let i = 0; i < out.length; i++) {
      let m = 0;
      for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++)
        m = Math.max(m, x.re[j] * x.re[j] + x.im[j] * x.im[j]);
      out[i] = m;
    }
    return out;
  }

  const api = {
    C,
    nextPow2,
    wrap,
    fft,
    hann,
    fromInterleaved,
    coarseLag,
    estimateCfo,
    rotate,
    crossCorrelate,
    crossSpectrum,
    bandPhase,
    angleFromPhase,
    circularMean,
    analyze,
    envelope,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DualDSP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
