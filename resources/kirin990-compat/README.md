# Kirin 990 ARM64 compatibility resources

These files are genuine ARM64 Ubuntu Bionic binary packages, extracted without executing their maintainer scripts. `sources.json` pins every library and copyright notice by SHA256, with its original package URL, package SHA256, name, version and license. Repository signatures and index identities are recorded in `metadata-verification.json`.

The five package hashes were checked against the official `bionic` and `bionic-updates` ARM64 indexes after verifying their InRelease signatures with the pinned Ubuntu archive signing key fingerprint `790BC7277767219C42C86F933B4FE6ACC0B21F32`. The verification record includes complete HTTPS source URLs, signed-index hashes, package hashes and ELF dependency checks. No Focal binary or locally rebuilt library is shipped.

The private set contains Mesa GBM 20.0.8 and its non-C-runtime dependencies: DRM, Wayland server, Expat and libffi. The native Electron runtime has 19 strong GBM imports; all are provided by this GBM. The string `gbm_bo_get_fd_for_plane` also occurs in Electron, but it is not a strong ELF import and must not be mistaken for a mandatory ABI requirement. These files require no GLIBC version newer than 2.25; the application already requires that baseline. They do not replace libc, libpthread, libm, libdl or the dynamic loader.

Only the dedicated test package copies these resources to `/opt/data-fusion/resources/compat/kirin990/`. Its reviewed launcher sets the library path and preload for that process tree and requests X11 software rendering. It keeps Chromium's sandbox enabled, refuses root execution and passes arguments/exit status through. No system library, GPU driver or desktop security configuration is changed.

The dedicated variant disables the generic ARM64 update feed, because a later generic installation would remove this compatibility launcher. Windows and ordinary Linux packages do not include these files through the normal packaging allowlist.

Rebuild after building/staging the normal ARM64 application:

```text
node scripts/stage-kirin990-compat.mjs <generated-deb-stage> resources/kirin990-compat/arm64 resources/kirin990-compat/sources.json
node scripts/verify-linux-package.mjs <generated-deb-stage>/opt/data-fusion arm64 --kirin990
python scripts/build-kylin-deb.py --arch arm64 --stage <generated-deb-stage> --compatibility kirin990
python scripts/verify-kylin-deb.py --package <test-package.deb> --stage <generated-deb-stage> --arch arm64 --version <version> --compatibility kirin990
```

Source files and notices are redistributed under their bundled upstream terms. Copyright files must remain alongside the libraries. This test package targets the observed vendor-GBM missing-symbol failure; actual Kirin 990 hardware must still confirm rendering and application behavior.
