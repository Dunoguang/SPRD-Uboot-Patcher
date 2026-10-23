'use strict';
/* Headless full chain for a vp19-class image:
 * unlock -> banner -> screenlog / earlylcd / nopusboff -> gzip kernel.
 *
 *   node tests/make_vp19_full.js <input uboot.bin> <output.img>
 */
globalThis.TEMPLATES_DW99 = require('../web/tpl.js').TEMPLATES_DW99;
const C = require('../web/core.js');
require('../web/gzip.js');
const fs = require('fs');

const inp = process.argv[2], outp = process.argv[3];
if (!inp || !outp) {
  console.log('usage: node tests/make_vp19_full.js <input uboot.bin> <output img>');
  process.exit(2);
}
const WARN = 'QQ:3981750101\nBoot Format OK, Kernel Started...\n';
const INFO = 'SPRD U-Boot - Patch By Dunoguang  \n';

let u = new Uint8Array(fs.readFileSync(inp));
const lk = C.findUbootLock(u); if (!lk.patched) u = C.patchLockOnly(u, lk);
const bn = C.findBanners(u);
u = C.applyText(u, bn.warn, C.textToBytes(WARN, bn.warn.slot, 'warn'), 'warn');
u = C.applyText(u, bn.info, C.textToBytes(INFO, bn.info.slot, 'info'), 'info');
const a = C.locateVp19(u);
u = C.buildVp19(u, a, C.rd32(u, 0x30), { earlylcd: true, nopusboff: true });
const v1 = C.verifyVp19(u, a, C.rd32(u, 0x30), { earlylcd: true, nopusboff: true });
console.log('screenlog verify bad', v1.bad);
const gz = C.detectGzip(u);
console.log('gzip state', gz.state);
if (gz.state === 'clean') {
  u = C.buildGzip(u, gz.anchors);
  const v2 = C.verifyGzip(u, gz.anchors);
  console.log('gzip verify bad', v2.bad, 'hook', C.hexOff(gz.anchors.hook),
              'jv', C.hexOff(gz.anchors.jv), 'words', gz.anchors.words);
}
console.log('kick RET1', C.rd32(u, a.RET1).toString(16),
            'FORCE_PORT', C.rd32(u, a.FORCE_PORT).toString(16),
            'TRIG', C.rd32(u, a.TRIG).toString(16));
fs.writeFileSync(outp, u);
console.log('written', outp, u.length, C.md5(u));
