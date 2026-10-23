# SPRD-Uboot-Patcher

One-shot full patch for UNISOC/Spreadtrum **SL8541E**-class watches
(same device family as the uboot-usblog / unlock-auto projects).

Three functions in one run:

| # | function | what it does |
|---|----------|--------------|
| 1 | unlock   | splloader secure-boot check disabled (`bl #0x6740 -> b #0x55dc`); uboot lock gate -> NOP x3; trustos both AVB returns -> `mov w0,#0` |
| 2 | usblog   | injects the live USB-console patch into the uboot image (same design as uboot-usblog 0.0.1) |
| 3 | banner   | replaces the two u-boot banners (default: the Dunoguang set) |

All three are state-aware and idempotent:

| state | detection | action |
|-------|-----------|--------|
| already unlocked | patched forms recognised (`b #0x55dc` / NOP gate / `mov w0,#0`) | kept |
| already injected | gate shows `mov w19,#0` + `b +0x38` | kept |
| banner factory / dunoguang / modified | text compare | replaced only when needed |

**Banners stay re-editable.**  The two slots are located by stable
neighbours (`info failed!...` .. `pass_chip_uid_to_tos` for warn;
`charger` - 36 bytes for info), not by their text, so a third-party
rewrite can always be replaced, and the result can be edited again any
number of times.

## vp19 extension (2026-10-23)

When the input is a vp19-class image (all five vp19 templates land and
`puts` still carries its original prologue) the toolchain switches to a wider
injection layout that adds three things on top of the classic usblog patch:

| function | what it does | hooked at |
|---|---|---|
| screenlog | mirrors the console onto the panel (`lcd_puts` then `lcd_refresh`) | `puts` entry |
| earlylcd | brings the panel up before mode detection, so the whole boot log is visible | `do_cboot` entry |
| nopusboff | nops the `usb_phy_power_off()` call in `vlx_entry`, keeping u2s alive across the hand-off | `vlx_entry` |

The code lives in the same `fb_cmd_flashing` dead zone (676 usable bytes):

    +0x00 gate(4)  +0x04 screenlog(48)  +0x34 earlylcd(60)
    +0x70 hook(52) +0xA4 pump(60)       +0xE0 emit(156)

screenlog is gated on `lcd_is_enabled`, so it is silent until
`drv_lcd_init()` has probed the panel, and `lcd_refresh()` is only issued
after a successful probe (it prints through `printf` otherwise, which would
recurse into the hook).

### kick works again

The shipped usblog patch rewrote the success path of `usb_wait_config()`:

    0x1a720  350001c0 cbnz w0,+0x38   ->  1400000e b   +0x38
    0x1a764  52800033 mov  w19,#1     ->  52800013 mov w19,#0

`pctool_mode_detect()` short-circuits on `usb_wait_config() == 0`, so
`usb_read_data()` never ran and the 10-byte u2s kick frame was never parsed:
SPRD4 / calibration mode could not be entered from the PC tool any more.
The vp19 path leaves those three instructions byte-identical to the factory
(`0x1a720 / 0x1a764 / 0x1a768`), and gates the u2s mirror on the gadget's own
port-ready flag (`0x9F1CC190`) instead of a software gate.

New switches: `--no-screenlog` (also disables the vp19 path),
`--no-earlylcd`, `--no-nopusboff`.

## Usage

    patcher.py <splloader> <uboot> <trustos> [--outdir DIR]
               [--warn TEXT] [--info TEXT] [--verbose]
               [--no-unlock] [--no-usblog] [--no-banner]
               [--no-screenlog] [--no-earlylcd] [--no-nopusboff]

writes (default dir = the uboot directory + `/patched/`):

    splloader-no-secure-boot.img
    uboot-unlock-bootloader-usblog.img
    trustos-no-avb.img

Default banner texts (the Dunoguang set):

    warn : QQ:3981750101 / Boot Format OK, Kernel Started...   (48 bytes)
    info : SPRD U-Boot - Patch By Dunoguang                    (35 bytes)

In --warn / --info a literal backslash-n becomes a newline; oversized
text is rejected before anything is written.  `--verbose` turns on the
full anchor-location / injection logs.

## gzip kernel (`web/gzip.js`)

Adds a boot-time gunzip stage to an uboot image.  Four anchors are
located independently, so nothing is tied to one build:

| anchor | how it is found |
|---|---|
| call | `bl` to the kernel read inside `_boot_load_kernel_ramdisk_image`, must sit within 0x2000 of the jump |
| jump | the only `movz x4,#0x8008,lsl16` + `blr x4` pair |
| gunzip | the `Error: Bad gzipped data` and `Error: gunzip out of data in header` string pair, both resolving into one function |
| container | an unused function body after a `ret`, no external branch, smallest address |

At boot the hook peeks the first bytes of the kernel segment: `1f 8b 08`
stages the stream at `0x83800000` and inflates it to `0x80000000`; anything
else is read straight to `0x80000000 + text_offset`, so a 4.4 kernel still
lands at `0x80080000`.  The resolved address goes into a literal that
`vlx_entry` loads immediately before `blr x4`.

The module is state-aware: an already-patched image is recognised by the
`ldr x4,[jv]` + `blr x4` pair and left untouched.

## Web version (`web/`)

A fully client-side port of the same toolchain -- open `web/index.html`
in any modern browser (double-click is fine: no server, no CDN, no
external references; the files never leave the machine):

- drop in any subset of the three images (uboot alone works),
- each file is analysed on the spot (lock / banner / usblog states for
  uboot, secure-boot / AVB states for the others),
- tick the functions you want (all three are on by default) and press
  the button; the optional `gzip kernel` stage can be added on top,
- download the results; every product shows its md5 next to the button,
- switch the whole interface between 中文 / English / Português from the
  top-right corner (the choice is remembered).

The browser core (`web/core.js` + `web/tpl.js`) is a line-by-line port
of the python engines and was verified byte-exact: `node web/test_node.js`
re-runs the same four-case matrix as `tests/run_cases.py` (m9u full run,
ai3 two-step, dw99 YC image, idempotent re-run) and must print
`regress: PASS`.

Interface strings live in `web/i18n.js` (zh / en / pt, 57 keys each);
`node web/check_i18n.js` verifies that every key used by the HTML and
the UI code exists in all three languages and that the dictionaries
stay in sync (must print `I18N CHECK PASSED`).

The gzip module is covered by `node web/test_gzip_node.js` (anchor location,
build and verify on five images), `node web/test_detect.js` (clean / injected
recognition), `node web/test_ui_flow.js` (full browser flow) and
`node web/test_screenlog_gzip.js` (screenlog + gzip coexistence, kick bytes
untouched).  `node tests/make_vp19_full.js <in.bin> <out.img>` runs the whole
chain headless and writes the finished image.

## Test matrix (2026-10-02, all green)

| case | input | result |
|------|-------|--------|
| m9u original | protected / factory / clean | full run -> uboot `1380040a…` (byte-identical to the hand-made 3-in-1) |
| ai3 two-step | unlocked + dunoguang + clean | inject only -> uboot `21d7b220…` (byte-identical to the hand-made 3-in-1) |
| idempotent | m9u product | all kept, 0 bytes changed, md5 unchanged |
| dw99 | YC unlock + YC banner | lock kept, banner modified -> replaced, inject -> `60b245aa…` |
| vp19 (2026-10-23) | factory spl/uboot/trustos | full run -> uboot `29d23165…` (unlock + banners + usblog + screenlog + earlylcd + nopusboff, kick path untouched) |

`python3 tests/run_cases.py` re-runs the matrix (byte-exact where known).

## Architecture

    patcher.py              CLI entry
    lib/banners.py          robust banner access (neighbour anchors + states)
    lib/unlockauto/         the unlock engine (splloader / uboot / trustos)
    lib/usblogauto/         the usblog injection engine (+ detect() probe)
    lib/usblogauto/vp19.py  the vp19 layout: screenlog + earlylcd + nopusboff
    lib/profiles/           masked word templates used by the usblog finder

The two engines are drop-in copies of the standalone projects; the only
addition is the injection-aware `detect()` probe in
`lib/usblogauto/finder.py`.

## Provenance

Built on unlock-auto and usblog-auto (which itself pins the four legacy
uboot-usblog generators byte-exactly).  Pure python, no dependencies.
