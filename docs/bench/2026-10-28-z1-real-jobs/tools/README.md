# The v2 demo-jobs pipeline (2026-10-28)

These are the scripts that built the 2026-10-28 real-jobs run and its page. They were kept here because the scratchpad they ran from is wiped on reboot.

- `jobs2.py` builds the job files in `../jobs/` from the sources.
- `run.sh` and `render-all2.sh` run each job through `casemaker cut` on a clone of main.
- `render.py` is the independent height-field sweep. Balls and drills are drawn at their cutting size, which v1 got wrong.
- `make-male.mts` derives an inlay male plug.
- `meshgen.py` handles the relief inputs.
- `cards.py`, `gen_page.py`, `page-head.html` and `summ.py` build the page and its summary.

They were written for a one-off run, so paths inside them point at the scratchpad they ran from (`.../scratchpad/real/`). Set those to a working folder before re-running. The house location file the runs used (`location.json`) is not committed. Use the location export from the machine you run on.

The downloaded inputs (wolf model, portrait, Vader outline) are not committed. `../README.md` gives each one's URL and licence.
