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

## Hosting

The app is static: serve this folder with any web server. Web Serial requires
**HTTPS or localhost** and Chrome/Edge (or Firefox 151+) on the desktop.

```bash
cd webapp && python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## Limits of the current firmware

Both snapshots are started by separate USB commands, so they begin with a
host/USB jitter in the order of a millisecond, while a full snapshot is only
about 205 µs long at 80 MS/s. The correlation only works when both snapshots
contain the same signal at the same time. Without a hardware trigger this is
the case for continuous signals, or by chance. A shared GPIO trigger in the
firmware is the next step.

The time offset can only be measured from wideband signals (a CW tone looks
the same at every delay). The app warns when no wideband coherent component is
present, because the phase difference between bands at different frequencies
is then unreliable.

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

The tests simulate two receivers with an LO offset, random LO phase,
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
