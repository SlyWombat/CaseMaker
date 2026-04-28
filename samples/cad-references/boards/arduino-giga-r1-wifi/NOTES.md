# Arduino GIGA R1 WiFi — CAD references

## Bundled here

- `ABX00063-datasheet.pdf` — official datasheet including mounting holes + board outline (page 18 mechanical view).
- `ABX00063-pinout.pdf` — full pinout reference (top view).

## Canonical sources

- Product page: https://docs.arduino.cc/hardware/giga-r1-wifi
- Datasheet: https://docs.arduino.cc/resources/datasheets/ABX00063-datasheet.pdf
- Pinout: https://content.arduino.cc/assets/ABX00063-full-pinout.pdf

## Use

These two PDFs are the source of truth used to fix the GIGA + DMX template regression in issue #35. The mechanical view confirms PCB outline 101.6 × 53.34 mm and the four corner mounting holes; the pinout confirms the connector list (USB-C, USB-A, 3.5 mm audio jack, micro UFL antenna, MIPI camera + DSI display, microSD — and notably **no** USB-B and **no** DC barrel jack).

## License

Arduino hardware design files are CC-BY-SA. The bundled PDFs are linked from Arduino for technical reference.
