#pragma once
#include <stdbool.h>

/* Initialize once after the radio and transports have claimed their pins. */
void burst_gpio_init(void);
/* Dispatch after the receiver's serial ownership check, between captures. */
bool burst_gpio_command(const char *line);
/* Claim an available pin as the shared capture trigger line. drive=true:
 * output, initially low, with the input path enabled so the driver can read
 * back its own line; drive=false: input with pulldown. Returns false for pins
 * that GPIO? does not list. GPIO <pin> Z releases the pin again. */
bool burst_gpio_trigger_pin(unsigned pin, bool drive);
