# Jetson Nano Developer Kit (B01) — CAD references

NVIDIA's Jetson hardware design package (carrier-board mechanical drawings, schematics, and OrCAD source) ships from the developer download centre and requires an NVIDIA account, so it isn't bundled here.

## Canonical sources

- Product page: https://developer.nvidia.com/embedded/jetson-nano-developer-kit
- Hardware design files (Jetson Nano Developer Kit Carrier Board, B01): https://developer.nvidia.com/embedded/downloads — download `Jetson Nano Developer Kit Carrier Board Design Files (B01)`, an account-gated zip containing OrCAD schematics + Allegro PCB + mechanical PDFs.
- Module mechanical: https://developer.nvidia.com/embedded/dlc/jetson-nano-system-module-data-sheet (also account-gated).

When updating `src/library/boards/jetson-nano-b01.json`, pull the latest carrier mechanical PDF from that bundle and verify PCB outline + mounting holes. Cite the **product page URL** (which is stable) in the JSON `crossReference` field.

## License

NVIDIA design files are NVIDIA-proprietary; redistribution is restricted. Do not commit the downloaded zip into this repo — keep it local for cross-checking only.
