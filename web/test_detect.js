'use strict';
globalThis.TEMPLATES_DW99 = require('./tpl.js').TEMPLATES_DW99;
const C = require('./core.js'); require('./gzip.js');
const fs = require('fs');
const load = (p) => new Uint8Array(fs.readFileSync(p));
const clean = [
  '/root/github/SL8541E-BootChain/原厂启动链-vp19/U-Boot/uboot.bin',
  '/root/github/uboot-usblog/images/uboot.img',
  '/root/github/SPRD-Uboot-Patcher/tests/out-ai3/uboot-unlock-bootloader-usblog.img',
  '/root/github/SPRD-Uboot-Patcher/tests/out-dw99/uboot-unlock-bootloader-usblog.img',
  '/root/github/SPRD-Uboot-Patcher/tests/out-m9u/uboot-unlock-bootloader-usblog.img'
];
const injected = [
  '/root/gzpatch/uboot-vp19-gzip.img',
  '/root/gzpatch/uboot-vp19-usblog-gzip.img'
];
let fails = 0;
for (const p of clean) {
  const r = C.detectGzip(load(p));
  const ok = r.state === 'clean';
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + ' clean   ' + p.split('/').slice(-3).join('/') + '  -> ' + r.state);
}
for (const p of injected) {
  const r = C.detectGzip(load(p));
  const ok = r.state === 'injected';
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + ' injected ' + p.split('/').pop() + '  -> ' + r.state +
              (ok ? '  hook=' + C.hexOff(r.anchors.hook) + ' jv=' + C.hexOff(r.anchors.jv) +
                    ' call=' + C.hexOff(r.anchors.call) + ' jmp=' + C.hexOff(r.anchors.jmp) : ''));
}
const src = load(clean[0]);
const a = C.locateGzip(src);
const made = C.buildGzip(src, a);
const r2 = C.detectGzip(made);
const ok2 = r2.state === 'injected' && r2.anchors.hook === a.hook && r2.anchors.jv === a.jv;
if (!ok2) fails++;
console.log((ok2 ? 'ok   ' : 'FAIL ') + ' js-built -> ' + r2.state +
            (ok2 ? '  hook=' + C.hexOff(r2.anchors.hook) + ' jv=' + C.hexOff(r2.anchors.jv) : ''));
if (fails) { console.log('RESULT FAIL ' + fails); process.exit(1); }
console.log('RESULT PASS');
