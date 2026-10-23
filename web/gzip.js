/* gzip kernel support: anchor location + binary patch.  Loaded after core.js. */
(function (root) {
'use strict';
var UP = (typeof module !== 'undefined' && module.exports) ? require('./core.js')
       : (root.UP84 = root.UP84 || {});
var rd32 = UP.rd32, wr32 = UP.wr32, hexOff = UP.hexOff,
    decPair = UP.decPair, branchTarget = UP.branchTarget,
    bl_ = UP.bl_, b_ = UP.b_, adrp = UP.adrp, addImm = UP.addImm,
    movzX = UP.movzX, movzW = UP.movzW, ldrXImm = UP.ldrXImm, strXImm = UP.strXImm,
    ldrbImm = UP.ldrbImm, subsWImm = UP.subsWImm, cmpX = UP.cmpX, movX = UP.movX,
    cbnzW = UP.cbnzW, bNe = UP.bNe, bCond = UP.bCond;

var BASE = 0x9efffe00;
var JMP_W = 0xd2b00104, CALL_W = 0xd2b00103, BLRX4 = 0xd63f0080;
var READ_LIMIT = 280, READ_MAX = 700;

function va(f) { return BASE + f; }
function w(d, o) { return rd32(d, o) >>> 0; }
function stpPre(rt, rt2, rn, imm) { return UP.u32(0xa9800000 | (((imm/8)&0x7f)<<15) | (rt2<<10) | (rn<<5) | rt); }
function stpOff(rt, rt2, rn, imm) { return UP.u32(0xa9000000 | (((imm/8)&0x7f)<<15) | (rt2<<10) | (rn<<5) | rt); }
function ldpOff(rt, rt2, rn, imm) { return UP.u32(0xa9400000 | (((imm/8)&0x7f)<<15) | (rt2<<10) | (rn<<5) | rt); }
function ldpPost(rt, rt2, rn, imm) { return UP.u32(0xa8c00000 | (((imm/8)&0x7f)<<15) | (rt2<<10) | (rn<<5) | rt); }
function ldrLit(rt, pc, target) { return UP.u32(0x58000000 | ((((target-pc)/4)&0x7ffff)<<5) | rt); }
function cbnzX(rt, delta) { return UP.u32(0xb5000000 | (((delta&0x7ffff)<<5)>>>0) | rt); }

function findJmp(d) {
  var out = [];
  for (var o = 0x200; o < d.length - 8; o += 4)
    if (w(d,o) === JMP_W && w(d,o+4) === BLRX4) out.push(o);
  return out;
}
function findCall(d) {
  var out = [];
  for (var o = 0x200; o < d.length - 20; o += 4) {
    if (w(d,o) !== CALL_W) continue;
    for (var k = 1; k <= 3; k++) {
      var off = o + k*4;
      if ((w(d,off) >>> 26) !== 0x25) continue;
      var t = branchTarget(d, off, BASE);
      if (t !== null && t >= 0x9f000000 && t < 0x9f0a0000) { out.push([o, off, t]); break; }
    }
  }
  return out;
}
function ab(s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i)); return a; }
function strPos(d, s) {
  s = ab(s);
  var out = [], i = 0, n = s.length;
  while (true) {
    i = UP.findSub(d, s, i);
    if (i < 0) break;
    out.push(i); i += 1;
  }
  return out;
}
function findGunzip(d) {
  var n1 = 'Error: Bad gzipped data', n2 = 'Error: gunzip out of data in header';
  var s1 = strPos(d, n1), s2 = strPos(d, n2);
  if (!s1.length || !s2.length) return [];
  var refs = [];
  for (var o = 0x200; o < d.length - 8; o += 4) {
    var t = decPair(d, o, BASE);
    if (t === null) continue;
    var f = t - BASE, tag = 0, i;
    for (i = 0; i < s1.length; i++) if (f >= s1[i] && f < s1[i] + n1.length) tag |= 1;
    for (i = 0; i < s2.length; i++) if (f >= s2[i] && f < s2[i] + n2.length) tag |= 2;
    if (tag) refs.push([o, tag]);
  }
  var starts = {}, out = [];
  for (var a = 0; a < refs.length; a++) for (var b = 0; b < refs.length; b++) {
    if (a === b || (refs[a][1] | refs[b][1]) !== 3) continue;
    if (Math.abs(refs[a][0] - refs[b][0]) > 0x400) continue;
    var r = Math.min(refs[a][0], refs[b][0]);
    for (var q = r; q >= 0x200 && q > r - 0x600; q -= 4) {
      if (UP.u32(w(d,q) & ~0x003f8000) === 0xa9807bfd) { starts[q] = true; break; }
    }
  }
  for (var k in starts) out.push(+k);
  out.sort(function (x, y) { return x - y; });
  return out;
}
function scanFuncs(d) {
  var out = [];
  for (var s = 0x200; s < d.length - 8; s += 4) {
    if (UP.u32(w(d,s) & ~0x003f8000) !== 0xa9807bfd) continue;
    var e = null;
    for (var p = s; p < Math.min(d.length - 4, s + 0x1000); p += 4) {
      if (w(d,p) === 0xd65f03c0) { e = p + 4; break; }
    }
    if (e !== null) out.push([s, e, s >= 4 ? w(d, s-4) : 0]);
  }
  return out;
}
function pickContainer(d) {
  var refs = UP.scanRefs(d), brs = refs[0], ptrs = refs[1];
  var cands = [], fs = scanFuncs(d);
  for (var i = 0; i < fs.length; i++) {
    var s = fs[i][0], e = fs[i][1], prev = fs[i][2], sz = e - s;
    if (sz < READ_LIMIT || sz > READ_MAX) continue;
    var lo = s + BASE, hi = e + BASE, ok = true;
    for (var j = 0; j < brs.length; j++) {
      var o = brs[j][0], t = brs[j][1];
      if (t >= lo && t < hi && !(o + BASE >= lo && o + BASE < hi)) { ok = false; break; }
    }
    if (ok) for (var k in ptrs) { var v = +k; if (v >= lo && v < hi) { ok = false; break; } }
    if (ok && (prev === 0xd65f03c0 || prev === 0)) cands.push([s, sz]);
  }
  cands.sort(function (x, y) { return x[0] - y[0]; });
  return cands;
}
function locateGzip(d) {
  var j = findJmp(d), c = findCall(d), g = findGunzip(d);
  if (j.length !== 1) throw new Error('gzip: jmp site not unique (' + j.length + ')');
  if (c.length !== 1) throw new Error('gzip: call site not unique (' + c.length + ')');
  if (g.length !== 1) throw new Error('gzip: gunzip not unique (' + g.length + ')');
  var call = c[0][0], callBl = c[0][1], read = c[0][2], jmp = j[0];
  if (Math.abs(jmp - call) >= 0x2000)
    throw new Error('gzip: call/jmp relation failed');
  var cont = pickContainer(d);
  if (!cont.length) throw new Error('gzip: no clean container function');
  var hook = cont[0][0], size = cont[0][1];
  if (size < READ_LIMIT) throw new Error('gzip: container too small');
  return { call: call, callBl: callBl, read: read, jmp: jmp, gunzip: g[0],
           hook: hook, size: size, containers: cont.length };
}
UP.locateGzip = locateGzip;
UP.findGzipJmp = findJmp;
UP.findGzipCall = findCall;
UP.findGzipGunzip = findGunzip;
UP.scanGzipFuncs = scanFuncs;
UP.pickGzipContainer = pickContainer;
})(typeof self !== 'undefined' ? self : this);

(function (root) {
'use strict';
var UP = (typeof module !== 'undefined' && module.exports) ? require('./core.js')
       : (root.UP84 = root.UP84 || {});
var rd32 = UP.rd32, wr32 = UP.wr32, hexOff = UP.hexOff,
    branchTarget = UP.branchTarget, bl_ = UP.bl_, b_ = UP.b_, adrp = UP.adrp,
    addImm = UP.addImm, addX = UP.addX, cmpX = UP.cmpX, movX = UP.movX,
    movzX = UP.movzX, movzW = UP.movzW, ldrXImm = UP.ldrXImm, strXImm = UP.strXImm,
    ldrbImm = UP.ldrbImm, subsWImm = UP.subsWImm, cbnzW = UP.cbnzW, bNe = UP.bNe,
    bCond = UP.bCond;
var BASE = 0x9efffe00;
function va(f) { return BASE + f; }
function w(d, o) { return rd32(d, o) >>> 0; }
function stpPre(rt, rt2, rn, imm) { return UP.u32(0xa9800000 | (((imm/8)&0x7f)<<15) | (rt2<<10) | (rn<<5) | rt); }
function stpOff(rt, rt2, rn, imm) { return UP.u32(0xa9000000 | (((imm/8)&0x7f)<<15) | (rt2<<10) | (rn<<5) | rt); }
function ldpOff(rt, rt2, rn, imm) { return UP.u32(0xa9400000 | (((imm/8)&0x7f)<<15) | (rt2<<10) | (rn<<5) | rt); }
function ldpPost(rt, rt2, rn, imm) { return UP.u32(0xa8c00000 | (((imm/8)&0x7f)<<15) | (rt2<<10) | (rn<<5) | rt); }
function ldrLit(rt, pc, target) { return UP.u32(0x58000000 | ((((target-pc)/4)&0x7ffff)<<5) | rt); }
function cbnzX(rt, delta) { return UP.u32(0xb5000000 | (((delta&0x7ffff)<<5)>>>0) | rt); }

function buildGzip(d, a) {
  var out = new Uint8Array(d), hook = a.hook, L = [];
  function at() { return va(hook) + L.length * 4; }
  function e(x) { L.push(UP.u32(x)); return L.length - 1; }
  e(stpPre(29,30,31,-0xA0));
  e(stpOff(0,1,31,0x60));
  e(stpOff(2,3,31,0x70));
  e(strXImm(19,31,0x80/8));
  e(0x910043e3);
  e(movzW(1,0x40));
  e(bl_(at(), a.read));
  e(ldrbImm(4,31,0x10));
  e(subsWImm(31,4,0x1f));
  var iB1 = e(0);
  e(ldrbImm(4,31,0x11));
  e(subsWImm(31,4,0x8b));
  var iB2 = e(0);
  e(ldpOff(0,1,31,0x60));
  e(ldpOff(2,3,31,0x70));
  e(UP.u32(movzX(3,0x8380) | (1<<21)));
  e(bl_(at(), a.read));
  e(0x2a0003f3);
  e(UP.u32(movzX(0,0x8000) | (1<<21)));
  e(UP.u32(movzX(1,0x0380) | (1<<21)));
  e(UP.u32(movzX(2,0x8380) | (1<<21)));
  e(0x910143e3);
  e(ldrXImm(4,31,0x68/8));
  e(strXImm(4,3,0));
  e(bl_(at(), va(a.gunzip)));
  var iCB = e(0);
  e(UP.u32(movzX(9,0x8000) | (1<<21)));
  e(ldrXImm(5,9,1));
  e(0xd359fca6);
  var iOdd = e(0);
  var iTO = e(0);
  e(strXImm(9,31,0x58/8));
  e(movX(5,9));
  e(movzW(19,0));
  var iBG = e(0);
  var iRaw = L.length;
  e(ldpOff(0,1,31,0x60));
  e(ldpOff(2,3,31,0x70));
  e(ldrXImm(5,31,3));
  e(0xd359fca6);
  var iRO = e(0);
  e(UP.u32(movzX(9,0x8000) | (1<<21)));
  e(addX(9,9,5));
  var iBR = e(0);
  var iROT = L.length;
  e(UP.u32(movzX(9,0x8008) | (1<<21)));
  var iRR = L.length;
  e(strXImm(9,31,0x58/8));
  e(movX(3,9));
  e(bl_(at(), a.read));
  e(0x2a0003f3);
  e(ldrXImm(5,31,0x58/8));
  var iBS = e(0);
  var iStore = L.length;
  e(0); e(0); e(strXImm(5,4,0));
  var iOut = L.length;
  e(0x2a1303e0);
  e(ldrXImm(19,31,0x80/8));
  e(ldpPost(29,30,31,0xA0));
  e(0xd65f03c0);
  var iFail = L.length;
  e(movzW(19,1));
  e(b_(at(), va(hook) + iOut*4));
  var jv = va(hook) + L.length*4;
  jv = jv + ((8 - (jv % 8)) % 8);
  var jvPage = jv - (jv % 0x1000);
  L[iStore] = adrp(4, va(hook)+iStore*4, jvPage);
  L[iStore+1] = addImm(4, 4, jv % 0x1000);
  var S = function (k) { return va(hook) + k*4; };
  L[iB1] = bNe(iRaw - iB1);
  L[iB2] = bNe(iRaw - iB2);
  L[iCB] = cbnzW(0, iFail - iCB);
  L[iOdd] = cbnzX(6, iFail - iOdd);
  L[iTO] = cbnzX(5, iFail - iTO);
  L[iBG] = b_(S(iBG), S(iStore));
  L[iRO] = cbnzX(6, iROT - iRO);
  L[iBR] = b_(S(iBR), S(iRR));
  L[iBS] = b_(S(iBS), S(iStore));
  for (var i = 0; i < L.length; i++) UP.wr32(out, hook + i*4, L[i]);
  for (var k = 0; k < 8; k++) out[jv - BASE + k] = 0;
  UP.wr32(out, a.callBl, bl_(va(a.callBl), va(hook)));
  UP.wr32(out, a.jmp, ldrLit(4, va(a.jmp), jv));
  a.jv = jv; a.words = L.length;
  return out;
}

function verifyGzip(d, a) {
  var bad = 0;
  function check(ok, msg) { if (!ok) { bad++; return 'FAIL ' + msg; } return 'ok   ' + msg; }
  var lines = [];
  lines.push(check(branchTarget(d, a.callBl, BASE) === va(a.hook), 'bl -> hook'));
  var wv = rd32(d, a.jmp), imm = (wv >>> 5) & 0x7ffff;
  if (imm & 0x40000) imm -= 0x80000;
  lines.push(check((wv >>> 26) === 0x16 && BASE + a.jmp + imm*4 === a.jv, 'ldr -> jv'));
  lines.push(check(rd32(d, a.jmp+4) === 0xd63f0080, 'blr x4 kept'));
  for (var i = 0; i < a.words; i++) {
    var off = a.hook + i*4, t = branchTarget(d, off, BASE);
    if (t === null) continue;
    var inside = (t >= va(a.hook) && t < a.jv + 8) || t === a.read || t === va(a.gunzip);
    if (!inside) { lines.push('FAIL branch @' + hexOff(off) + ' -> ' + hexOff(t - BASE)); bad++; }
  }
  return { bad: bad, lines: lines };
}

function findInjected(d) {
  var hits = [];
  for (var o = 0x200; o < d.length - 8; o += 4) {
    var wv = w(d, o);
    if ((wv >>> 26) !== 0x16) continue;
    if (w(d, o + 4) !== 0xd63f0080) continue;
    if ((wv & 0x1f) !== 4) continue;
    var imm = (wv >>> 5) & 0x7ffff;
    if (imm & 0x40000) imm -= 0x80000;
    var jv = BASE + o + imm * 4;
    if (jv < 0x9f000000 || jv >= 0x9f0a0000 || (jv % 8)) continue;
    var jf = jv - BASE, hook = -1;
    for (var p = jf - 4; p >= jf - 0x200 && p >= 0x200; p -= 4) {
      if (UP.u32(w(d, p) & ~0x003f8000) === 0xa9807bfd) { hook = p; break; }
    }
    if (hook < 0) continue;
    var hookVa = BASE + hook, call = -1;
    for (var q = 0x200; q < d.length - 4; q += 4) {
      if ((w(d, q) >>> 26) !== 0x25) continue;
      if (branchTarget(d, q, BASE) === hookVa) { call = q; break; }
    }
    if (call < 0) continue;
    hits.push({ state: 'injected', call: call, callBl: call, jmp: o, jv: jv,
                hook: hook, words: (jf - hook) / 4 });
  }
  return hits;
}

function detectGzip(d) {
  try {
    var a = UP.locateGzip(d);
    return { state: 'clean', anchors: a };
  } catch (e1) {
    try {
      var inj = findInjected(d);
      if (inj.length === 1) return { state: 'injected', anchors: inj[0] };
      if (inj.length > 1) return { state: 'na', why: 'gzip: injected pattern not unique (' + inj.length + ')' };
    } catch (e2) {}
    return { state: 'na', why: e1.message || String(e1) };
  }
}
UP.buildGzip = buildGzip;
UP.verifyGzip = verifyGzip;
UP.detectGzip = detectGzip;
UP.findGzipInjected = findInjected;
})(typeof self !== 'undefined' ? self : this);
