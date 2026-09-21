# WeChat Linux build-profile maintenance

This toolkit is for authorized maintenance of the user's own WeChat installation. It is not shipped in the runtime image. Build profiles are specific to the ELF BuildID and architecture, not just the displayed version.

## Keep three different values separate

- Account image AES material (`_image_aes`): secret account data, currently represented by a 32-character string. The image decoder uses the required bytes of this string; do not assume hex-decoding it is equivalent.
- `image_xor_mask`: a 32-byte build-specific constant used to obscure the account material in memory. This is the value committed to a build profile.
- Image-file tail XOR key: a separate single-byte value used by the image file format. Recovering it does not recover the memory mask.

Database passphrases and SQLCipher keys are another independent path. Successfully recovering image material does not prove database access works.

## Evidence required before committing a profile

1. Record the target ELF's full BuildID, architecture, package version, and package checksum. In a sidecar, inspect `/proc/<pid>/root/opt/wechat/wechat`, not the sidecar's own executable.
2. Validate the known account AES material against a current encrypted image before using it as a bridge. An old account key is not automatically valid for every installation.
3. Record how the candidate mask is constructed: contiguous ELF constants, or instruction immediates with their destination order.
4. Verify the complete 32-byte relation `obfuscated = account_material XOR mask` in live memory. An 8-byte prefix hit alone is not proof.
5. Run the production `extract_image_aes_key` implementation using the candidate profile. It must recover the expected material independently, rather than simply reading the supplied key file.
6. Decrypt an actual image with the recovered material. Header recognition is preliminary evidence; full decoding is stronger. Preserve only sanitized counts and format results in review notes.
7. Check chat enumeration and target selection, database access, and the final image separately. Mask verification alone is not release acceptance.

## Route A: known-key bridge against contiguous constants

`bridge-image-mask.py` searches every byte position in writable process mappings, in bounded chunks with overlap. It compares candidate masks against all 16-byte-aligned halves in the ELF, without entropy-based pruning. It requires NumPy.

```bash
python3 scripts/wechat-extract/bridge-image-mask.py \
  --binary /proc/1234/root/opt/wechat/wechat \
  --pid 1234 \
  --aes-file /secure/account-image-aes.txt
```

Replace the example PID and paths with the live target. Keep the key file mode `0600`, owned by the operator; never put its contents in the command line, chat, logs, or git.

A failure means **no match under this model in the memory actually read**. It does not establish that the key is absent. Read failures, transient values, different storage processes, split constants, and different transformations must be considered. Do not repeatedly scan the same state without a new hypothesis.

## Route B: instruction reconstruction on AMD64

The Linux 4.1.13.23 AMD64 build demonstrates why Route A is not universal. Its mask is assembled using four `movabs imm64` instructions and stores into adjacent stack slots. Instruction bytes separate the constants, so neither complete 16-byte half exists anywhere in the ELF. Searching all alignments does not fix that assumption.

A bounded reconstruction tool, `recover-image-mask.py`, accompanies this guide. Consult its `--help` for the exact invocation. It uses Capstone to inspect a caller-specified ELF virtual-address range and reconstruct candidate constants from adjacent stack stores; optionally it checks candidates against live memory using a protected known-key file. Static candidates are not automatically verified masks. The tool does not automatically identify homologous functions in an arbitrary new build.

For the exact AMD64 build documented below, this bounded range covers the four loads and stores:

```bash
python3 scripts/wechat-extract/recover-image-mask.py \
  --binary /proc/1234/root/opt/wechat/wechat \
  --start 0x619574e --size 0x3b \
  --pid 1234 --aes-file /secure/account-image-aes.txt
```

The start is an ELF virtual address at an instruction boundary, not an ASLR address. Static JSON `ok` only means candidates were found; require the candidate's `verification` to be `verified` for live evidence. Inspect read-failure and budget fields before interpreting a negative result. The current recognizer accepts compact `movabs`, direct 8-byte stack stores, and NOP sequences; other instructions conservatively reset tracking. It is intentionally not a general symbolic executor.

For future builds:

1. Locate references to the known mask in a supported architecture/build.
2. Inspect the surrounding function and callers. Identify stable strings or log anchors; encrypted log byte sequences can also be useful across these two architecture builds, but are not guaranteed stable.
3. Find corresponding anchors and references in the new binary.
4. Disassemble from a confirmed instruction boundary. Track constant writes, stack slot order, overwrites, and the XOR data flow rather than concatenating nearby bytes.
5. Reconstruct each 64-bit immediate in **little-endian memory order**.
6. Apply the complete live-memory and production-extractor checks above.

ELF virtual addresses, file offsets, and ASLR runtime addresses are different. Translate file locations through ELF `PT_LOAD` segments; do not assume a fixed subtraction will work for another executable. Runtime hooks additionally require the load bias.

## Worked case: Linux 4.1.13.23

`builds-4.1.13.23.json` records public package/ELF sizes, SHA256 values, full BuildIDs, and recovery coordinates. It is research provenance, not the release-input manifest. Public package backups belong in ignored `docker/cache/wechat-4.1.13.23/`; verify their hashes against this record before use. An ignored local cache is not a durable shared archive: release preparation still requires the project's approved immutable download source. Do not trust older `/tmp` copies; truncated AMD64 downloads were found during cleanup.

### ARM64: `e9f1cd04`

The previous maintenance session recovered:

`ed5cfabf2d917d8126870f3102b9207d77227ac7a8127092bdbed6bc40823e77`

Both halves were 16-byte-aligned ELF constants. Known-key bridging found a match, followed by live production extraction and image-header validation. Subsequent disassembly showed loads of the two vector constants and `eor` operations around ELF virtual address `0x602c1b0`.

### AMD64: `ce28c3471d532eeb1f136482eeb4d0bdfd59c06e`

Recovered mask:

`4e9379223c6eeed2ae11ed50510d0e153929e23541a7288ac021a10e6d4b4655`

The initializer near ELF virtual address `0x6195600` constructs it from:

- `0x619574e`: immediate `0xd2ee6e3c2279934e`, stored at stack offset `+0`.
- `0x619575c`: immediate `0x150e0d5150ed11ae`, stored at `+8`.
- `0x619576b`: immediate `0x8a28a74135e22939`, stored at `+16`.
- `0x619577a`: immediate `0x55464b6d0ea121c0`, stored at `+24`.

A getter reconstructs the same words starting near `0x619af3d`, providing a second static cross-check. These addresses are evidence for this exact build only.

The complete mixed value matched once in the live main process. The production extractor independently recovered the known account material. Existing encrypted image samples had already validated that material through JPEG/PNG headers. After installing the profile, `verify-profile.py` reported `imageExtractOk`, `listOk`, and `selectFilehelperOk` as true. This does not constitute full image decoding or full multi-platform release acceptance.

## GUI and instrumentation lessons

- Run Xvfb and WeChat with compatible ownership for MIT-SHM; missing image pixels can be a display-permission problem.
- Inspect current screenshots and window properties before clicking. A visible `_NET_WM_STATE_MODAL` window blocks its parent. Read the dialog and use its normal cancel/confirm action; do not blindly dismiss it.
- Re-read row positions after incoming messages reorder the list. Model indices are not screenshot coordinates.
- Confirm the target with `chat-select.py --verify-only filehelper`. An already-active result proves identity, not that a new selection transition was exercised.
- A thread waiting in `poll` or `futex` is not by itself proof of deadlock.
- Never call Qt UI methods from an arbitrary Frida thread. Prefer ordinary UI actions with bounded observational hooks that detach on timeout.
- Use full-size image viewing to exercise decoding, but do not infer that a particular key representation must remain in the main heap afterward.
- Preserve the user's session. Do not restart repeatedly or request repeated scans/uploads without evidence that they are necessary.

## Upgrade acceptance gate

Finding build constants is necessary but insufficient to change the release pin. Test the final candidate image on native AMD64 and ARM64, not only a manually assembled extraction container. Record each item as passed, failed, or untested with its image digest and BuildID:

- Fresh login QR/phone confirmation, restart behavior, and normal desktop responsiveness.
- Automatic DB-key extraction without pre-seeded `/tmp/wechat-passphrase.bin` or a manually running maintenance hook. Verify real contact, session, and message queries, not only page HMACs.
- Switch from a different chat into `filehelper`; an already-active/skipped result is not a transition test.
- Send and read back a test text in an authorized test conversation.
- Receive/send an image and fully decode it. JPEG/PNG header recognition alone is not full decoding.
- Exercise the currently supported file, voice, video, quoted/forwarded-message paths and relevant existing-version regressions.
- Validate immutable package URLs/checksums and the complete release-inputs/instruction-allowlist chain, run runtime and maintenance tests, and build both image architectures.

At the end of the mask-recovery session, image-key extraction and active filehelper identity were verified on AMD64. Full candidate-image acceptance, automatic fresh-install DB extraction, and the complete messaging/media matrix were **not** established. Do not turn these untested items into release claims.

## Verification and tests

`verify-profile.py` requires image extraction, enumeration, and successful target selection/state verification by default. `--skip-select` explicitly narrows that check; it is not full acceptance.

```bash
python3 scripts/wechat-extract/test_wechat_extract.py
python3 scripts/wechat-extract/test_recover_image_mask.py
python3 docker/tools/test_extract_keys.py
python3 docker/tools/test_capture_passphrase.py
python3 docker/tools/test_chat_select.py
bash scripts/test-entrypoint-xvfb-user.sh
```

Install NumPy and Capstone in a maintenance virtual environment and check that dependency-dependent tests actually run rather than skip. Keep new tests synthetic: cover constant ordering, overwritten registers, unrelated stores, ELF address translation, chunk boundaries, no-match cases, and secret-free output.

Only public build constants and sanitized evidence belong in git. Never commit account keys, database passphrases, decrypted messages, screenshots, process dumps, or complete private filesystem paths. Temporary cloud instances must retain their expiry policy and be terminated after extraction and necessary validation are complete.
