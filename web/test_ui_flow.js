'use strict';
globalThis.TEMPLATES_DW99 = require('./tpl.js').TEMPLATES_DW99;
const C = require('./core.js'); require('./gzip.js');
const fs = require('fs');
const src = new Uint8Array(fs.readFileSync('/root/github/SL8541E-BootChain/原厂启动链-vp19/U-Boot/uboot.bin'));
let u = src;
const lk = C.findUbootLock(u); if (!lk.patched) u = C.patchLockOnly(u, lk);
const bn = C.findBanners(u);
u = C.applyText(u, bn.warn, C.textToBytes('QQ:3981750101\nBoot Format OK, Kernel Started...\n', bn.warn.slot, 'warn'), 'warn');
u = C.applyText(u, bn.info, C.textToBytes('SPRD U-Boot - Patch By Dunoguang  \n', bn.info.slot, 'info'), 'info');
const det = C.detectUsblog(u);
if (det.state === 'clean') { const a = C.locate(u); u = C.buildUsblog(u, a, C.rd32(u, 0x30)); }
console.log('after usblog md5', C.md5(u), 'usblog state', C.detectUsblog(u).state);
const gz = C.detectGzip(u);
console.log('gzip state', gz.state, gz.why || '');
if (gz.state === 'clean') {
  u = C.buildGzip(u, gz.anchors);
  const v = C.verifyGzip(u, gz.anchors);
  console.log('gzip words', gz.anchors.words, 'jv', C.hexOff(gz.anchors.jv), 'verify_bad', v.bad);
}
console.log('final md5', C.md5(u), 'size', u.length);
