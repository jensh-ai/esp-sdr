# Projektkontext für Claude (Fork jensh-ai/esp-sdr)

Fork von [ESPARGOS/esp-sdr](https://github.com/ESPARGOS/esp-sdr) (GPL-3.0). Ziel:
mit zwei (später mehr) **ESP32-C3**-Standardmodulen per IQ-Snapshots den
**Einfallswinkel (AoA)** beliebiger 2,4-GHz-Quellen bestimmen, später mehrere
Peilpaare zur Ortung kombinieren. Kein gemeinsamer Takt, nur eine
GPIO-Triggerleitung + GND zwischen den Modulen.

## Arbeitsregeln des Nutzers

- Nur im eigenen Repo arbeiten. **Keine Pull Requests** (auch nicht upstream).
- Merge nach `main` macht der Nutzer selbst. Arbeit in Feature-Branches.
- Keinen Code parallel in mehreren Branches pflegen (daher Pages ohne gh-pages-Branch).
- Kein lokales ESP-IDF beim Nutzer (Arduino IDE ist installiert, aber für
  esp-sdr ungeeignet). Builds macht CI oder Claude in der Cloud-Session;
  geflasht wird per Web-Flasher oder Arduino-esptool.
- Kommunikation auf Deutsch; Code, Commits und Repo-Doku auf Englisch.

## Branches (Stand 2026-11-11)

- `main`: unverändert upstream (`a8eaac1`), solange der Nutzer nicht merged.
- `ci/esp32c3-build`: C3-Workflow, WebApp (Basis für den nächsten Branch).
- `feature/sync-trigger`: **aktueller Stand**, enthält alles aus
  `ci/esp32c3-build` + GPIO-Trigger + Doku + Screenshots.

Achtung beim Klonen: Der Session-Klon holt nur `main`. Für neue Branches
`git config --add remote.origin.fetch '+refs/heads/<b>:refs/remotes/origin/<b>'`,
sonst meldet der Stop-Hook „unpushed commits“, obwohl gepusht ist.

## Bauen der Firmware

- ESP-IDF **6.2**, gepinnt auf Commit `25fe69f946311abdaf9ad56591f25fedbc20ac98`
  (`firmware-targets.json`). Arduino-ESP32 (IDF 5.x) ist inkompatibel: esp-sdr
  braucht `--wrap`-Linkeroptionen auf PHY-Funktionen, ein eigenes Linkerskript
  und `CONFIG_ESP_PHY_ENABLE_CERT_TEST`/`ESP_PHY_DEBUG`.
- Die Cloud-Umgebung **„esp-sdr“** installiert die IDF per Setup-Skript nach
  `/opt/esp/esp-idf` und setzt `IDF_PYTHON_CHECK_CONSTRAINTS=no`. In Sessions
  dieser Umgebung nur noch `source /opt/esp/esp-idf/export.sh`. Ohne sie
  manuell (dauert einige Minuten):
  `git init`, `fetch --depth 1` des Commits, `submodule update --init --recursive --depth 1`,
  `./install.sh esp32c3`. Der Proxy blockiert `dl.espressif.com`, daher danach
  `python3 tools/idf_tools.py install-python-env --no-constraints` und beim
  Aktivieren `export IDF_PYTHON_CHECK_CONSTRAINTS=no; source <idf>/export.sh`.
- Build: `python tools/build_firmware.py --profile esp32c3 --version <sha> --output <dir> --build-root <dir>`
  (~1 min). Merged-Image: `python -m esptool --chip esp32c3 merge-bin -o esp-sdr-esp32c3-merged.bin @flash_args`.
- Vorgebaute Firmware liegt in `webapp/firmware/` (Manifest + Einzel-Images +
  Merged-Image + SHA256SUMS). Immer aus einem **sauberen Commit** bauen
  (Revision steht im Image), dann die Binaries in einem eigenen Commit.
- CI: `.github/workflows/firmware-c3.yml` (nur C3, Caches für IDF/Tools/ccache,
  Artifact `firmware-esp32c3` im gleichen Layout wie `webapp/firmware/`).
  `firmware.yml` (alle Targets) und `rebuild-site.yml` laufen nur noch upstream
  bzw. manuell. Actions im Fork muss der Nutzer einmal aktivieren (ungeprüft, ob erledigt).

## Firmware-Erweiterung: `TCAP` (nur C3, `main/targets/esp32c3/receiver.c`)

`TCAP16|TCAP20 <samples> <rate> <pin> <M|S> <timeout_ms>` → `ARMED`, dann
`TRIG <late> <wait_us>`, dann `DATA …` + Payload (wie CAP16/CAP20).
Dump-Engine wird vorher komplett konfiguriert; beide pollen `GPIO_IN_REG` in
~1-ms-Fenstern mit gesperrten Interrupts (dazwischen kurz frei, `late=1` wenn
die Flanke in der Lücke kam). Master setzt die Leitung selbst und liest sie über
denselben Eingang zurück (gleiche Latenz). Fehler: `trigger_args`, `rate`,
`trigger_pin`, `gain`, `trigger_busy`, `trigger_timeout` (max. 3000 ms).
`burst_gpio_trigger_pin()` in `main/common/burst_gpio.c`. Doku: `docs/protocol.md`.
**Auf Hardware noch nicht getestet**; Rest-Jitter (erwartet: zehn ns) ungemessen.

## WebApp (`webapp/`, statisch, kein Build)

- `index.html`/`app.js`/`style.css`: Zwei-Empfänger-UI (Web Serial). GPIO-Modus:
  B (Slave) scharf schalten, auf `ARMED` warten, dann A (Master). Software-Modus
  (zwei CAP-Befehle, ~1 ms Jitter > 205-µs-Snapshot) nur als Fallback.
- `radio.js`, `serial-transport.js`: unverändert aus ESPARGOS/esp-web-sdr `6995ed7`.
  `flash.html` + `flasher/`: Web-Flasher (esptool-js), lädt `firmware/manifest.json`.
- `dsp.js` (Browser + Node), Pipeline in `analyze()`:
  1. DC entfernen.
  2. LO-Versatz (CFO): Peak von FFT(a[t+k]·b*[t]), Suche über k = ±32 Samples
     (Kreuz-Ambiguität), dann Feinsuche mit Zero-Padding. b um +CFO drehen.
  3. Grober Lag aus normaler Kreuzkorrelation (wird von CW-Tönen verfälscht).
  4. Welch-Kreuzspektrum (nfft 1024 ist am genauesten), Feinschätzung des Lags
     aus der Phasensteigung benachbarter Bins, nur in kohärenten Bereichen
     (γ ≥ 0,5, ≥ 8 Bins, effektive Bandbreite ≥ 4 Bins); schmalbandige Spitzen
     (> 10 dB über Bins 3–6 links/rechts) werden ausmaskiert. Iteriert, bis stabil.
  5. Bandphasen Referenz/Ziel, Δφ = φ_Ziel − φ_Ref − Kalibrierung,
     Winkel = asin(Δφ·c / (2π·f·d)).
  Grundsatz: **CW-Töne enthalten keine Zeitversatz-Information.** Mindestens ein
  breitbandiges Signal (WLAN/BLE) muss in beiden Snapshots sein, sonst Warnung.
  Genauigkeit in Simulation: Lag ≈ 0,1 Sample, Δφ < 0,06 rad.
- Export/Import eines Paars als JSON (Python-Snippet in `webapp/README.md`).
- Hosting: `.github/workflows/pages.yml` veröffentlicht `webapp/` aus `main`
  (Settings → Pages → Source: GitHub Actions, vom Nutzer noch zu aktivieren).
  Lokal: `cd webapp && python3 -m http.server 8000`.

## Tests

- Firmware-Host-Tests: `python3 -m unittest discover -s tests` (59 Tests, Mocks
  in `tests/test_gpio.py`, `tests/test_c3_commands.py`; TCAP-Parsing selbst ist
  im Host-Test nicht abgedeckt).
- DSP: `node --test 'webapp/tests/*.test.mjs'` (simulierte Empfänger).
- Browser-E2E: `node webapp/tests/e2e/e2e.cjs [screenshot-dir]`
  (Playwright; `emulator.js` emuliert zwei C3 inkl. TCAP; erzeugt mit Argument
  die Screenshots `docs/webapp-correlator-{light,dark}.png`).

## Offene Punkte / nächste Schritte

1. Hardware-Test: zwei C3, GPIO 4 ↔ GPIO 4 + GND (Serienwiderstand einige 100 Ω),
   WLAN-Router als breitbandige Quelle. Prüfen: TCAP-Ablauf, Correlation peak,
   Streuung des Zeitversatzes, keine Watchdog-Resets im Dauerbetrieb.
2. Phasenkalibrierung mit Quelle bei bekanntem Winkel; Mehrwege-Effekte innen.
3. Optional: schnellerer GPIO-Pfad (dedicated GPIO), Hardware-Trigger-Quelle
   des Dump-Blocks untersuchen (Register „Trigger source“ in C2/H2-Doku).
4. Später: mehrere Peilpaare, Schnitt der Peilungen; Snapshots nur mit
   Referenz in Phase normieren (Datenreduktion für Auswertung auf dem ESP).
