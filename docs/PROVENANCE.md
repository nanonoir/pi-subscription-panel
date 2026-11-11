# Origins and distribution status

Pi Subscription Panel is an independent derivative of
[Alexmarco's pi-subscription-limits](https://github.com/alexmarco/pi-subscription-limits).
The copied package identifies its baseline as version **1.0.2**. The precise copied
upstream commit has not been independently verified; version metadata is not a commit id.

## Permission record

The project owner confirmed that the original author gave permission, held
privately by the owner, to use the upstream work under the MIT License. The
permission evidence is not published in this repository. The upstream copy supplied
no license file; the MIT text in [LICENSE](../LICENSE) was written for this project
and is not text supplied by the original author. The owner authorized public release:
Git now, npm later. The original author asked only for thanks and a link to the
upstream repository, which close the README.

## Preserved attribution

- README ends with an acknowledgement naming and linking Alexmarco and the original
  repository.
- `LICENSE` credits nanonoir for this project's contributions and preserves any
  copyright of the upstream author in derived portions; no other copyright holders
  are asserted.
- `docs/UPSTREAM_CHANGELOG.md` retains the original release entries and links;
  the root `CHANGELOG.md` tracks only this project's changes.
- Existing extension source and tests are retained without behavioral changes in Phase 1.

## Distribution status

- The independent repository is
  [nanonoir/pi-subscription-panel](https://github.com/nanonoir/pi-subscription-panel);
  package repository, homepage, and issue URLs point to it.
- Version 1.0.0 is prepared locally under MIT. Git publication is authorized; the
  commit, push, and tag still require the owner's execution step.
- npm publication is authorized for later but not yet performed: `private: true`
  stays until the owner explicitly requests it, and the final npm name availability
  must be checked then. Dependency audit findings in `docs/DEVELOPMENT.md` remain
  open items for that step.
- This project's version line (1.0.0) is independent from upstream's 1.0.2 baseline.
