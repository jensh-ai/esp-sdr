# Dual-SDR Correlator (web app)

Single-page web app that connects two ESP-SDR receivers (for example two
ESP32-C3 boards), takes one I/Q snapshot from each, and cross-correlates them:

- **LO offset (CFO)** between the two receivers, from the product A·conj(B)
- **Time offset** between the snapshots: coarse from the cross-correlation,
  refined from the cross-spectrum phase slope of wideband components
- **Phase difference per band**: a *reference* band (known transmitter) and a
  *target* band; Δφ = φ_target − φ_ref cancels the receivers' unknown LO phase
- **Angle of arrival** from Δφ, the antenna spacing and the RF frequency, with
  averaging and a "set current direction as 0°" calibration
- Export/import of a snapshot pair as JSON for offline analysis

It also contains the firmware installer (`flash.html`) with the prebuilt
ESP32-C3 firmware in `firmware/`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../docs/webapp-correlator-dark.png">
  <img src="../docs/webapp-correlator-light.png" alt="Dual-SDR Correlator after 38 GPIO-triggered captures: metrics, power spectrum with reference and target bands, envelope, cross-correlation, cross-spectrum phase and phase history">
</picture>

*The screenshot shows two **emulated** receivers (a browser-side stand-in for
the firmware protocol, not real hardware): wideband noise plus a CW reference
at −3 MHz, receiver B with a 20 kHz LO offset, a 3-sample time offset and an
extra 0.6 rad (34.4°) on the reference. The app recovers 20.00 kHz,
−3.00 samples and Δφ = 34.3° with 0.8° spread over 38 captures.*

How to read the plots:

| Plot | What it shows |
| --- | --- |
| Power spectrum | Both receivers (blue A, orange B) with the reference (green) and target (purple) bands |
| Envelope | Signal power over the snapshot; bursts should line up in both receivers |
| Cross-correlation | Peak at the time offset between the snapshots; no clear peak means no common signal |
| Cross-spectrum phase | Phase of A·B* per frequency after removing the time offset; coherent bins are highlighted. A flat line means the time offset is removed; a step between the bands is the measured Δφ |
| History | Δφ (blue) and angle (orange) per capture |

## Hosting

The app is static: serve this folder with any web server. Web Serial requires
**HTTPS or localhost** and Chrome/Edge (or Firefox 151+) on the desktop.

```bash
cd webapp && python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

**GitHub Pages:** `.github/workflows/pages.yml` publishes this folder from
`main` on every change, without a separate `gh-pages` branch. Enable it once in
the repository under *Settings → Pages → Build and deployment → Source:
GitHub Actions*. The app is then at `https://<user>.github.io/<repo>/`.

## Synchronizing the two receivers

With the default **GPIO trigger**, both snapshots start on a shared wire:

1. Connect the trigger pin (default GPIO 4) of board A to the same pin of
   board B, and connect the GND of both boards. A series resistor of a few
   hundred ohms protects against both sides driving the line by mistake.
   Avoid the strapping pins 2, 8 and 9, the USB pins 18/19 and the UART pins
   20/21.
2. A raises the line, B listens. The app arms B first and only then lets A
   fire; see `TCAP` in [docs/protocol.md](../docs/protocol.md).

The remaining start-time difference is a few samples and is measured from the
data. That needs a wideband signal in both snapshots (a CW tone looks the same
at every delay): the app warns when there is none, because the phase
difference between bands at different frequencies is then unreliable.

**Software trigger** (two USB commands) remains available for firmware without
`TCAP`; its start-time jitter of about a millisecond is longer than a whole
snapshot (205 µs at 80 MS/s), so the snapshots only overlap by chance.

## Files

| File | Origin |
| --- | --- |
| `index.html`, `app.js`, `style.css` | New: two-receiver UI |
| `dsp.js` | New: correlation and phase analysis (browser and Node) |
| `radio.js`, `serial-transport.js` | Unchanged from [ESPARGOS/esp-web-sdr](https://github.com/ESPARGOS/esp-web-sdr) at `6995ed7` |
| `flash.html`, `flasher/`, `fonts.css` | From esp-web-sdr, with labels and links adapted |
| `firmware/` | ESP32-C3 build of this repository (see `build-info.json`) |

All of it is licensed under GPL-3.0, like esp-sdr and esp-web-sdr.

## Updating the firmware

The `Build firmware (ESP32-C3)` workflow uploads the artifact
`firmware-esp32c3`. Its contents have the same layout as `firmware/`
(`manifest.json`, `esp32c3/*.bin`, `flash_args`, merged image), so replace the
folder with the artifact contents.

## Tests

```bash
node --test 'webapp/tests/*.test.mjs'
```

Browser test against two emulated receivers (Playwright with Chromium);
with a directory argument it also writes the screenshots used above:

```bash
node webapp/tests/e2e/e2e.cjs [screenshot-dir]
```

The DSP tests simulate two receivers with an LO offset, random LO phase,
fractional time offset, noise, a CW reference and a wideband target, and check
that the known phase difference is recovered.

## Loading an exported pair in Python

```python
import base64, json, numpy as np

pair = json.load(open("esp-sdr-pair.json"))
fs = pair["settings"]["rate"]
for dev in pair["devices"]:
    raw = np.frombuffer(base64.b64decode(dev["data"]), dtype=np.int8)  # format iq8
    iq = (raw[0::2] - 1j * raw[1::2]) / 128.0  # Q is negated, as in radio.js
    print(dev["name"], len(iq), "samples at", fs / 1e6, "MS/s")
```

(For `iq10`, the 10-bit samples are packed LSB first, two samples per five
bytes; see `decodeIQ()` in `radio.js`.)
