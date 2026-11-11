// Fake navigator.serial with two emulated ESP-SDR C3 receivers (TCAP-capable).
// Test-only stand-in for the firmware protocol; injected by e2e.cjs.
(() => {
  const CRC = Uint32Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const shared = { wireConnected: true, pendingSlave: null, log: [], captures: 0 };
  window.__emu = shared;
  function makeSource(n) {
    // white noise source plus a tone; B sees it 3 samples later, rotated by 0.5 rad, with 20 kHz LO offset
    const len = n + 8, re = new Float32Array(len), im = new Float32Array(len);
    for (let j = 0; j < len; j++) {
      const u = Math.random() || 1e-9, v = Math.random();
      const g = Math.sqrt(-2 * Math.log(u)) * 0.15;
      re[j] = g * Math.cos(2 * Math.PI * v) + 0.2 * Math.cos(-2 * Math.PI * 3e6 / 80e6 * j);
      im[j] = g * Math.sin(2 * Math.PI * v) + 0.2 * Math.sin(-2 * Math.PI * 3e6 / 80e6 * j);
    }
    return { re, im };
  }
  function payload(src, n, offset, phase, cfo, refPhase = 0) {
    if (refPhase) {
      src = { re: Float32Array.from(src.re), im: Float32Array.from(src.im) };
      for (let j = 0; j < src.re.length; j++) {
        const w = -2 * Math.PI * 3e6 / 80e6 * j, c = 0.2 * Math.cos(w), s0 = 0.2 * Math.sin(w);
        const k = j, cr = Math.cos(refPhase) - 1, ci = Math.sin(refPhase);
        // add tone*(e^{j refPhase} - 1) so the tone carries refPhase in total
        src.re[k] += c * cr - s0 * ci; src.im[k] += c * ci + s0 * cr;
      }
    }
    const b = new Uint8Array(2 * n);
    for (let j = 0; j < n; j++) {
      const p = phase - 2 * Math.PI * cfo * j / 80e6, c = Math.cos(p), s = Math.sin(p);
      const r = src.re[j + offset] * c - src.im[j + offset] * s, i = src.re[j + offset] * s + src.im[j + offset] * c;
      b[2 * j] = Math.max(-127, Math.min(127, Math.round(r * 128))) & 255;
      b[2 * j + 1] = Math.max(-127, Math.min(127, Math.round(-i * 128))) & 255;
    }
    return b;
  }
  class Device {
    constructor(name) { this.name = name; this.buf = ''; this.out = []; this.wake = null; }
    send(x) { this.out.push(typeof x === 'string' ? new TextEncoder().encode(x) : x); this.wake?.(); }
    handle(line) {
      shared.log.push(this.name + ': ' + line);
      let m;
      if ((m = /^SYNC (\d+)$/.exec(line))) return this.send(`SYNC ${m[1]}\n`);
      if (line === 'INFO') return this.send('C3SDR 6 burst 16380\n');
      if (line === 'CAPS') return this.send('CAPS VERSION GPIO UARTBAUD RXLIMITS SERIALLEASE TUNEEXT GAIN HWAGC IQ8 TCAP\n');
      if (line === 'TRANSPORT?') return this.send('TRANSPORT USB 0\n');
      if (line === 'RANGE?') return this.send('RANGE 1850 2650 1\n');
      if (line === 'LIMITS?') return this.send('LIMITS {"gain":[0,79,1],"bandwidth":null,"rates":[80000000,40000000,16000000],"bits":[8,10]}\n');
      if (line === 'VERSION?') return this.send('VERSION {"revision":"0123456789abcdef0123456789abcdef01234567","build_date":"2026-11-11","build_timestamp":"2026-11-11T12:00:00Z","profile":"esp32c3"}\n');
      if (line === 'GPIO?') return this.send('GPIO 0:Z 1:Z 2:Z 3:Z 4:Z 5:Z 6:Z 7:Z 8:Z 9:Z 10:Z\n');
      if (/^FREQ \d+$/.test(line) || /^GAIN (MANUAL \d+|HARDWARE)$/.test(line)) { this.gain = line.slice(5); return this.send('OK\n'); }
      if (line === 'GAIN?') return this.send(`GAIN ${this.gain || 'HARDWARE'} 0 79\n`.replace('GAIN MANUAL 40 0 79', 'GAIN MANUAL 40'));
      if (line === 'RELEASE') return this.send('OK\n');
      if ((m = /^TCAP16 (\d+) (\d+) (\d+) ([MS]) (\d+)$/.exec(line))) {
        const n = +m[1];
        this.send('ARMED\n');
        if (m[4] === 'S') {
          const timer = setTimeout(() => { shared.pendingSlave = null; this.send('ERR trigger_timeout\n'); }, +m[5]);
          shared.pendingSlave = { dev: this, n, timer };
          return;
        }
        // The master reads back its own line, so it always captures; the slave
        // only sees the edge when the wire is connected.
        const slave = shared.wireConnected ? shared.pendingSlave : null;
        if (slave) { clearTimeout(slave.timer); shared.pendingSlave = null; }
        shared.captures++;
        const src = makeSource(n);
        for (const [dev, off, ph, cfo, rp] of [[this, 3, 0, 0], ...(slave ? [[slave.dev, 0, 0.5, 20e3, 0.6 + 0.05 * (Math.random() - 0.5)]] : [])]) {
          const p = payload(src, n, off, ph, cfo, rp);
          dev.send(`TRIG 0 ${dev === this ? 0 : 1234}\n`);
          dev.send(`DATA ${n} ${crc32(p).toString(16)} 205\n`);
          dev.send(p);
        }
        return;
      }
      this.send('ERR command\n');
    }
  }
  function makePort(dev) {
    let reader;
    return {
      getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
      async open() {
        this.readable = new ReadableStream({
          pull: async (ctrl) => {
            while (!dev.out.length) await new Promise((r) => (dev.wake = r));
            ctrl.enqueue(dev.out.shift());
          },
        });
        this.writable = new WritableStream({
          write: (chunk) => {
            dev.buf += new TextDecoder().decode(chunk);
            let i;
            while ((i = dev.buf.indexOf('\n')) >= 0) {
              const line = dev.buf.slice(0, i).trim();
              dev.buf = dev.buf.slice(i + 1);
              if (line) dev.handle(line);
            }
          },
        });
      },
      async close() {},
      async setSignals() {},
    };
  }
  const ports = [makePort(new Device('A')), makePort(new Device('B'))];
  let next = 0;
  Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => ports[next++], getPorts: async () => [] } });
})();
