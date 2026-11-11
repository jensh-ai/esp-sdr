// Run with: node --test webapp/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const dsp = createRequire(import.meta.url)('../dsp.js');

const TAU = 2 * Math.PI;

// Deterministic pseudo-random numbers and Gaussian noise.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function gauss(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(TAU * rand());
}

// Band-limited complex noise centred at fc with bandwidth bw, length n.
function bandNoise(n, fs, fc, bw, rand) {
  const N = dsp.nextPow2(n),
    re = new Float64Array(N),
    im = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const f = ((k < N / 2 ? k : k - N) * fs) / N;
    if (Math.abs(f - fc) <= bw / 2) {
      re[k] = gauss(rand);
      im[k] = gauss(rand);
    }
  }
  dsp.fft(re, im, true);
  return { re: re.subarray(0, n), im: im.subarray(0, n), N, spec: null };
}

// Apply a (fractional) delay in samples using the FFT, on a periodic signal.
function delay(x, tau) {
  const N = x.re.length,
    re = Float64Array.from(x.re),
    im = Float64Array.from(x.im);
  dsp.fft(re, im);
  for (let k = 0; k < N; k++) {
    const f = (k < N / 2 ? k : k - N) / N,
      ph = -TAU * f * tau,
      c = Math.cos(ph),
      s = Math.sin(ph),
      r = re[k] * c - im[k] * s;
    im[k] = re[k] * s + im[k] * c;
    re[k] = r;
  }
  dsp.fft(re, im, true);
  for (let k = 0; k < N; k++) {
    re[k] /= N;
    im[k] /= N;
  }
  return { re, im };
}

function scenario({ fs = 80e6, n = 16380, tau = 7.3, cfo = 37e3, phiRef = 0.2, phiTgt = 1.1, snr = 0.05 } = {}) {
  const rand = rng(42),
    N = dsp.nextPow2(n);
  const refHz = -3e6,
    tgtHz = 4e6;
  // Periodic source signals of length N so that FFT delays are exact.
  const tone = { re: new Float64Array(N), im: new Float64Array(N) };
  for (let j = 0; j < N; j++) {
    // Choose a tone on an exact bin to keep it periodic.
    const f = Math.round((refHz * N) / fs) / N;
    tone.re[j] = 0.3 * Math.cos(TAU * f * j);
    tone.im[j] = 0.3 * Math.sin(TAU * f * j);
  }
  const tgt = bandNoise(N, fs, tgtHz, 2e6, rand);
  let p = 0;
  for (let j = 0; j < N; j++) p += tgt.re[j] ** 2 + tgt.im[j] ** 2;
  const g = 0.3 / Math.sqrt(p / N);
  const mix = (x, y, phx, phy) => {
    const out = { re: new Float64Array(N), im: new Float64Array(N) };
    for (let j = 0; j < N; j++) {
      out.re[j] = x.re[j] * Math.cos(phx) - x.im[j] * Math.sin(phx) + g * (y.re[j] * Math.cos(phy) - y.im[j] * Math.sin(phy));
      out.im[j] = x.re[j] * Math.sin(phx) + x.im[j] * Math.cos(phx) + g * (y.re[j] * Math.sin(phy) + y.im[j] * Math.cos(phy));
    }
    return out;
  };
  // Receiver B sees the reference and the target with extra phases -phiRef/-phiTgt.
  const srcA = mix(tone, tgt, 0, 0),
    srcB = delay(mix(tone, tgt, -phiRef, -phiTgt), tau);
  const lo = 2.345; // arbitrary LO phase of receiver B
  const toIq = (x, hz, phase) => {
    const iq = new Float32Array(2 * n);
    for (let j = 0; j < n; j++) {
      const ph = phase - (TAU * hz * j) / fs,
        c = Math.cos(ph),
        s = Math.sin(ph);
      iq[2 * j] = x.re[j] * c - x.im[j] * s + snr * gauss(rand) + 0.02; // DC offset
      iq[2 * j + 1] = x.re[j] * s + x.im[j] * c + snr * gauss(rand) - 0.01;
    }
    return iq;
  };
  return { fs, n, refHz, tgtHz, iqA: toIq(srcA, 0, 0), iqB: toIq(srcB, cfo, lo) };
}

test('FFT round trip', () => {
  const re = Float64Array.from({ length: 64 }, (_, j) => Math.sin(j) + j / 10),
    im = Float64Array.from({ length: 64 }, (_, j) => Math.cos(3 * j));
  const r0 = Float64Array.from(re),
    i0 = Float64Array.from(im);
  dsp.fft(re, im);
  dsp.fft(re, im, true);
  for (let j = 0; j < 64; j++) {
    assert.ok(Math.abs(re[j] / 64 - r0[j]) < 1e-9);
    assert.ok(Math.abs(im[j] / 64 - i0[j]) < 1e-9);
  }
});

test('recovers CFO, lag and geometric phase difference', () => {
  const s = scenario();
  const r = dsp.analyze(s.iqA, s.iqB, s.fs, {
    refHz: s.refHz,
    refWidthHz: 200e3,
    targetHz: s.tgtHz,
    targetWidthHz: 2e6,
  });
  assert.ok(Math.abs(r.cfo.hz - 37e3) < 300, `cfo ${r.cfo.hz}`);
  assert.ok(Math.abs(r.xc.lag - -7.3) < 3, `coarse lag ${r.xc.lag}`);
  assert.ok(Math.abs(r.cs.lag - -7.3) < 0.15, `refined lag ${r.cs.lag}`);
  assert.ok(r.cs.delayRuns >= 1);
  const expected = dsp.wrap(1.1 - 0.2);
  assert.ok(Math.abs(dsp.wrap(r.dphi - expected)) < 0.08, `dphi ${r.dphi} expected ${expected}`);
  assert.ok(r.target.coherence > 0.8, `target coherence ${r.target.coherence}`);
});

test('result does not depend on LO offset sign or larger delays', () => {
  for (const [cfo, tau] of [
    [-48e3, 3.6],
    [12e3, -25.4],
    [0, 0],
  ]) {
    const s = scenario({ cfo, tau, phiRef: -0.9, phiTgt: 2.0 });
    const r = dsp.analyze(s.iqA, s.iqB, s.fs, {
      refHz: s.refHz,
      refWidthHz: 200e3,
      targetHz: s.tgtHz,
      targetWidthHz: 2e6,
    });
    const expected = dsp.wrap(2.0 - -0.9);
    assert.ok(Math.abs(dsp.wrap(r.dphi - expected)) < 0.08, `cfo ${cfo} tau ${tau}: dphi ${r.dphi} vs ${expected}`);
    assert.ok(Math.abs(r.cs.lag + tau) < 0.15, `lag ${r.cs.lag} vs ${-tau}`);
  }
});

test('flags missing delay information when only CW tones are present', () => {
  const fs = 80e6,
    n = 8192,
    iqA = new Float32Array(2 * n),
    iqB = new Float32Array(2 * n),
    rand = rng(7);
  for (let j = 0; j < n; j++) {
    iqA[2 * j] = 0.02 * gauss(rand);
    iqA[2 * j + 1] = 0.02 * gauss(rand);
    iqB[2 * j] = 0.02 * gauss(rand);
    iqB[2 * j + 1] = 0.02 * gauss(rand);
    for (const [f, amp] of [
      [-3e6, 0.3],
      [5e6, 0.2],
    ]) {
      const p = (2 * Math.PI * f * j) / fs;
      iqA[2 * j] += amp * Math.cos(p);
      iqA[2 * j + 1] += amp * Math.sin(p);
      iqB[2 * j] += amp * Math.cos(p + 0.4);
      iqB[2 * j + 1] += amp * Math.sin(p + 0.4);
    }
  }
  const r = dsp.analyze(iqA, iqB, fs, { refHz: -3e6, refWidthHz: 200e3, targetHz: 5e6, targetWidthHz: 200e3 });
  assert.equal(r.cs.delayRuns, 0);
  assert.ok(Math.abs(r.dphi) < 0.05, `dphi ${r.dphi}`);
});

test('angle of arrival from phase difference', () => {
  const f = 2.44e9,
    d = 0.0625;
  assert.equal(dsp.angleFromPhase(0, f, d), 0);
  const expected = (Math.asin(dsp.C / (4 * f * d)) * 180) / Math.PI;
  assert.ok(Math.abs(dsp.angleFromPhase(Math.PI / 2, f, d) - expected) < 1e-9);
  assert.ok(Number.isNaN(dsp.angleFromPhase(Math.PI, f, 0.03)));
});

test('circular mean handles wrap-around', () => {
  const m = dsp.circularMean([Math.PI - 0.1, -Math.PI + 0.1]);
  assert.ok(Math.abs(Math.abs(m.mean) - Math.PI) < 1e-9);
  assert.ok(m.r > 0.99);
});
