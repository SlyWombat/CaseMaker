# Desktop CNC — competitor & market research

**Status: first pass complete 2026-10-04; second pass in progress the same day (PDF re-extraction with MegaPDF). Fact-gathering only — no application code changes.**

> **Tracking issue: [#228](https://github.com/SlyWombat/CaseMaker/issues/228)** — the
> findings, what they imply for the machine-profile abstraction (#184), and the second-pass
> list still owed.

## Why this exists

Case Maker's machining side today targets a single Makera Z1, and `/Makera-Parity.md` is the
benchmark for that one vendor's software. The plan is to eventually support *other* desktop
CNC machines, so we need the capability surface of the machines — and above all of the
**software that models the part and drives the hardware** — across the rest of the field.

This directory gathers the raw evidence (vendor marketing + user documentation, saved
locally) and the synthesis documents built from it — `FEATURE-MATRIX.md`, `UI-PATTERNS.md`
and the source index `SOURCES.md`. The directory is **gitignored** (it holds third-party
copyrighted material; see below) except for the four summaries — this README,
`FEATURE-MATRIX.md`, `UI-PATTERNS.md` and `SOURCES.md` — which were committed on 2026-10-09
when the study closed (#228). Links from them into `raw/` or `extracted/` resolve only on a
machine that holds the local copies.

## Deliverables

| File | What it is |
|---|---|
| `FEATURE-MATRIX.md` | Hardware + software capability matrix, one column per vendor/software |
| `UI-PATTERNS.md` | **10 user-interface things competitors do better**, each with a saved sample and a source |
| `notes/<vendor>.md` | Per-vendor raw notes produced during gathering |
| `raw/<vendor>/` | Local copies of manuals (PDF), marketing/support pages (HTML), and UI screenshots (PNG) |
| `extracted/<vendor>/` | Every PDF in `raw/`, converted to Markdown (markup) + page-anchored plain text with `megapdf-cli` |
| `SOURCES.md` | Master index of every source URL with access date and what it proves |
| `tools/fetch.mjs` | Playwright page fetcher (screenshot + HTML + text), used for JS/blocked pages |

## Method & provenance

Inherited from `/Makera-Parity.md` §1 and `/Fabrication.md` §1:

- **Every claim carries a source URL and an access date.** Facts that could not be
  verified against vendor documentation are marked **NOT FOUND**, never guessed.
- **Marketing claims and documentation facts are distinguished.** "One-click setup" from a
  landing page is a claim; the same feature described in a manual with a screenshot is
  evidence. Both are recorded, labelled.
- **Screenshots are the samples.** Where a UI feature is claimed, a saved screenshot (or a
  verbatim quote from the manual) is the evidence, not a paraphrase.
- **Machine specs** (work envelope, spindle, ATC, axes) come from vendor spec pages or
  manuals, not from reseller listings, unless the listing is the only source — and then it
  is marked as such.

## Licensing / copyright

The `raw/` tree contains **third-party vendor documents and images**, downloaded for
internal engineering research (feature comparison and UX study). They are:

- **not redistributed, not committed** — the whole directory is in `.gitignore`;
- **not to be copied into the app or its repo** — same rule as `/Makera-Parity.md` §11.1 for
  Makera's GPL/all-rights-reserved repos. Facts and interoperability information may be
  reimplemented; files, code, marketing copy and screenshots may not be shipped.
- vendor names and product names are the property of their owners; this is nominative use.

The `.gitignore` rule that does this (the per-vendor `notes/` are *not* whitelisted — they
quote the manuals at length):

```
docs/market-research/**
!docs/market-research/README.md
!docs/market-research/FEATURE-MATRIX.md
!docs/market-research/UI-PATTERNS.md
!docs/market-research/SOURCES.md
!docs/market-research/notes/
!docs/market-research/notes/**
```

## Relationship to existing docs

- `/Makera-Parity.md` — capability inventory of **Makera Studio** (the incumbent) and the
  gap list `/Fabrication.md` plans against. It is the "Makera" column here.
- `/Fabrication.md` — the plan for the CNC side generally; §1 machine profiles.
- `/Simulation.md` — toolpath simulation design (the feature most competitors are judged on here).
- `../makera/` — the one Makera/Carvera PDF already held in the repo.
- `raw/makera/` — **the incumbent's own software documentation**, captured here so the two
  Makera products (Studio, and CAM Beta v0.2.0 for Carvera only) can be cited the same way
  as every competitor. Its synthesis lives in the repo-root docs above, not in `notes/`,
  so there is no `notes/makera.md`.

## Fetching pages (JS-heavy or bot-blocked sites)

```
node tools/fetch.mjs <url> <outBaseWithoutExt> [both|shot|html|text]
# writes <outBase>.png (full page), .html, .txt
```

Playwright 1.61.0 (pinned; see `/casemaker-app`) + chromium. Sites behind Cloudflare bot
challenges (e.g. `stepcraft-systems.com`) still fail; the fallback is `web.archive.org` via
`curl` or an alternate regional/mirror site, or a **NOT FOUND** entry.

Vendor **PDF manuals** are the richer evidence where they exist, and they are read with
**MegaPDF's own command-line extractor** — the tool of record since 2026-10-04, replacing the
`pypdf` venv the first pass used:

```
# one-time — the released binary (2.2.1, linux-x64); no root, installs into ~/.local
gh release download linux-v2.2.1 -R SlyWombat/MegaPDF -p 'megapdf-linux-x64-*.tar.gz*'
sha256sum -c megapdf-linux-x64-2.2.1.tar.gz.sha256
tar xzf megapdf-linux-x64-2.2.1.tar.gz && cd megapdf-linux-x64-2.2.1 && ./install.sh
# ...now `megapdf-cli` is on PATH via ~/.local/bin

# every manual, two ways: Markdown (markup) and page-anchored plain text
megapdf-cli extract manual.pdf --format md  --page-marker --out manual.md
megapdf-cli extract manual.pdf --format txt --page-marker --out manual.txt
```

(Or build from source instead of the release: `.NET 8 SDK, cmake, ninja, g++` in WSL, then
`git clone … && tools/fetch-pdfium-linux.sh`, `cmake -S core -B core/build/linux-x64
-DCMAKE_BUILD_TYPE=Release -G Ninja`, `cmake --build core/build/linux-x64 --target
megapdf_cli`.)

Outputs land in `extracted/<vendor>/` (gitignored with the rest of this directory). Both
formats carry a page anchor — `<!-- page N -->` in the `.md`, `--- page N ---` in the `.txt` —
so a quote can be cited by the page the manual itself prints. MegaPDF's engine reads the text layer of every manual in `raw/` except
the two truncated Stepcraft files (see `SOURCES.md`), and it **infers structure** for the
Markdown — headings, lists, bold — which is what makes the `.md` a better reading surface
than the flat text. Two caveats it reports itself: pages with no text layer are named on
stderr (`MegaPDF does not do OCR`), and — as of 2.2.1 — **symbol-font bullets are recognised
as list items** (this was MegaPDF #664, filed from this work and fixed in `linux-v2.2.1`;
re-extraction took the corpus from **938** stray `l `/`•` markers to **61**, the residue
filed as MegaPDF #669). The two truncated Stepcraft files now fail with the explicit
**exit 10** ("the file looks incomplete…", #665) rather than a vague "not a valid PDF".

`pdftotext` is not installed; the distro Python is uv-managed (PEP 668), which is why the
first pass needed the venv at all. A naive FlateDecode + regex extractor is **not** enough —
manuals embed subset fonts whose text is glyph indices, not ASCII.
