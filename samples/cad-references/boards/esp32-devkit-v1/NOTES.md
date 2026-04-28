# ESP32 DevKit V1 (DOIT 30-pin) — CAD references

## Bundled here (`from-syauqibilfaqih/`)

Community-maintained KiCad library for the DOIT ESP32 DevKit V1 30-pin board, originally by BlackCoffee on the KiCad forum, fixed by syauqibilfaqih:

- `esp32_30pin_revised.kicad_sym` — KiCad symbol library.
- `ESP32_Footprints.pretty/` — KiCad footprint(s).
- `LICENSE` — MIT license from the upstream repo.
- `README.md` — upstream notes (incl. the pin-spacing fix history).

## Canonical sources

- Repo: https://github.com/syauqibilfaqih/ESP32-DevKit-V1-DOIT
- Espressif official ESP32-DEVKITC (30-pin variant): https://docs.espressif.com/projects/esp-idf/en/stable/esp32/hw-reference/esp32/get-started-devkitc.html

## Notes

The DOIT board is a clone family — different manufacturers swap pin order or use different USB connectors. **Verify against the physical board before trusting any single library.** Use the bundled KiCad lib to confirm pin pitch (2.54 mm) and overall PCB outline (~50.5 × 27.9 mm), then cross-check connector positions against vendor photos.

## License

MIT (upstream).
