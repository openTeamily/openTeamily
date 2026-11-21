# docs/inventory

`visible-controls.json` is a **derived artifact**: it is generated from the checked-in
source pages by `scripts/visible_inventory.py`.

- The `management` CI job rebuilds it from the merge tree before running the Python
  suite, so a stale snapshot can never turn that job red. Drift is still surfaced as a
  non-blocking workflow warning on the file.
- The committed file is a **review snapshot, not the source of truth**. It is
  re-generated on the release step / at a fixed cadence, not inside every pull request:
  re-generating it per PR made every open PR collide on the same file.
- `tests/test_visible_inventory.py` still asserts that disabled controls stay recorded
  as unverified. That assertion is unchanged and still blocking.
