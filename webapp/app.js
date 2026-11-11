'use strict';
// Dual-SDR correlator UI. Uses BurstSerialRadio/decodeIQ/RATE_CODES from
// radio.js and DualDSP from dsp.js (classic scripts, shared global scope).
(() => {
  const $ = (id) => document.getElementById(id);
  const DEG = 180 / Math.PI;
  const names = ['A', 'B'];
  const devices = Object.fromEntries(names.map((n) => [n, { name: n, radio: new BurstSerialRadio(), info: null }]));

  let running = false,
    busy = false,
    calibration = 0,
    history = [],
    lastPair = null,
    lastResult = null;

  // ---------- helpers ----------
  const message = (text, error = false) => {
    $('message').textContent = text;
    $('message').classList.toggle('error', error);
  };
  const num = (id) => Number($(id).value);
  const connected = () => names.every((n) => devices[n].radio.port);
  const fmt = (v, digits = 1, unit = '') => (Number.isFinite(v) ? v.toFixed(digits) + unit : '–');

  function updateButtons() {
    const both = connected();
    $('capture').disabled = !both || busy || running;
    $('run').disabled = !both;
    $('run').textContent = running ? 'Stop' : 'Start';
    $('calibrate').disabled = !history.length;
    $('export').disabled = !lastPair;
    for (const n of names) {
      const on = !!devices[n].radio.port;
      $('connect-' + n).disabled = on || running;
      $('disconnect-' + n).disabled = !on || running;
      $('device-' + n).classList.toggle('connected', on);
    }
  }

  function captureSettings() {
    const c = {
      frequency: num('frequency'),
      rate: num('rate'),
      bits: num('bits'),
      samples: Math.round(num('samples')),
      gainMode: $('gain-mode').value,
      gain: Math.round(num('gain')),
    };
    if (!Number.isInteger(c.frequency)) throw Error('Use a whole-MHz center frequency.');
    if (!(c.samples >= 512)) throw Error('Use at least 512 samples.');
    return c;
  }
  function analysisSettings(rfMHz) {
    return {
      refHz: num('ref-offset') * 1e3,
      refWidthHz: num('ref-width') * 1e3,
      targetHz: num('target-offset') * 1e3,
      targetWidthHz: num('target-width') * 1e3,
      baselineM: num('baseline') / 100,
      maxCfoHz: num('max-cfo') * 1e3,
      nfft: num('nfft'),
      rfHz: rfMHz * 1e6,
      calibration,
    };
  }

  // ---------- devices ----------
  function describe(dev) {
    const r = dev.radio;
    const v = r.firmwareVersion;
    const rev = v?.revision ? ' · fw ' + String(v.revision).slice(0, 8) : '';
    return `${r.deviceName} · ${r.identity}${rev} · rates ${r.rxRates.map((x) => x / 1e6).join('/')} MS/s · gain ${r.gainMin}–${r.gainMax}`;
  }

  function applyCapabilities() {
    const radios = names.map((n) => devices[n].radio).filter((r) => r.port);
    if (!radios.length) return;
    // Offer only settings both receivers support.
    const rates = radios.reduce((acc, r) => acc.filter((x) => r.rxRates.includes(x)), [80000000, 40000000, 16000000]);
    for (const opt of $('rate').options) opt.disabled = !rates.includes(Number(opt.value));
    if (!rates.includes(num('rate')) && rates.length) $('rate').value = String(rates[0]);
    const bits = radios.reduce((acc, r) => acc.filter((b) => r.sampleBits.includes(b)), [8, 10]);
    for (const opt of $('bits').options) opt.disabled = !bits.includes(Number(opt.value));
    const maxSamples = Math.min(...radios.map((r) => r.maxSamples));
    $('samples').max = maxSamples;
    if (num('samples') > maxSamples) $('samples').value = maxSamples;
    $('gain').min = Math.max(...radios.map((r) => r.gainMin));
    $('gain').max = Math.min(...radios.map((r) => r.gainMax));
    const agc = radios.every((r) => r.hasHardwareAgc);
    $('gain-mode').options[1].disabled = !agc;
  }

  async function connect(n) {
    const dev = devices[n];
    try {
      message(`Connecting receiver ${n}…`);
      const other = devices[n === 'A' ? 'B' : 'A'].radio.port;
      const port = await SerialConnection.requestPort();
      if (other && port === other) throw Error('This port is already used by the other receiver.');
      await dev.radio.connect({ port });
      $('status-' + n).textContent = describe(dev);
      applyCapabilities();
      message(`Receiver ${n} connected.`);
    } catch (e) {
      if (e?.name === 'NotFoundError') message('No port selected.');
      else message(`Receiver ${n}: ${e.message || e}`, true);
    }
    updateButtons();
  }

  async function disconnect(n) {
    const dev = devices[n];
    try {
      await dev.radio.run(() => dev.radio.close());
    } catch (e) {
      message(e.message || String(e), true);
    }
    $('status-' + n).textContent = 'Not connected';
    updateButtons();
  }

  // ---------- capture ----------
  async function capturePair() {
    const c = captureSettings();
    const divider = RATE_CODES.indexOf(c.rate);
    const radios = names.map((n) => devices[n].radio);
    for (const r of radios) {
      if (!r.validFrequency(c.frequency)) throw Error(`${c.frequency} MHz is outside the tuning range.`);
      if (!r.rxRates.includes(c.rate)) throw Error('Sample rate not supported by both receivers.');
    }
    // Phase 1: tune and set gain (only sends commands when settings changed).
    const gains = await Promise.all(
      radios.map((r) =>
        r.run(async () => {
          await r.tune(c.frequency, 0);
          return r.setGain(c.gainMode, c.gain);
        }),
      ),
    );
    // Phase 2: issue both capture commands in the same task so they leave the
    // host as close together as possible. Without a hardware trigger the
    // snapshots still start with USB/firmware jitter (typically < 1 ms).
    const t0 = performance.now();
    const packets = await Promise.all(
      radios.map((r) =>
        r.run(async () => {
          r.captureSamples = Math.min(c.samples, r.maxSamples);
          const p = await r.capturePacket({ fft: 512, bits: c.bits }, divider);
          return { ...p, hostMs: performance.now() - t0 };
        }),
      ),
    );
    return {
      version: 1,
      time: new Date().toISOString(),
      settings: c,
      gains,
      devices: names.map((n, i) => ({
        name: n,
        identity: radios[i].identity,
        samples: packets[i].n,
        captureUs: packets[i].captureUs,
        hostMs: packets[i].hostMs,
        retries: packets[i].retries,
        bytes: packets[i].bytes,
      })),
    };
  }

  function analyzePair(pair) {
    const s = pair.settings;
    const iq = pair.devices.map((d) => decodeIQ(d.bytes, d.samples, s.bits));
    const opt = analysisSettings(s.frequency);
    const r = DualDSP.analyze(iq[0], iq[1], s.rate, opt);
    r.clipped = iq.map((x) => clipped(x, s.bits));
    return r;
  }
  function clipped(iq, bits) {
    const limit = bits === 8 ? 127 / 128 : 511 / 512;
    let k = 0;
    for (let j = 0; j < iq.length; j += 2) if (Math.abs(iq[j]) >= limit || Math.abs(iq[j + 1]) >= limit) k++;
    return k / (iq.length / 2);
  }

  async function captureOnce() {
    busy = true;
    updateButtons();
    try {
      const pair = await capturePair();
      process(pair);
      message(`Captured ${pair.devices[0].samples} + ${pair.devices[1].samples} samples.`);
    } catch (e) {
      message(e.message || String(e), true);
    } finally {
      busy = false;
      updateButtons();
    }
  }

  async function runLoop() {
    running = true;
    updateButtons();
    message('Running…');
    try {
      while (running) {
        const pair = await capturePair();
        process(pair);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      message('Stopped.');
    } catch (e) {
      message(e.message || String(e), true);
    } finally {
      running = false;
      updateButtons();
    }
  }

  function process(pair) {
    lastPair = pair;
    lastResult = analyzePair(pair);
    history.push({ dphi: lastResult.dphi + calibration, time: Date.now() });
    const keep = Math.max(1, Math.round(num('average'))) * 5;
    if (history.length > keep) history.splice(0, history.length - keep);
    render();
  }

  // ---------- rendering ----------
  function stats() {
    const n = Math.max(1, Math.round(num('average'))),
      recent = history.slice(-n).map((h) => DualDSP.wrap(h.dphi - calibration));
    return { ...DualDSP.circularMean(recent), count: recent.length };
  }

  function render() {
    if (!lastResult || !lastPair) return;
    const r = lastResult,
      s = lastPair.settings,
      opt = analysisSettings(s.frequency),
      st = stats(),
      angle = DualDSP.angleFromPhase(st.mean, opt.rfHz + opt.targetHz, opt.baselineM);
    $('m-angle').textContent = fmt(angle, 1, '°');
    $('m-dphi').textContent = fmt(st.mean * DEG, 1, '°');
    $('m-spread').textContent = st.count > 1 ? fmt(st.std * DEG, 1, '°') : '–';
    $('m-dphi-last').textContent = fmt(r.dphi * DEG, 1, '°');
    $('m-cfo').textContent = `${fmt(r.cfo.hz / 1e3, 2, ' kHz')} (${fmt(r.cfo.hz / s.frequency, 2, ' ppm')})`;
    $('m-lag').textContent = `${fmt(r.cs.lag, 2)} smp = ${fmt((r.cs.lag / s.rate) * 1e9, 1, ' ns')}`;
    $('m-corr').textContent = fmt(r.xc.coherence, 3);
    $('m-coh').textContent = `${fmt(r.ref.coherence, 2)} / ${fmt(r.target.coherence, 2)}`;
    $('m-cal').textContent = fmt(calibration * DEG, 1, '°');
    $('m-count').textContent = String(history.length);

    const warn = [];
    if (r.cs.delayRuns === 0)
      warn.push(
        'No wideband coherent signal: the sampling time offset cannot be measured, so the phase difference between bands at different frequencies is unreliable.',
      );
    if (r.xc.coherence < 0.05)
      warn.push('Very low correlation: the two snapshots probably do not overlap in time (no common trigger yet).');
    if (r.ref.coherence < 0.5) warn.push('Reference band is not coherent between the receivers.');
    if (r.target.coherence < 0.5) warn.push('Target band is not coherent between the receivers.');
    if (r.clipped.some((c) => c > 0.001)) warn.push('Clipping detected: lower the gain.');
    if (Math.abs(r.cfo.hz) > opt.maxCfoHz * 0.95) warn.push('LO offset at the search limit: increase “Max. LO offset”.');
    if (Number.isNaN(angle) && st.count)
      warn.push('Phase difference larger than the antenna spacing allows: check the spacing or calibrate.');
    $('warnings').textContent = warn.join(' ');

    drawSpectrum(r, opt);
    drawEnvelope(r, s);
    drawCorrelation(r);
    drawPhase(r, opt);
    drawHistory(opt);
  }

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Minimal line/scatter plot on a canvas.
  function plot(canvas, { series = [], bands = [], xLabel = '', yLabel = '', xRange, yRange, vLines = [] }) {
    const dpr = window.devicePixelRatio || 1,
      w = canvas.clientWidth,
      h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const m = { l: 52, r: 10, t: 8, b: 30 },
      pw = w - m.l - m.r,
      ph = h - m.t - m.b;
    let [x0, x1] = xRange || [Infinity, -Infinity],
      [y0, y1] = yRange || [Infinity, -Infinity];
    if (!xRange || !yRange)
      for (const s of series)
        for (let i = 0; i < s.x.length; i++) {
          if (!Number.isFinite(s.y[i])) continue;
          if (!xRange) {
            x0 = Math.min(x0, s.x[i]);
            x1 = Math.max(x1, s.x[i]);
          }
          if (!yRange) {
            y0 = Math.min(y0, s.y[i]);
            y1 = Math.max(y1, s.y[i]);
          }
        }
    if (!Number.isFinite(x0) || x0 === x1) [x0, x1] = [x0 - 1 || 0, x1 + 1 || 1];
    if (!Number.isFinite(y0) || y0 === y1) [y0, y1] = [(y0 || 0) - 1, (y1 || 0) + 1];
    const X = (x) => m.l + ((x - x0) / (x1 - x0)) * pw,
      Y = (y) => m.t + (1 - (y - y0) / (y1 - y0)) * ph;
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = css('--muted');
    g.strokeStyle = css('--grid');
    g.lineWidth = 1;
    const ticks = (a, b, n) => {
      const step = 10 ** Math.floor(Math.log10((b - a) / n)),
        k = [1, 2, 5, 10].find((f) => (b - a) / (step * f) <= n) * step;
      const out = [];
      for (let v = Math.ceil(a / k) * k; v <= b + 1e-9 * k; v += k) out.push(+v.toPrecision(12));
      return out;
    };
    for (const t of ticks(x0, x1, 8)) {
      g.beginPath();
      g.moveTo(X(t), m.t);
      g.lineTo(X(t), m.t + ph);
      g.stroke();
      g.textAlign = 'center';
      g.fillText(String(t), X(t), h - m.b + 14);
    }
    for (const t of ticks(y0, y1, 5)) {
      g.beginPath();
      g.moveTo(m.l, Y(t));
      g.lineTo(m.l + pw, Y(t));
      g.stroke();
      g.textAlign = 'right';
      g.fillText(String(t), m.l - 6, Y(t) + 4);
    }
    g.textAlign = 'center';
    g.fillText(xLabel, m.l + pw / 2, h - 3);
    g.save();
    g.translate(11, m.t + ph / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(yLabel, 0, 0);
    g.restore();
    g.save();
    g.beginPath();
    g.rect(m.l, m.t, pw, ph);
    g.clip();
    for (const b of bands) {
      g.fillStyle = b.color;
      const x = X(b.from),
        bw = Math.max(4, X(b.to) - x);
      g.fillRect(x + (X(b.to) - x - bw) / 2, m.t, bw, ph);
    }
    for (const v of vLines) {
      g.strokeStyle = v.color;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(X(v.x), m.t);
      g.lineTo(X(v.x), m.t + ph);
      g.stroke();
      g.setLineDash([]);
    }
    for (const s of series) {
      g.strokeStyle = g.fillStyle = s.color;
      g.lineWidth = s.width || 1.5;
      if (s.points) {
        for (let i = 0; i < s.x.length; i++) {
          if (!Number.isFinite(s.y[i])) continue;
          g.globalAlpha = s.alpha ? s.alpha[i] : 1;
          g.fillRect(X(s.x[i]) - 1.5, Y(s.y[i]) - 1.5, 3, 3);
        }
        g.globalAlpha = 1;
      } else {
        g.beginPath();
        let pen = false;
        for (let i = 0; i < s.x.length; i++) {
          if (!Number.isFinite(s.y[i])) {
            pen = false;
            continue;
          }
          if (pen) g.lineTo(X(s.x[i]), Y(s.y[i]));
          else g.moveTo(X(s.x[i]), Y(s.y[i]));
          pen = true;
        }
        g.stroke();
      }
    }
    g.restore();
  }

  const db = (p) => 10 * Math.log10(p + 1e-20);

  function drawSpectrum(r, opt) {
    const f = Array.from(r.cs.freq, (x) => x / 1e6),
      norm = r.cs.segments * r.cs.nfft || 1;
    plot($('plot-spectrum'), {
      series: [
        { x: f, y: Array.from(r.cs.paa, (p) => db(p / norm)), color: css('--series-a') },
        { x: f, y: Array.from(r.cs.pbb, (p) => db(p / norm)), color: css('--series-b') },
      ],
      bands: [
        { from: (opt.refHz - opt.refWidthHz / 2) / 1e6, to: (opt.refHz + opt.refWidthHz / 2) / 1e6, color: css('--band-ref') },
        {
          from: (opt.targetHz - opt.targetWidthHz / 2) / 1e6,
          to: (opt.targetHz + opt.targetWidthHz / 2) / 1e6,
          color: css('--band-target'),
        },
      ],
      xLabel: 'Offset from center (MHz)',
      yLabel: 'dB',
    });
  }

  function drawEnvelope(r, s) {
    const ea = DualDSP.envelope(r.a),
      eb = DualDSP.envelope(r.b),
      tA = Array.from(ea, (_, i) => ((i * r.a.re.length) / ea.length / s.rate) * 1e6),
      tB = Array.from(eb, (_, i) => ((i * r.b.re.length) / eb.length / s.rate) * 1e6);
    plot($('plot-envelope'), {
      series: [
        { x: tA, y: Array.from(ea, db), color: css('--series-a'), width: 1 },
        { x: tB, y: Array.from(eb, db), color: css('--series-b'), width: 1 },
      ],
      xLabel: 'Time in snapshot (µs)',
      yLabel: 'dB',
    });
  }

  function drawCorrelation(r) {
    const xc = r.xc,
      center = xc.lagInt + (xc.lags.length - 1) / 2,
      span = 200,
      from = Math.max(0, center - span),
      to = Math.min(xc.lags.length, center + span + 1);
    plot($('plot-correlation'), {
      series: [{ x: Array.from(xc.lags.subarray(from, to)), y: Array.from(xc.magnitude.subarray(from, to)), color: css('--accent') }],
      vLines: [{ x: r.cs.lag, color: css('--muted') }],
      xLabel: 'Lag of A relative to B (samples)',
      yLabel: '|r|',
    });
  }

  function drawPhase(r, opt) {
    const f = Array.from(r.cs.freq, (x) => x / 1e6),
      phase = Array.from(r.cs.re, (re, i) => Math.atan2(r.cs.im[i], re) * DEG),
      alpha = Array.from(r.cs.coherence, (g) => (g >= 0.5 ? 1 : 0.12));
    plot($('plot-phase'), {
      series: [{ x: f, y: phase, color: css('--accent'), points: true, alpha }],
      bands: [
        { from: (opt.refHz - opt.refWidthHz / 2) / 1e6, to: (opt.refHz + opt.refWidthHz / 2) / 1e6, color: css('--band-ref') },
        {
          from: (opt.targetHz - opt.targetWidthHz / 2) / 1e6,
          to: (opt.targetHz + opt.targetWidthHz / 2) / 1e6,
          color: css('--band-target'),
        },
      ],
      xLabel: 'Offset from center (MHz)',
      yLabel: 'phase A·B* (°)',
      yRange: [-180, 180],
    });
  }

  function drawHistory(opt) {
    const x = history.map((_, i) => i + 1),
      dphi = history.map((h) => DualDSP.wrap(h.dphi - calibration) * DEG),
      angle = history.map((h) =>
        DualDSP.angleFromPhase(DualDSP.wrap(h.dphi - calibration), opt.rfHz + opt.targetHz, opt.baselineM),
      );
    plot($('plot-history'), {
      series: [
        { x, y: dphi, color: css('--accent'), points: true },
        { x, y: angle, color: css('--series-b') },
      ],
      xLabel: 'Capture (blue: Δφ in °, orange: angle in °)',
      yLabel: '°',
      yRange: [-180, 180],
    });
  }

  // ---------- export / import ----------
  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  function exportPair() {
    if (!lastPair) return;
    const out = {
      ...lastPair,
      analysis: analysisSettings(lastPair.settings.frequency),
      devices: lastPair.devices.map(({ bytes, ...d }) => ({ ...d, format: `iq${lastPair.settings.bits}`, data: toBase64(bytes) })),
    };
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' }),
      a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `esp-sdr-pair-${lastPair.time.replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importPair(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.version !== 1 || data.devices?.length !== 2) throw Error('Not an exported snapshot pair.');
      const pair = { ...data, devices: data.devices.map((d) => ({ ...d, bytes: fromBase64(d.data) })) };
      const s = pair.settings;
      $('frequency').value = s.frequency;
      $('rate').value = String(s.rate);
      $('bits').value = String(s.bits);
      if (data.analysis) {
        const a = data.analysis;
        $('ref-offset').value = a.refHz / 1e3;
        $('ref-width').value = a.refWidthHz / 1e3;
        $('target-offset').value = a.targetHz / 1e3;
        $('target-width').value = a.targetWidthHz / 1e3;
        $('baseline').value = a.baselineM * 100;
      }
      process(pair);
      message(`Loaded ${file.name}.`);
    } catch (e) {
      message(e.message || String(e), true);
    }
    updateButtons();
  }

  // ---------- wiring ----------
  for (const n of names) {
    $('connect-' + n).addEventListener('click', () => connect(n));
    $('disconnect-' + n).addEventListener('click', () => disconnect(n));
  }
  $('capture').addEventListener('click', captureOnce);
  $('run').addEventListener('click', () => {
    if (running) running = false;
    else runLoop();
    updateButtons();
  });
  $('calibrate').addEventListener('click', () => {
    calibration = DualDSP.wrap(calibration + stats().mean);
    if (lastPair) lastResult = analyzePair(lastPair);
    render();
    updateButtons();
  });
  $('clear-calibration').addEventListener('click', () => {
    calibration = 0;
    if (lastPair) lastResult = analyzePair(lastPair);
    render();
  });
  $('reset-history').addEventListener('click', () => {
    history = [];
    render();
    updateButtons();
  });
  $('export').addEventListener('click', exportPair);
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importPair(e.target.files[0]);
    e.target.value = '';
  });
  // Re-analyze the last pair when analysis settings change.
  for (const id of ['ref-offset', 'ref-width', 'target-offset', 'target-width', 'baseline', 'max-cfo', 'nfft', 'average'])
    $(id).addEventListener('change', () => {
      if (!lastPair) return;
      lastResult = analyzePair(lastPair);
      history[history.length - 1] = { dphi: lastResult.dphi + calibration, time: Date.now() };
      render();
    });
  window.addEventListener('resize', render);
  for (const n of names)
    devices[n].radio.onCaptureError = () => message(`Receiver ${n}: damaged transfer, retrying…`, true);

  if (!('serial' in navigator) && !SerialConnection.supported?.())
    message('This browser has no Web Serial support. Use Chrome or Edge on the desktop.', true);
  updateButtons();

  // For tests and the console.
  window.dualSdr = { devices, analyzePair, process, get lastResult() { return lastResult; } };
})();
