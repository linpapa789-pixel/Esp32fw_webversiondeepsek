# Pro Diag S3 – Mobile Motherboard Diagnostic Tool

ESP32-S3 based professional hardware diagnostic tool for mobile phone repair.

## Features
- UART RX Terminal (TX disabled for safety)
- I2C Safe Scanner (internal pull-ups disabled)
- Hardware Pulse Counter (PCNT) Frequency Meter
- ADC Voltage Meter (0-3.3V)
- PWM Generator (safety interlock)
- Logic Analyzer (BOOT, RESET, ENABLE)
- USB Monitor
- System Monitor (Heap, PSRAM, Temperature)

## Pinout (ESP32-S3)
| Pin | Function |
|-----|----------|
| 18  | UART RX  |
| 8   | I2C SDA  |
| 9   | I2C SCL  |
| 10  | PWM OUT  |
| 11  | Clock IN (Frequency) |
| 1   | ADC Voltage Input |
| 4   | BOOT monitor |
| 5   | RESET monitor |
| 6   | ENABLE monitor |
| 19  | USB D+ |
| 20  | USB D- |

## Build & Flash
1. Install PlatformIO.
2. Clone this repository.
3. Run `pio run` to build.
4. Flash firmware.bin using ESP32 Flash APK on Android.

## Android Flashing Instructions
- Use "ESP32 Flash Tool" or similar APK.
- Connect ESP32-S3 via OTG cable.
- Select firmware.bin and flash.
- After flashing, connect to WiFi "JCID_Diag_S3".
- Open browser at `192.168.4.1`.

## License
MIT
