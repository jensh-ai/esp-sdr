// Fake navigator.serial and navigator.usb with two emulated ESP-SDR C3 receivers
// (TCAP-capable).
// Test-only stand-in for the firmware protocol; injected by e2e.cjs.
(() => {
  const CRC = Uint32Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const shared = { wireConnected: true, pendingSlave: null, log: [], captures: 0, requests: 0 };
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
    constructor(name) { this.name = name; this.buf = ''; this.out = []; this.waiters = []; }
    send(x) { this.out.push(typeof x === 'string' ? new TextEncoder().encode(x) : x); this.wakeAll(); }
    wakeAll() { for (const r of this.waiters.splice(0)) r(); }
    async next() { while (!this.out.length) await new Promise((r) => this.waiters.push(r)); }
    receive(chunk) {
      this.buf += new TextDecoder().decode(chunk);
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this.handle(line);
      }
    }
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
    return {
      getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
      async open() {
        this.readable = new ReadableStream({
          pull: async (ctrl) => {
            await dev.next();
            ctrl.enqueue(dev.out.shift());
          },
        });
        this.writable = new WritableStream({ write: (chunk) => dev.receive(chunk) });
      },
      async close() {},
      async setSignals() {},
    };
  }
  // USBDevice with the C3 USB-Serial-JTAG layout: CDC control (0) + data (1),
  // plus the vendor-specific JTAG interface (2).
  function makeUsbDevice(dev) {
    const ep = (n, direction) => ({ endpointNumber: n, direction, type: 'bulk', packetSize: 64 });
    const alt = (cls, sub, endpoints = []) => ({ alternateSetting: 0, interfaceClass: cls, interfaceSubclass: sub, endpoints });
    const iface = (n, a) => ({ interfaceNumber: n, alternate: a, alternates: [a] });
    const cfg = { configurationValue: 1, interfaces: [iface(0, alt(2, 2)), iface(1, alt(10, 0, [ep(2, 'in'), ep(2, 'out')])), iface(2, alt(255, 255))] };
    let closed = true;
    return {
      vendorId: 0x303a, productId: 0x1001, serialNumber: 'EMU:' + dev.name,
      configuration: null, configurations: [cfg],
      async open() { closed = false; },
      async selectConfiguration() { this.configuration = cfg; },
      async claimInterface() {},
      async selectAlternateInterface() {},
      async controlTransferOut() { return { status: 'ok' }; },
      async transferIn(_, size) {
        while (!closed && !dev.out.length) await new Promise((r) => dev.waiters.push(r));
        if (closed) throw new DOMException('The device was closed.', 'AbortError');
        const head = dev.out[0], part = head.subarray(0, size);
        if (part.length === head.length) dev.out.shift(); else dev.out[0] = head.subarray(size);
        return { status: 'ok', data: new DataView(part.buffer, part.byteOffset, part.byteLength) };
      },
      async transferOut(_, bytes) { dev.receive(bytes); return { status: 'ok', bytesWritten: bytes.byteLength }; },
      async close() {
        closed = true;
        dev.wakeAll(); // fail the pending reads like a real USBDevice.close() does
      },
    };
  }
  const devs = [new Device('A'), new Device('B')];
  const ports = devs.map(makePort), usb = devs.map(makeUsbDevice);
  const granted = { serial: [], usb: [] };
  const grant = (list, all) => async () => {
    shared.requests++;
    const next = all.find((x) => !list.includes(x));
    if (!next) throw new DOMException('No port selected by the user.', 'NotFoundError');
    list.push(next);
    return next;
  };
  Object.defineProperty(navigator, 'serial', { value: { requestPort: grant(granted.serial, ports), getPorts: async () => [...granted.serial] } });
  Object.defineProperty(navigator, 'usb', { value: { requestDevice: grant(granted.usb, usb), getDevices: async () => [...granted.usb] } });
  // Permissions survive a reload in a real browser.
  shared.restore = (serial, usbNames) => {
    granted.serial.push(...serial.map((i) => ports[i]));
    granted.usb.push(...usbNames.map((i) => usb[i]));
  };
})();
