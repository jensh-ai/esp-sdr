# Serial protocol

All burst firmware speaks the same line-based protocol over native USB or
UART0 (2 Mbaud, 8N1, no flow control). Send ASCII commands terminated by
`\n`; every command gets exactly one text reply line, and some replies are
followed by binary data. Errors start with `ERR`.

## Session

| Command | Reply | Notes |
| --- | --- | --- |
| `SYNC <nonce>` | `SYNC <nonce>` | Resynchronize after an interrupted transfer. |
| `INFO` | e.g. `S3SDR 6 burst 16380` | Family, protocol version, mode, maximum capture length. |
| `CAPS` | `CAPS <flags...>` | Optional features this firmware supports. |
| `VERSION?` | `VERSION {json}` | Git revision and build time, see [firmware-version.md](firmware-version.md). |
| `TRANSPORT?` | `TRANSPORT USB 0` or `TRANSPORT UART <baud>` | The interface this command arrived on. |
| `RELEASE` | `OK` | Give up the receiver lease. |

Only one client controls the radio at a time. The first command takes the
lease; a client on the other interface gets `ERR busy` until `RELEASE` or
five seconds of silence. Read each reply completely before sending the next
command.

Opening some ports resets the board (UART bridges with DTR/RTS wired to
EN/BOOT, the S2's USB-OTG port, the S31's USB Serial/JTAG). Clients should
send `SYNC` and discard everything up to the echoed nonce before talking to
the firmware.

## Receiver settings

| Command | Notes |
| --- | --- |
| `FREQ <MHz>` | Whole MHz, 100–6000 (`RANGE?`). Accepting a frequency does not guarantee PLL lock. |
| `LIMITS?` | `LIMITS {"gain":[min,max,step],"bandwidth":[min,max,step,default]\|null,"rates":[...],"bits":[...]}` |
| `GAIN HARDWARE` / `GAIN MANUAL <index>` / `GAIN?` | Hardware AGC is the default. Indices are PHY table entries, not dB. |
| `BANDWIDTH <MHz>` | Approximate analog bandwidth; `0` selects the widest setting. |
| `GPIO?` / `GPIO <pin> <Z\|0\|1>` | Spare GPIO outputs, e.g. for antenna switches. See [rx-controls.md](rx-controls.md#gpio-outputs). |

Details on gain, bandwidth, calibration and extended tuning are in
[rx-controls.md](rx-controls.md).

## Captures

`CAP16 <samples> <rate>` and `CAP20 <samples> <rate>` return samples as
`(I, -Q)` pairs. Both components are signed two's complement integers.

**Q is negated in the transmitted samples.** Negate the second component
when decoding to obtain standard `(I, Q)` samples.

| Format | Bits per sample | I | -Q |
| --- | --- | --- | --- |
| `CAP16` | 16 | First byte, signed 8-bit | Second byte, signed 8-bit |
| `CAP20` | 20 | Bits 0–9, signed 10-bit | Bits 10–19, signed 10-bit |

`CAP20` samples are packed consecutively, LSB first, with no padding between
samples. The reply is

```text
DATA <samples> <crc32-hex> <capture-microseconds>
```

followed by exactly `ceil(samples * bits * 2 / 8)` bytes. Check the CRC32
(zlib polynomial) before using the data. Only use rates listed in `LIMITS?`:

| Rate code | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MS/s | 80 | 40 | 20 | 10 | 8 | 4 | 16 | 32 | 10.667 | 6.4 |

A capture is a single burst; there are gaps between captures.

### Triggered captures (ESP32-C3, `TCAP` in `CAPS`)

Two receivers can start their snapshots together on a shared GPIO line:

```text
TCAP16 <samples> <rate> <pin> <M|S> <timeout-ms>
TCAP20 <samples> <rate> <pin> <M|S> <timeout-ms>
```

`<pin>` must be one of the pins `GPIO?` lists; connect that pin of both boards
and their GND. `S` (listener) configures the pin as input with pulldown, `M`
(master) as output that it raises itself. Unlike other commands, `TCAP`
replies with several lines:

1. `ARMED` once the receiver is configured and waits for the line. Arm the
   listener first and wait for its `ARMED` before sending `M` to the master.
2. `TRIG <late> <wait-us>`: `late` is `1` if the edge arrived while the
   receiver briefly had interrupts enabled between polling windows, which
   makes its start time less precise. `wait-us` is the time from arming to
   the trigger.
3. The usual `DATA` header and payload, as for `CAP16`/`CAP20`.

Both receivers arm the dump engine first and then poll the line with
interrupts disabled; the master raises the line and reads it back through the
same input path, so both detect it with the same latency. The polling and
trigger code runs from IRAM: from flash, a cache miss after the loop delayed
the start by about 2 µs (160 samples at 80 MS/s), differently on each board.
Measured on two ESP32-C3 since then: 1 to 4 samples between the snapshots.
The master lowers the line after its capture.

Errors: `ERR trigger_args`, `ERR rate`, `ERR trigger_pin` (pin not available),
`ERR gain`, `ERR trigger_busy` (listener sees the line high before arming),
`ERR trigger_timeout` (no edge within `<timeout-ms>`, at most 3000).

### Reference transmitter (ESP32-C3, `REFTX` in `CAPS`)

`REFTX <pin> <delay-us> <channel> <mbps> <power> <N|P> <mac>`

An optional third board drives the trigger line instead of receiver A: both
receivers wait with `TCAP… S`. When both report `ARMED`, the host sends
`REFTX`. The board raises the line and sends one 802.11 frame:

- `<delay-us>` (−5000 to 5000): time from the trigger edge to handing the
  frame to the Wi-Fi driver. Negative values queue the frame first and raise
  the line `|delay-us|` later. The driver still waits for a free channel, so
  the frame starts later than the hand-over, by a varying amount.
- `<channel>` 1 to 13; `<mbps>` one of 1, 2, 5 (5.5), 11, 6, 9, 12, 18, 24,
  36, 48, 54; `<power>` in 0.25 dBm, 8 to 84 (2 to 21 dBm).
- `N`: null-data frame, `P`: probe request (wildcard SSID).
- `<mac>`: receiver address, `FF:FF:FF:FF:FF:FF` for a broadcast. Another
  station answers a frame addressed to it with an ACK one SIFS (10 µs) after
  the frame. The frame is the reference and the ACK the target, both in the
  same snapshot and on the same channel.

Reply: `REFTX <acked> <queued-us> <done-us>`. `acked` is `1` when the driver
reports a successful transmission (an ACK for unicast frames, always for
broadcasts); `queued-us` and `done-us` are the hand-over and the driver's
completion, relative to the trigger edge (`done-us` is `-1` without a report
within 50 ms). The line stays high for at least 2 ms and is then released to
an input with pull-down.

The board switches Wi-Fi from NULL to station mode for this (once per rate),
so the next capture on it prepares the receiver again.

Errors: `ERR reftx_args`, `ERR rate`, `ERR trigger_pin`, `ERR reftx_wifi`
(Wi-Fi setup failed), `ERR reftx_send <code>` (`esp_wifi_80211_tx` failed).

Only address your own devices: every frame is a real transmission.

### Transmitter list (ESP32-C3, `SNIFF` in `CAPS`)

`SNIFF <channel> <ms>` (channel 1 to 13, 10 to 5000 ms) lists the
transmitters heard on a Wi-Fi channel, to pick a target address for `REFTX`.
The board restarts Wi-Fi with automatic gain, listens to management and data
frames in promiscuous mode, and replies one line per transmitter address
(at most 48), most frames first:

`STA <mac> <frames> <rssi-avg> <rssi-max> <flags> <bssid|->`

`flags`: `A` access point (beacon, probe response or from-DS data), `D` data
frames, `M` management frames. `bssid` is the access point a station sent
data to. Then `END <frames> <addresses>`. Errors: `ERR sniff_args`,
`ERR sniff_wifi`. The next capture on the board prepares the receiver again.

The [S3 continuous stream](iq-stream.md) also sends `(I, -Q)` pairs.
The separate [S31 streaming firmware](s31-streaming.md#iq-packets) sends
`(I, Q)` pairs.

## Streaming modes

- On-chip spectra (`SPEC`, all chips): [spectrum.md](spectrum.md)
- Continuous decimated I/Q on the S3 (`IQS`): [iq-stream.md](iq-stream.md)
- Continuous I/Q over Ethernet/USB on the S31 (separate firmware): [s31-streaming.md](s31-streaming.md)
