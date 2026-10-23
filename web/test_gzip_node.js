#!/usr/bin/env node
'use strict';
globalThis.TEMPLATES_DW99 = require('./tpl.js').TEMPLATES_DW99;
const C = require('./core.js');
require('./gzip.js');
const fs = require('fs');
const load = (p) => new Uint8Array(fs.readFileSync(p));
const paths = [
  '/root/github/SL8541E-BootChain/原厂启动链-vp19/U-Boot/uboot.bin',
  '/root/github/uboot-usblog/images/uboot.img',
  '/root/github/SPRD-Uboot-Patcher/tests/out-ai3/uboot-unlock-bootloader-usblog.img',
  '/root/github/SPRD-Uboot-Patcher/tests/out-dw99/uboot-unlock-bootloader-usblog.img',
  '/root/github/SPRD-Uboot-Patcher/tests/out-m9u/uboot-unlock-bootloader-usblog.img'
];
let fails = 0;
for (const p of paths) {
  const d = load(p);
  try {
    const a = C.locateGzip(d);
    console.log('ok    ' + p.split('/').slice(-3).join('/') +
                '  call=' + C.hexOff(a.call) + ' jmp=' + C.hexOff(a.jmp) +
                ' read=0x' + a.read.toString(16) + ' gz=' + C.hexOff(a.gunzip) +
                ' hook=' + C.hexOff(a.hook) + '/' + a.size);
  } catch (e) {
    fails++;
    console.log('FAIL  ' + p.split('/').slice(-3).join('/') + '  ' + e.message);
  }
}
const src = load(paths[0]);
const a = C.locateGzip(src);
const out = C.buildGzip(src, a);
const v = C.verifyGzip(out, a);
console.log('build: words=' + a.words + ' jv=' + C.hexOff(a.jv) + ' verify_bad=' + v.bad);
for (const l of v.lines) console.log('  ' + l);
let diff = 0, zones = 0, prev = -99;
for (let i = 0; i < src.length; i++) {
  if (src[i] !== out[i]) {
    diff++;
    if (i - prev > 8) zones++;
    prev = i;
  }
}
console.log('diff bytes=' + diff + ' zones=' + zones + ' out_md5=' + C.md5(out));
if (fails || v.bad) { console.log('RESULT FAIL'); process.exit(1); }
console.log('RESULT PASS');
