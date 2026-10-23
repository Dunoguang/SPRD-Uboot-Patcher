'use strict';
globalThis.TEMPLATES_DW99 = require('./tpl.js').TEMPLATES_DW99;
const C = require('./core.js'); require('./gzip.js');
const fs = require('fs');
const d = new Uint8Array(fs.readFileSync('/root/github/SL8541E-BootChain/原厂启动链-vp19/U-Boot/uboot.bin'));
let fails = 0;
console.log('applicableVp19', C.applicableVp19(d));
const a = C.locateVp19(d);
console.log('anchors FLAG', C.hexOff(a.FLAG), 'DEAD_END', C.hexOff(a.DEAD_END),
            'RET1', C.hexOff(a.RET1), 'FORCE_PORT', C.hexOff(a.FORCE_PORT), 'TRIG', C.hexOff(a.TRIG));
let u = C.buildVp19(d, a, C.rd32(d, 0x30), { earlylcd: true, nopusboff: true });
const v1 = C.verifyVp19(u, a, C.rd32(d, 0x30), { earlylcd: true, nopusboff: true });
console.log('verifyVp19 bad', v1.bad);
if (v1.bad) fails++;
const gz = C.detectGzip(u);
console.log('gzip state', gz.state, gz.why || '');
if (gz.state === 'clean') {
  const gza = gz.anchors;
  console.log('gzip container', C.hexOff(gza.hook), 'size', gza.size);
  u = C.buildGzip(u, gza);
  const jvF = gza.jv - 0x9EFFFE00;
  const overlap = !(jvF < a.FLAG || gza.hook >= a.DEAD_END);
  console.log('jv file', C.hexOff(jvF), 'overlap with vp19 block', overlap);
  if (overlap) fails++;
  const v2 = C.verifyGzip(u, gza);
  console.log('gzip verify bad', v2.bad, 'words', gza.words);
  if (v2.bad) fails++;
} else fails++;
console.log('kick RET1', C.rd32(u, a.RET1).toString(16),
            'FORCE_PORT', C.rd32(u, a.FORCE_PORT).toString(16),
            'TRIG', C.rd32(u, a.TRIG).toString(16));
if (C.rd32(u, a.RET1) !== 0x52800033 || C.rd32(u, a.FORCE_PORT) !== 0x350001c0) fails++;
console.log('final md5', C.md5(u));
if (fails) { console.log('RESULT FAIL ' + fails); process.exit(1); }
console.log('RESULT PASS');
