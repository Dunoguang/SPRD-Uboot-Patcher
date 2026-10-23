"""vp19 extension: kick-safe usblog plus on-screen console.

Compared with the shipped usblog patch this one

  * leaves usb_wait_config() untouched, so the u2s kick frame is still read
    (the shipped patch forced mov w19,#0 and broke SPRD4 / calibration mode)
  * mirrors the console onto the panel (screenlog)
  * brings the panel up before mode detection (earlylcd)
  * keeps USB powered across the kernel hand-off (nopusboff)

Layout inside the fb_cmd_flashing dead zone (676 usable bytes):

    +0x00  gate byte (re-entrancy lock for the sender)
    +0x04  screenlog   44 B
    +0x30  earlylcd    60 B
    +0x6C  puts_hook   52 B
    +0xA0  pump        60 B
    +0xDC  emit       156 B
"""
import json
import os
import struct

from . import aarch64 as A
from . import finder as F

BASE = 0x9EFFFE00
DEAD_SIZE = 0x2A4

LAYOUT_V2 = [
    ('FLAG', 0x00),
    ('SLOCK', 0x01),
    ('SCREENLOG', 0x04),
    ('EARLYLCD', 0x64),
    ('HOOK', 0xA0),
    ('PUMP', 0xD4),
    ('EMIT', 0x110),
    ('DEAD_END', DEAD_SIZE),
]

NOP = 0xD503201F


def va(off):
    return off + BASE


def load_lcd_templates(path=None):
    here = os.path.dirname(os.path.abspath(__file__))
    if path is None:
        path = os.path.join(here, os.pardir, 'profiles', 'templates_vp19_lcd.json')
    with open(path) as f:
        return json.load(f)


def pick(d, blk, frac_min=0.99):
    for c in F.template_candidates(d, blk, topn=8):
        if c['frac'] >= frac_min:
            return c
    raise F.FindError('template %s not found (frac>=%.2f)' % (blk.get('off'), frac_min))


def locate_lcd(d, log=print):
    """locate the panel helpers and the two hook targets"""
    t = load_lcd_templates()
    res = {}
    for name, key in (('LCD_INIT', 'lcd_init'), ('LCD_PUTS', 'lcd_puts'),
                      ('LCD_REFRESH', 'lcd_refresh'), ('DO_CBOOT', 'do_cboot')):
        c = pick(d, t['blocks'][key])
        res[name] = c['off']
        log('  %-10s file %#08x (frac %.0f%%)' % (name, c['off'], 100 * c['frac']))
    c = pick(d, t['blocks']['vlx_entry'])
    res['VLX_ENTRY'] = c['off']
    res['USB_OFF_CALL'] = c['off'] + 4
    if (A.w(d, res['USB_OFF_CALL']) >> 26) != 0x25:
        raise F.FindError('USB_OFF_CALL %#x is not a bl' % res['USB_OFF_CALL'])
    log('  %-10s file %#08x (frac %.0f%%)  usb_off call %#08x -> %#08x'
        % ('VLX_ENTRY', c['off'], 100 * c['frac'], res['USB_OFF_CALL'],
           A.bl_target(d, res['USB_OFF_CALL'], BASE)))
    # lcd_is_enabled: adrp+ldrb inside lcd_puts (the only gate read there)
    off = res['LCD_PUTS']
    lcd_en = None
    for k in range(0, 0x28, 4):
        w1 = A.w(d, off + k)
        if (w1 & 0x9F000000) != 0x90000000:
            continue
        rd = w1 & 0x1F
        for j in range(k + 4, min(k + 0x28, 0x40), 4):
            w2 = A.w(d, off + j)
            if (w2 & 0xFFC00000) != 0x39400000 or ((w2 >> 5) & 0x1F) != rd:
                continue
            immlo = (w1 >> 29) & 3
            immhi = (w1 >> 5) & 0x7FFFF
            imm = A.sign_ext((immhi << 2) | immlo, 21)
            page = ((off + k + BASE) & ~0xFFF) + (imm << 12)
            lcd_en = page + ((w2 >> 10) & 0xFFF)
            break
        if lcd_en is not None:
            break
    if lcd_en is None:
        raise F.FindError('lcd_is_enabled not found in lcd_puts')
    res['PANEL'] = 0x9F1DC6B0          # s_sprdfb_dev.panel, read by lcd_refresh
    res['LCD_ENABLED'] = lcd_en
    log('  %-10s %#x' % ('LCD_ENABLED', lcd_en))
    return res


def locate_v2(d, log=print):
    res = F.locate(d, log=log)
    FLAG = res['FLAG']
    for name, dv in LAYOUT_V2:
        res[name] = FLAG + dv
    res['HOOK_BL'] = res['HOOK'] + 0x0C
    res['PUTS_BODY'] = res['PUTS'] + 4
    res.update(locate_lcd(d, log=log))
    log('  layout v2   FLAG %#08x  HOOK %#08x  EMIT %#08x  END %#08x'
        % (res['FLAG'], res['HOOK'], res['EMIT'], res['DEAD_END']))
    return res


from . import builder as SB


class BuildError(Exception):
    pass


def code_screenlog(a):
    """if (lcd_is_enabled && panel) { lcd_puts(s); lcd_refresh(); } with a
    re-entrancy lock: lcd_refresh() prints through printf() when the panel is
    missing or the refresh fails, and printf ends up back in this hook."""
    S = a['SCREENLOG']
    V = lambda k: va(S + k * 4)
    return [
        0xA9BE7BFD,                                   #  0 stp x29,x30,[sp,#-0x20]!
        0x910003FD,                                   #  1 mov x29,sp
        0xF9000BE0,                                   #  2 str x0,[sp,#0x10]
        A.adrp(1, V(3), a['LCD_ENABLED']),            #  3
        A.add_imm(1, 1, a['LCD_ENABLED'] & 0xFFF),    #  4
        A.ldrb_imm(1, 1, 0),                          #  5 ldrb w1,[lcd_is_enabled]
        A.cbz_w(1, 13),                               #  6 cbz w1,done
        A.adrp(2, V(7), a['PANEL']),                  #  7
        A.ldr_x_imm(2, 2, (a['PANEL'] & 0xFFF) // 8), #  8 ldr x2,[panel]
        A.cbz_x(2, 10),                               #  9 cbz x2,done
        A.adrp(3, V(10), va(a['SLOCK'])),             # 10
        A.add_imm(3, 3, va(a['SLOCK']) & 0xFFF),      # 11
        A.ldrb_imm(4, 3, 0),                          # 12 ldrb w4,[slock]
        A.cbnz_w(4, 6),                               # 13 cbnz w4,done
        0xD2800024,                                   # 14 mov w4,#1
        A.strb_imm(4, 3, 0),                          # 15 strb w4,[x3]
        A.bl_(V(16), va(a['LCD_PUTS'])),              # 16 bl lcd_puts
        A.bl_(V(17), va(a['LCD_REFRESH'])),           # 17 bl lcd_refresh
        A.strb_imm(31, 3, 0),                         # 18 strb wzr,[x3]
        0xF9400BE0,                                   # 19 done: ldr x0,[sp,#0x10]
        0xA8C27BFD,                                   # 20 ldp x29,x30,[sp],#0x20
        0xD65F03C0,                                   # 21 ret
    ]


def code_early(a, do_cboot_prologue):
    """if (!lcd_is_enabled) drv_lcd_init(); then refresh, then run original."""
    E = a['EARLYLCD']
    V = lambda k: va(E + k * 4)
    return [
        0xA9BC7BFD,                                   #  0 stp x29,x30,[sp,#-0x40]!
        0x910003FD,                                   #  1 mov x29,sp
        0xA90107E0,                                   #  2 stp x0,x1,[sp,#0x10]
        0xA9020FE2,                                   #  3 stp x2,x3,[sp,#0x20]
        A.bl_(V(4), va(a['LCD_INIT'])),                   #  4 bl drv_lcd_init
        A.adrp(4, V(5), a['LCD_ENABLED']),            #  5
        A.add_imm(4, 4, a['LCD_ENABLED'] & 0xFFF),    #  6
        A.ldrb_imm(5, 4, 0),                          #  7
        A.cbz_w(5, 2),                                #  8 cbz w5,restore
        A.bl_(V(9), va(a['LCD_REFRESH'])),                #  9 bl lcd_refresh
        0xA9420FE2,                                   # 10 ldp x2,x3,[sp,#0x20]
        0xA94107E0,                                   # 11 ldp x0,x1,[sp,#0x10]
        0xA8C47BFD,                                   # 12 ldp x29,x30,[sp],#0x40
        do_cboot_prologue,                            # 13 stp x29,x30,[sp,#-224]!
        A.b_(V(14), va(a['DO_CBOOT']) + 4),               # 14 b do_cboot+4
    ]


def code_hook(a):
    """puts entry: u2s mirror (if the port is up), panel mirror, real body."""
    H = a['HOOK']
    V = lambda k: va(H + k * 4)
    return [
        0xA9BF7BFD,                                   #  0 stp x29,x30,[sp,#-0x10]! (puts)
        0xA9BE7BFD,                                   #  1 stp x29,x30,[sp,#-0x20]!
        0xF9000BE0,                                   #  2 str x0,[sp,#0x10]
        A.adrp(1, V(3), a['PORTFLAG']),               #  3
        A.add_imm(1, 1, a['PORTFLAG'] & 0xFFF),       #  4
        A.ldr_w_imm(2, 1, 0),                         #  5 ldr w2,[x1]
        A.cbz_w(2, 2),                                #  6 cbz w2,no_usb
        A.bl_(V(7), va(a['EMIT'])),                       #  7 bl emit
        0xF9400BE0,                                   #  8 no_usb: ldr x0,[sp,#0x10]
        A.bl_(V(9), va(a['SCREENLOG'])),                  #  9 bl screenlog
        0xF9400BE0,                                   # 10 ldr x0,[sp,#0x10]
        0xA8C27BFD,                                   # 11 ldp x29,x30,[sp],#0x20
        A.b_(V(12), va(a['PUTS_BODY'])),                  # 12 b puts+4
    ]


def build_v2(base_bytes, a, dhtb30, opts=None, log=print):
    opts = opts or {}
    d = bytearray(base_bytes)
    if struct.unpack_from('<I', d, 0x30)[0] != dhtb30:
        raise BuildError('[0x30] mismatch: want %#x' % dhtb30)
    if A.w(d, a['PUTS']) != 0xA9BF7BFD:
        raise BuildError('puts prologue @%#x' % a['PUTS'])
    if A.w(d, a['DO_CBOOT']) != 0xA9B27BFD:
        raise BuildError('do_cboot prologue @%#x' % a['DO_CBOOT'])
    if (A.w(d, a['USB_OFF_CALL']) >> 26) != 0x25:
        raise BuildError('usb_off call @%#x is not a bl' % a['USB_OFF_CALL'])

    blocks = [
        ('SCREENLOG', code_screenlog(a)),
        ('EARLYLCD', code_early(a, A.w(d, a['DO_CBOOT']))),
        ('HOOK', code_hook(a)),
        ('PUMP', SB.pump_code(a)),
        ('EMIT', SB.log2_code(dict(a, LOG2=a['EMIT']))),
    ]
    for i, (name, words) in enumerate(blocks):
        end = a[blocks[i + 1][0]] if i + 1 < len(blocks) else a['DEAD_END']
        if a[name] + 4 * len(words) > end:
            raise BuildError('%s overruns: %#x + %d > %#x'
                             % (name, a[name], 4 * len(words), end))

    struct.pack_into('<B', d, a['FLAG'], 1)
    struct.pack_into('<B', d, a['SLOCK'], 0)
    for name, words in blocks:
        for i, w in enumerate(words):
            struct.pack_into('<I', d, a[name] + 4 * i, w)
        log('  %-10s file %#08x  %2d instrs  %3d bytes'
            % (name, a[name], len(words), 4 * len(words)))

    struct.pack_into('<I', d, a['PUTS'], A.b_(va(a['PUTS']), va(a['HOOK'])))
    log('  %-10s file %#08x  -> hook' % ('puts entry', a['PUTS']))
    if opts.get('earlylcd', True):
        struct.pack_into('<I', d, a['DO_CBOOT'],
                         A.b_(va(a['DO_CBOOT']), va(a['EARLYLCD'])))
        log('  %-10s file %#08x  -> earlylcd' % ('cboot entry', a['DO_CBOOT']))
    if opts.get('nopusboff', True):
        struct.pack_into('<I', d, a['USB_OFF_CALL'], NOP)
        log('  %-10s file %#08x  nop (usb stays powered)' % ('usb off call', a['USB_OFF_CALL']))
    return bytes(d)


def applicable(d):
    """True when every vp19 template lands and puts still has its prologue."""
    try:
        t = load_lcd_templates()
        for k in ('lcd_init', 'lcd_puts', 'lcd_refresh', 'do_cboot', 'vlx_entry'):
            pick(d, t['blocks'][k])
        cs = F.template_candidates(d, F.load_templates()['blocks']['puts'])
        return bool(cs) and A.w(d, cs[0]['off']) == 0xA9BF7BFD
    except Exception:
        return False
