# The APT repository's signing key

`FINGERPRINT` is the one committed fact about the key that signs Case Maker's APT repository. Its
public half is not committed: `tools/linux/make-apt-repo.sh` exports `casemaker.gpg` and
`casemaker.asc` from the signing key at build time, so there is no second copy to drift.

**This file does not exist yet** — the maintainer creates the key and commits the fingerprint
first; until then `make-apt-repo.sh` refuses with that instruction, and the Linux release workflow
skips the repository (it has no `APT_SIGNING_KEY`). The recipe is in
`tools/linux/Linux-Packaging.md`, "The signing key".

Do not create a key here, and do not paste a private key into the repository.
