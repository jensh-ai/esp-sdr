/* ESP32-C3 burst SDR over native USB Serial/JTAG and UART0. */
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "driver/usb_serial_jtag.h"
#include "esp_attr.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_rom_crc.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "heap_memory_layout.h"
#include "nvs_flash.h"
#include "soc/gpio_reg.h"
#include "soc/soc.h"

#include "burst_serial.h"
#include "burst_gpio.h"
#include "burst_version.h"
#include "spectrum.h"
#include "rx_recalibration.h"
#include "rx_tuning.h"
#include "rx_lo.h"
#include "esp_rom_sys.h"

/* Pinned C3 librftest adctrig: 64 KiB at 0x3fcb0000, usage=2,
 * allocation bit 3. Reserve the FULL 128 KiB bank and its IRAM alias:
 * allowing heap/DMA traffic in the lower half leaves holes in RF dumps. */
SOC_RESERVE_MEMORY_REGION(0x3fca0000, 0x3fcc0000, c3_rf_dump);
#define IQ_WORDS       16380u
#define IQ_BUFFER      ((uint32_t *)0x3fcb0000)
#define SRAM_OWNER_REG 0x600c1020u
extern void stop_tx_tone(unsigned);
extern void rom_pbus_workmode(void);
extern void rom_pbus_xpd_rx_on(unsigned);
extern void rom_pbus_xpd_tx_off(void);
extern void rom_set_rxclk_en(unsigned);
extern void set_chanfreq(unsigned, unsigned);
extern void phy_set_freq(unsigned, int);
extern unsigned rom1_chip_i2c_readReg(unsigned, unsigned, unsigned);
extern void rom1_chip_i2c_writeReg(unsigned, unsigned, unsigned, unsigned);
static int rx_filter = -1;
static unsigned rx_filter_saved[2];
/* BBTOP I/Q CBW20 capacitor codes. Preserve calibration and upper bits. */
static void rx_filter_apply(void) {
    for (unsigned j = 0; j < 2; j++) {
        rx_filter_saved[j] = rom1_chip_i2c_readReg(0x67, 1, 4 + j);
        if (rx_filter >= 0)
            rom1_chip_i2c_writeReg(0x67, 1, 4 + j, (rx_filter_saved[j] & ~63u) | (unsigned)rx_filter);
    }
}
static void rx_filter_restore(void) {
    if (rx_filter >= 0)
        for (unsigned j = 0; j < 2; j++) rom1_chip_i2c_writeReg(0x67, 1, 4 + j, rx_filter_saved[j]);
}
static unsigned frequency_mhz = 2412;
static bool rx_ready;
#define C3_FREQ_MIN RX_FREQ_MIN
#define C3_FREQ_MAX RX_FREQ_MAX
static bool frequency_valid(unsigned mhz) {
    return mhz >= C3_FREQ_MIN && mhz <= C3_FREQ_MAX;
}
static void tune_rx(unsigned mhz) {
    static unsigned calibrated_mhz;
    if (calibrated_mhz != mhz || rx_recalibration_stale()) {
        rx_recalibrate(mhz);
        calibrated_mhz = mhz;
    }
    rx_lo_plan_t plan = rx_lo_plan(mhz);
    bool channel = (mhz >= 2412 && mhz <= 2472 && (mhz - 2412) % 5 == 0) || mhz == 2484;
    rx_lo_select(false);
    set_chanfreq(channel ? mhz : 2412, 0);
    if (!channel) phy_set_freq(plan.mhz, plan.offset_khz);
}
#define send_bytes burst_serial_send
static void reply(const char *s) {
    (void)send_bytes(s, strlen(s));
}
#include "burst_gain.h"
#include "burst_limits.h"

static void prepare_rx(void) {
    if (rx_ready && !rx_recalibration_stale()) {
        if (gain_mode == GAIN_MANUAL) gain_applied = rx_gain_verified_check(gain_code);
        return;
    }
    tune_rx(frequency_mhz);
    stop_tx_tone(1);
    rom_pbus_workmode();
    rom_pbus_xpd_tx_off();
    rom_pbus_xpd_rx_on(1);
    rom_set_rxclk_en(1);
    rx_lo_select(rx_lo_plan(frequency_mhz).alternate);
    esp_rom_delay_us(3000);
    gain_apply();
    rx_ready = true;
}

#include "burst_capture.h"
static portMUX_TYPE capture_mux = portMUX_INITIALIZER_UNLOCKED;

/* Shared GPIO trigger line between two receivers (TCAP command). Both sides
 * arm the dump engine first and then poll the same line with interrupts
 * disabled; the master raises the line and reads it back through the same
 * input path, so both see the edge with the same latency. */
typedef struct {
    unsigned pin;
    bool drive;          /* master: raises the line */
    int64_t timeout_us;  /* waiting time for the slave */
    bool late;           /* out: edge arrived while interrupts were enabled */
    bool timed_out;      /* out */
    uint32_t wait_us;    /* out: time from arming to trigger */
} capture_trigger_t;
/* Poll iterations per interrupt-free window, roughly 1 ms on the C3. */
#define TRIGGER_WINDOW_SPINS 10000u

/* In IRAM: from flash, the instructions after the polling loop can miss the
 * cache, which delays the dump start by a few microseconds, differently on
 * each board (seen as ~160-sample offsets between two triggered captures). */
static IRAM_ATTR bool acquire_iq_triggered(unsigned n, unsigned divider, unsigned *capture_us, capture_trigger_t *trig) {
    if (divider != 0 && divider != 1 && divider != 6) {
        reply("ERR rate\n");
        return false;
    }
    prepare_rx();
    if (!gain_applied) return false;

    for (unsigned j = 0; j < n; j++) IQ_BUFFER[j] = 0xa5a0055au;
    rx_filter_apply();
    /* Prevent task/interrupt interleaving during the bank handoff and
     * bounded snapshot (at the maximum sample count about 205 us at 80 MS/s,
     * 410 us at 40 MS/s and 1 ms at 16 MS/s). */
    taskENTER_CRITICAL(&capture_mux);
    uint32_t owner = REG_READ(SRAM_OWNER_REG);
    int64_t start = esp_timer_get_time();
    REG_WRITE(0x60033d5c, 0);
    REG_WRITE(0x60033d90, (1u << 6) | (2u << 12) | (3u << 18));
    REG_WRITE(SRAM_OWNER_REG, (owner & ~7u) | 2u | 8u);
    __asm__ volatile("fence rw,rw" ::: "memory");
    /* Like the S3: bit 15 halves the 80 MS/s dump clock, bit 16 divides it by five. */
    uint32_t ctrl = 0x80000000u | n | (divider == 1 ? 1u << 15 : divider == 6 ? 1u << 16 : 0);
    REG_WRITE(0x60033d5c, ctrl);
    bool done = false;
    uint32_t elapsed = 0;
    if (trig) {
        const uint32_t mask = 1u << trig->pin;
        const int64_t armed = start, deadline = start + trig->timeout_us;
        bool first = true;
        if (trig->drive) REG_WRITE(GPIO_OUT_W1TS_REG, mask);
        for (;;) {
            uint32_t spins = 0, level;
            while (!((level = REG_READ(GPIO_IN_REG)) & mask) && spins < TRIGGER_WINDOW_SPINS) spins++;
            if (level & mask) {
                /* High at the first read of a later window: the edge came
                 * while interrupts were enabled, so its latency is unknown. */
                trig->late = !trig->drive && spins == 0 && !first;
                break;
            }
            first = false;
            /* Let interrupts run between windows; the dump engine stays armed. */
            taskEXIT_CRITICAL(&capture_mux);
            bool expired = esp_timer_get_time() >= deadline;
            taskENTER_CRITICAL(&capture_mux);
            if (expired) {
                trig->timed_out = true;
                break;
            }
        }
        if (!trig->timed_out) {
            REG_WRITE(0x60033d5c, ctrl | (1u << 19));
            REG_WRITE(0x60033d5c, ctrl);
            start = esp_timer_get_time();
            trig->wait_us = (uint32_t)(start - armed);
        }
    } else {
        REG_WRITE(0x60033d5c, ctrl | (1u << 19));
        REG_WRITE(0x60033d5c, ctrl);
    }
    if (!trig || !trig->timed_out) {
        while (!(REG_READ(0x60033d5c) & (1u << 18)) && esp_timer_get_time() - start < 20000) {}
        done = (REG_READ(0x60033d5c) & (1u << 18)) != 0;
        elapsed = esp_timer_get_time() - start;
    }
    if (trig && trig->drive) REG_WRITE(GPIO_OUT_W1TC_REG, 1u << trig->pin);
    REG_WRITE(0x60033d5c, 0);
    REG_WRITE(SRAM_OWNER_REG, owner);
    __asm__ volatile("fence rw,rw" ::: "memory");
    taskEXIT_CRITICAL(&capture_mux);
    rx_filter_restore();
    if (trig && trig->timed_out) {
        reply("ERR trigger_timeout\n");
        return false;
    }
    if (!done) {
        reply("ERR capture_timeout\n");
        return false;
    }
    for (unsigned j = 0; j < n; j++) {
        if (IQ_BUFFER[j] == 0xa5a0055au) {
            reply("ERR capture_incomplete\n");
            return false;
        }
    }
    *capture_us = elapsed;
    return true;
}

static bool acquire_iq(unsigned n, unsigned divider, unsigned *capture_us) {
    return acquire_iq_triggered(n, divider, capture_us, NULL);
}

static bool spectrum_acquire(unsigned n, unsigned rate, const uint32_t **data, unsigned *elapsed) {
    bool ok = acquire_iq(n, rate, elapsed);
    *data = IQ_BUFFER;
    return ok;
}

#include "ring_probe.h"

static bool capture(unsigned n, unsigned divider, unsigned format) {
    unsigned elapsed;
    if (!acquire_iq(n, divider, &elapsed)) {
        if (!gain_applied) reply("ERR gain\n");
        return false;
    }
    return burst_send_capture(n, format, elapsed);
}

/* TCAP16|TCAP20 <samples> <rate> <pin> <M|S> <timeout_ms>: one capture
 * started by the shared trigger line. Replies ARMED once the receiver waits,
 * then TRIG <late> <wait_us> and the usual DATA header and payload. */
static bool triggered_capture_command(const char *line) {
    unsigned bits, n, divider, pin, timeout_ms;
    char role, extra;
    if (strncmp(line, "TCAP", 4)) return false;
    if (sscanf(line, "TCAP%u %u %u %u %c %u %c", &bits, &n, &divider, &pin, &role, &timeout_ms, &extra) != 6 ||
        (bits != 16 && bits != 20) || n < 256 || n > IQ_WORDS || (role != 'M' && role != 'S') ||
        timeout_ms < 1 || timeout_ms > 3000) {
        reply("ERR trigger_args\n");
        return true;
    }
    if (divider != 0 && divider != 1 && divider != 6) {
        reply("ERR rate\n");
        return true;
    }
    capture_trigger_t trig = {.pin = pin, .drive = role == 'M', .timeout_us = (int64_t)timeout_ms * 1000};
    if (!burst_gpio_trigger_pin(pin, trig.drive)) {
        reply("ERR trigger_pin\n");
        return true;
    }
    prepare_rx();
    if (!gain_applied) {
        reply("ERR gain\n");
        return true;
    }
    /* A slave must see the line low before it arms, or it would fire at once. */
    esp_rom_delay_us(20);
    if (!trig.drive && (REG_READ(GPIO_IN_REG) & (1u << pin))) {
        reply("ERR trigger_busy\n");
        return true;
    }
    reply("ARMED\n");
    unsigned elapsed;
    if (!acquire_iq_triggered(n, divider, &elapsed, &trig)) return true;
    char header[48];
    snprintf(header, sizeof(header), "TRIG %u %" PRIu32 "\n", trig.late ? 1u : 0u, trig.wait_us);
    reply(header);
    burst_send_capture(n, bits, elapsed);
    return true;
}

/* REFTX <pin> <delay_us> <channel> <mbps> <power> <N|P> <mac>: optional
 * reference transmitter. It drives the shared trigger line (both receivers
 * listen with TCAP ... S) and sends one 802.11 frame at <delay_us> from the
 * trigger edge (negative: the frame is queued first). The frame is the
 * reference signal in both snapshots. Addressed to another station, it makes
 * that station answer with an ACK one SIFS (10 us) after the frame, so a
 * reference and a target transmission share every snapshot.
 * <power> is in 0.25 dBm (8..84), <N|P> selects a null-data frame or a probe
 * request, <mac> FF:FF:FF:FF:FF:FF sends a broadcast (no ACK).
 * Replies REFTX <acked> <queued_us> <done_us>, times relative to the edge;
 * acked is 1 when the station acknowledged (always 1 for broadcasts) and
 * done_us is -1 when the driver reported nothing within 50 ms. */
static SemaphoreHandle_t reftx_sem;
static volatile int64_t reftx_done_at;
static volatile bool reftx_acked;
static int reftx_configured_rate = -1;

static void reftx_done(const esp_80211_tx_info_t *info) {
    reftx_done_at = esp_timer_get_time();
    reftx_acked = info->tx_status == WIFI_SEND_SUCCESS;
    xSemaphoreGive(reftx_sem);
}

static int reftx_rate(unsigned mbps) {
    switch (mbps) {
    case 1: return WIFI_PHY_RATE_1M_L;
    case 2: return WIFI_PHY_RATE_2M_S;
    case 5: return WIFI_PHY_RATE_5M_S;
    case 11: return WIFI_PHY_RATE_11M_S;
    case 6: return WIFI_PHY_RATE_6M;
    case 9: return WIFI_PHY_RATE_9M;
    case 12: return WIFI_PHY_RATE_12M;
    case 18: return WIFI_PHY_RATE_18M;
    case 24: return WIFI_PHY_RATE_24M;
    case 36: return WIFI_PHY_RATE_36M;
    case 48: return WIFI_PHY_RATE_48M;
    case 54: return WIFI_PHY_RATE_54M;
    default: return -1;
    }
}

/* The receiver runs Wi-Fi in NULL mode with the PHY forced to receive. Raw
 * frames need station mode, and the rate can only be set while Wi-Fi is
 * stopped; restarting it also re-initializes the PHY for transmitting. */
static bool reftx_setup(int rate) {
    if (reftx_configured_rate == rate) return true;
    if (!reftx_sem && !(reftx_sem = xSemaphoreCreateBinary())) return false;
    reftx_configured_rate = -1;
    (void)esp_wifi_stop();
    if (esp_wifi_set_mode(WIFI_MODE_STA) != ESP_OK ||
        esp_wifi_config_80211_tx_rate(WIFI_IF_STA, (wifi_phy_rate_t)rate) != ESP_OK || esp_wifi_start() != ESP_OK)
        return false;
    (void)esp_wifi_set_ps(WIFI_PS_NONE);
    if (esp_wifi_register_80211_tx_cb(reftx_done) != ESP_OK) return false;
    reftx_configured_rate = rate;
    return true;
}

static int reftx_frame(uint8_t *f, char type, const uint8_t *to) {
    uint8_t own[6];
    esp_wifi_get_mac(WIFI_IF_STA, own);
    memset(f, 0, 24);
    f[0] = type == 'P' ? 0x40 : 0x48; /* probe request : null data */
    memcpy(f + 4, to, 6);
    memcpy(f + 10, own, 6);
    memcpy(f + 16, to, 6);
    if (type != 'P') return 24;
    static const uint8_t body[] = {0x00, 0x00, /* wildcard SSID */
                                   0x01, 0x08, 0x82, 0x84, 0x8b, 0x96, 0x0c, 0x12, 0x18, 0x24};
    memcpy(f + 24, body, sizeof(body));
    return 24 + (int)sizeof(body);
}

static bool reftx_command(const char *line) {
    unsigned pin, channel, mbps, power, m[6];
    int delay;
    char type, extra;
    if (strncmp(line, "REFTX ", 6)) return false;
    if (sscanf(line, "REFTX %u %d %u %u %u %c %x:%x:%x:%x:%x:%x %c", &pin, &delay, &channel, &mbps, &power, &type,
               &m[0], &m[1], &m[2], &m[3], &m[4], &m[5], &extra) != 12 ||
        channel < 1 || channel > 13 || delay < -5000 || delay > 5000 || power < 8 || power > 84 ||
        (type != 'N' && type != 'P') || (m[0] | m[1] | m[2] | m[3] | m[4] | m[5]) > 255) {
        reply("ERR reftx_args\n");
        return true;
    }
    int rate = reftx_rate(mbps);
    if (rate < 0) {
        reply("ERR rate\n");
        return true;
    }
    if (!burst_gpio_trigger_pin(pin, true)) {
        reply("ERR trigger_pin\n");
        return true;
    }
    rx_ready = false; /* the next capture prepares the receiver again */
    if (!reftx_setup(rate)) {
        reply("ERR reftx_wifi\n");
        return true;
    }
    rx_lo_select(false);
    if (esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE) != ESP_OK ||
        esp_wifi_set_max_tx_power((int8_t)power) != ESP_OK) {
        reply("ERR reftx_wifi\n");
        return true;
    }
    uint8_t to[6], frame[40];
    for (unsigned j = 0; j < 6; j++) to[j] = (uint8_t)m[j];
    int len = reftx_frame(frame, type, to);
    (void)xSemaphoreTake(reftx_sem, 0);
    reftx_done_at = 0;
    const uint32_t mask = 1u << pin;
    int64_t edge, queued;
    esp_err_t err;
    if (delay >= 0) {
        edge = esp_timer_get_time();
        REG_WRITE(GPIO_OUT_W1TS_REG, mask);
        esp_rom_delay_us((uint32_t)delay);
        queued = esp_timer_get_time();
        err = esp_wifi_80211_tx(WIFI_IF_STA, frame, len, true);
    } else {
        /* The Wi-Fi task has the higher priority and hands the frame to the
         * MAC while this task waits. */
        queued = esp_timer_get_time();
        err = esp_wifi_80211_tx(WIFI_IF_STA, frame, len, true);
        esp_rom_delay_us((uint32_t)-delay);
        edge = esp_timer_get_time();
        REG_WRITE(GPIO_OUT_W1TS_REG, mask);
    }
    bool done = err == ESP_OK && xSemaphoreTake(reftx_sem, pdMS_TO_TICKS(50)) == pdTRUE;
    /* Hold the line until both receivers have certainly seen it. */
    int64_t hold = edge + 2000 - esp_timer_get_time();
    if (hold > 0) esp_rom_delay_us((uint32_t)hold);
    REG_WRITE(GPIO_OUT_W1TC_REG, mask);
    /* Release the line, so a receiver can drive it again without the
     * reference transmitter connected to the trigger. */
    (void)burst_gpio_trigger_pin(pin, false);
    if (err != ESP_OK) {
        char answer[40];
        snprintf(answer, sizeof(answer), "ERR reftx_send %d\n", (int)err);
        reply(answer);
        return true;
    }
    char answer[64];
    snprintf(answer, sizeof(answer), "REFTX %u %" PRId64 " %" PRId64 "\n", done && reftx_acked ? 1u : 0u,
             queued - edge, done ? reftx_done_at - edge : (int64_t)-1);
    reply(answer);
    return true;
}

#define BURST_ID       "C3SDR"
#define BURST_MAX_RATE 6
#include "burst_commands.h"

static void handle_command(char *line) {
    if (burst_version_command(line)) return;
    if (burst_gpio_command(line)) return;
    if (triggered_capture_command(line)) return;
    if (reftx_command(line)) return;
#ifdef RING_PROBE
    if (ring_probe_command(line)) return;
#endif
    if (spectrum_command(line, frequency_mhz, spectrum_acquire)) return;
    if (limits_command(line)) return;
    if (gain_command(line)) return;
    if (burst_common_command(line)) return;
    unsigned n;
    char extra;
    if (!strcmp(line, "CAPS")) {
        reply("CAPS VERSION GPIO SPEC SPECN SPECCAPS SPECSTAT DCT UARTBAUD RXLIMITS SERIALLEASE "
#if CONFIG_ESP_SDR_UART_ENABLED
              "DUALSERIAL "
#endif
              "TUNEEXT RX40 RX16 LPFANA GAIN HWAGC IQ8 TCAP REFTX\n");
    } else if (sscanf(line, "BANDWIDTH %u %c", &n, &extra) == 1 &&
               (!n || (n >= RX_BANDWIDTH_MIN && n <= RX_BANDWIDTH_MAX))) {
        rx_filter = rx_bandwidth_dcap(n);
        reply("OK\n");
    } else if (!strcmp(line, "LPF AUTO")) {
        rx_filter = -1;
        reply("OK\n");
    } else if (sscanf(line, "LPF %u %c", &n, &extra) == 1 && n <= 63) {
        rx_filter = n;
        reply("OK\n");
    } else if (!strcmp(line, "LPF?")) {
        char answer[80];
        snprintf(answer, sizeof(answer), "LPF %d %u %u\n", rx_filter, rom1_chip_i2c_readReg(0x67, 1, 4) & 63,
                 rom1_chip_i2c_readReg(0x67, 1, 5) & 63);
        reply(answer);
    } else
        reply("ERR command\n");
}

void app_main(void) {
    esp_log_level_set("*", ESP_LOG_NONE);
    esp_err_t e = nvs_flash_init();
    if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        e = nvs_flash_init();
    }
    ESP_ERROR_CHECK(e);
    usb_serial_jtag_driver_config_t usb = {.tx_buffer_size = 8192, .rx_buffer_size = 8192};
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&usb));
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_NULL));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous(true));
    ESP_ERROR_CHECK(esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE));
    prepare_rx();
    esp_log_level_set("*", ESP_LOG_NONE);
    /* USB may be unplugged when the host uses the UART bridge. */
    (void)usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(100));
    ESP_ERROR_CHECK(usb_serial_jtag_driver_uninstall());
    burst_serial_init();
    burst_serial_serve(handle_command);
}
