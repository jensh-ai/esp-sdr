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
Erster Hardware-Test (2026-11-11): Ablauf funktioniert, aber ~160 Samples (2 µs)
Versatz, solange die Funktion aus dem Flash lief (Cache-Miss nach der
Poll-Schleife). Seitdem `IRAM_ATTR` auf `acquire_iq_triggered`: gemessen
nur noch −1 bis −4 Samples (Korrelation 0,82–0,996). Exportierte Paare ohne Sendung im 205-µs-Fenster
enthalten nur Rauschen (RMS ~3–4 LSB bei Gain 40) und gehen nicht in die Mittelung.

## Firmware-Erweiterung: `REFTX` (optionaler Referenzsender, nur C3)

`REFTX <pin> <H|S> <delay_us> <channel> <mbps> <power/0.25dBm> <N|P> <mac>` → treibt
die Triggerleitung (A und B beide `TCAP … S`), sendet einen 802.11-Frame per
`esp_wifi_80211_tx` (Null-Data oder Probe Request; vorher Wi-Fi NULL → STA,
Rate nur bei gestopptem Wi-Fi setzbar), Antwort `REFTX <acked> <queued_us>
<done_us>` aus dem TX-Done-Callback. Unicast an eine fremde MAC → deren ACK
10 µs später = Zielsignal im selben Snapshot. Delay ist vom Nutzer per GUI
einzustellen (Default 0), MAC-Wartezeit (CSMA) variiert. **Auf Hardware
ungetestet**. Erster Hardware-Test (2026-11-16): weder REFTX-Burst noch
SNIFF-Treffer, weil `prepare_rx` PBUS-Zeilen (0/1, 1/1, 1/2, 4/1, 5/1 via
`rom_pbus_xpd_tx_off`/`rx_on` → `rom_pbus_force_test`) und PBUS-/RX-Clock-Modi
setzt, die ein Wi-Fi-Neustart nicht zurücksetzt. Seitdem `rf_mode_save()`
(beim ersten `prepare_rx` nach dem Boot) und `rf_mode_restore()` vor
REFTX/SNIFF, dazu AGC freigeben und Kanal per Umweg neu setzen (`wifi_tune`).
Danach (2026-11-16) sendet REFTX auf Hardware, aber der Frame kommt ~760 µs
nach `esp_wifi_80211_tx` (queued 2 µs, done 903 µs). Deshalb Modus `H`:
Antennen-Select-Signal (`esp_phy_set_ant_gpio`/`esp_phy_set_ant`, TX-Antenne 1,
RX-Antenne 0) direkt auf den Triggerpin, GPIO-Interrupt hält die Leitung
danach als normaler Ausgang hoch. `S` = alter Software-Modus mit Delay.
Modus H lieferte auf Hardware `ERR reftx_antenna` (jetzt mit Schritt + Code).
Messung mit S und Delay −1: `queued −753 µs` → der Treiberaufruf blockiert
~750 µs (WLAN-Task bereitet vor), Frame startet ~730 µs nach dem Aufruf, also
vor dessen Rückkehr (Burst am Anfang abgeschnitten). Seitdem negatives Delay
per gptimer-Alarm-ISR (`reftx_timer_arm`), Default −700 µs. SNIFF fand nie
etwas: zusätzlich Promiscuous explizit aus/an, `0x60033d90` (Dump-Routing,
von jedem Capture gesetzt) in `rf_mode_save/restore`, END meldet jetzt auch
die Zahl aller Pakete (0 = RX-Pfad tot). Beides auf Hardware ungeprüft.
**Erster Erfolg (2026-11-16, fw a5bfdb9, S/−1 µs, 6 Mbps, Router-MAC, Kanal 1):**
Referenz-Frame 0–55 µs (Anfang abgeschnitten), Router-ACK 72–116 µs
(Lücke ~16 µs = SIFS 10 µs + 6 µs ERP-OFDM Signal Extension), Kohärenz
Ref/Ziel 0,82/0,99, CFO −24,7 kHz, Lag 1,3 Samples. ACK ~26 dB stärker als
die Referenz (2 dBm), A clippt im ACK leicht (0,6 %). DSP: im Burst-Modus kommt der Lag jetzt
aus den Bursts (`burstLag`, Maximum von |Σ A·B*|), sonst lag er bei 16 MS/s
mit einem 31-µs-Burst 0,5 Sample daneben und die CFO-Verfeinerung kippte.

`SNIFF <channel> <ms>` (nur C3): Wi-Fi-Neustart mit AGC, Promiscuous
(MGMT+DATA), Tabelle max. 48 Sender → `STA <mac> <frames> <rssi_avg>
<rssi_max> <A|D|M> <bssid|->`, dann `END`. WebApp: „Find devices on this
channel“ (Referenzsender oder Empfänger), „Use“ übernimmt die MAC. Nach
REFTX/SNIFF ist `rx_ready` false; eine durch den Wi-Fi-Neustart erneuerte
PHY-DC-Kalibrierung erkennt `rx_recalibration_stale()` selbst.

Schmale Spitzen im Spektrum auf einem 2-MHz-Raster (z. B. 2440/2444/2448 MHz)
liegen in A und B bei identischem Offset trotz LO-Versatz → empfängerinterne
Takt-Spurs, für Sync und Referenz ungeeignet (nicht ins Referenzband legen).

## WebApp (`webapp/`, statisch, kein Build)

- `index.html`/`app.js`/`style.css`: Zwei-Empfänger-UI (Web Serial). GPIO-Modus:
  B (Slave) scharf schalten, auf `ARMED` warten, dann A (Master). Software-Modus
  (zwei CAP-Befehle, ~1 ms Jitter > 205-µs-Snapshot) nur als Fallback.
- Verbindung pro Empfänger wahlweise Web Serial oder WebUSB (CDC über
  `NativeUSBPort` aus `serial-transport.js`). Rolle → Gerät in `localStorage`
  (`dual-sdr.port.A/B`: WebUSB per USB-Seriennummer, Web Serial per Index in
  `getPorts()`), „Connect“ ohne Browser-Dialog, „Other device…“ mit Dialog,
  „Swap A ↔ B“ tauscht Rollen. Emulator kennt auch `navigator.usb`.
- `radio.js`, `serial-transport.js`: unverändert aus ESPARGOS/esp-web-sdr `6995ed7`.
  `flash.html` + `flasher/`: Web-Flasher (esptool-js), lädt `firmware/manifest.json`.
- `dsp.js` (Browser + Node), Pipeline in `analyze()`:
  1. DC entfernen.
  2. Grober Zeitversatz CFO-tolerant (`coarseLag`: 256-Sample-Segmente
     korrelieren, Beträge inkohärent summieren, ±2048 Samples).
     LO-Versatz (CFO): Peak von FFT(a[t+k]·b*[t]), Suche über k = Grob-Lag ±32
     (Kreuz-Ambiguität), dann Feinsuche mit Zero-Padding. b um +CFO drehen.
  3. Grober Lag aus normaler Kreuzkorrelation (wird von CW-Tönen verfälscht).
  4. Welch-Kreuzspektrum (nfft 1024 ist am genauesten), Feinschätzung des Lags
     aus der Phasensteigung benachbarter Bins, nur in kohärenten Bereichen
     (γ ≥ 0,5, ≥ 8 Bins, effektive Bandbreite ≥ 4 Bins); schmalbandige Spitzen
     (> 10 dB über Bins 3–6 links/rechts) werden ausmaskiert. Iteriert, bis stabil.
  5. Modus „Bänder“: Bandphasen Referenz/Ziel. Modus „Bursts“ (Referenzsender):
     Bursts aus Hüllkurve (Schwelle dB über 10-%-Perzentil), Rest-CFO aus der
     Phasendrift *innerhalb* der Bursts (sonst wird der Phasensprung zwischen
     kurzen Bursts als Frequenz fehlinterpretiert), B fraktional ausgerichtet,
     Phase je Burst. Gleicher Kanal ⇒ Zeitversatzfehler kürzt sich.
     Δφ = φ_Ziel − φ_Ref − Kalibrierung,
     Winkel = asin(Δφ·c / (2π·f·d)).
  Grundsatz: **CW-Töne enthalten keine Zeitversatz-Information.** Mindestens ein
  breitbandiges Signal (WLAN/BLE) muss in beiden Snapshots sein, sonst Warnung.
  Genauigkeit in Simulation: Lag ≈ 0,1 Sample, Δφ < 0,06 rad.
  CFO-Lag-Suche bewertet die absolute Spitzenleistung (Spitze/Mittel versagt
  bei kurzen Bursts).
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
