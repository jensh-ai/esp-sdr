# ESP-SDR firmware for ESP32-C3

Prebuilt image of this fork. The build details are in `build-info.json`
(source revision and pinned ESP-IDF commit, currently ESP-IDF 6.2).

| File | Use |
| --- | --- |
| `esp-sdr-esp32c3-merged.bin` | Single image, flash to offset **0x0** |
| `esp32c3/*.bin` + `flash_args` | Separate images (bootloader 0x0, partition table 0x8000, app 0x10000) |
| `manifest.json` | Manifest in the esp-web-sdr format |
| `SHA256SUMS` | Checksum of the merged image |

## Flashing

Connect the C3 over its native USB port. If it is not detected, hold BOOT
while pressing RESET.

**In the browser (Chrome/Edge):** open the esptool-js web flasher
(<https://espressif.github.io/esptool-js/>), connect, choose
`esp-sdr-esp32c3-merged.bin` at address `0x0`, and program.

**With the esptool bundled with Arduino-ESP32** (no ESP-IDF needed):

```bash
esptool --chip esp32c3 --port COM5 write_flash 0x0 esp-sdr-esp32c3-merged.bin
```

On Windows, the esptool is in
`%LOCALAPPDATA%\Arduino15\packages\esp32\tools\esptool_py\<version>\esptool.exe`;
on Linux/macOS, it is in `~/.arduino15/packages/esp32/tools/esptool_py/<version>/`.
Replace `COM5` with your port (for example `/dev/ttyACM0`).

## Rebuilding

The `Build firmware (ESP32-C3)` GitHub Actions workflow
(`.github/workflows/firmware-c3.yml`) builds the same image on every push
that changes firmware sources and uploads it as the `firmware-esp32c3`
artifact.
