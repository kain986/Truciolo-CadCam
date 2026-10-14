/* Truciolo CAM core — geometria, percorsi utensile e postprocessore G-code.
   Nessuna dipendenza dal DOM: usa ClipperLib (globale) per gli offset 2D. */
(function (G) {
  'use strict';
  const SC = 1000;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const uid = () => Math.random().toString(36).slice(2, 9);

  /* ---------- geometria 2D ---------- */
  function circleSegs(r) { return clamp(Math.ceil(2 * Math.PI * r / 0.4), 24, 360); }

  function entPoly(e) {
    switch (e.type) {
      case 'line': return { pts: [[e.x1, e.y1], [e.x2, e.y2]], closed: false };
      case 'rect': {
        const rr = clamp(+e.rr || 0, 0, Math.min(Math.abs(e.w), Math.abs(e.h)) / 2);
        const x0 = Math.min(e.x, e.x + e.w), y0 = Math.min(e.y, e.y + e.h);
        const x1 = Math.max(e.x, e.x + e.w), y1 = Math.max(e.y, e.y + e.h);
        if (rr < 1e-6) return { pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true };
        const p = [], n = Math.max(4, Math.ceil(circleSegs(rr) / 4));
        const corners = [[x1 - rr, y0 + rr, -90], [x1 - rr, y1 - rr, 0], [x0 + rr, y1 - rr, 90], [x0 + rr, y0 + rr, 180]];
        for (const [cx, cy, a0] of corners) for (let k = 0; k <= n; k++) {
          const a = (a0 + 90 * k / n) * Math.PI / 180; p.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
        }
        return { pts: p, closed: true };
      }
      case 'circle': {
        const n = circleSegs(e.r), p = [];
        for (let k = 0; k < n; k++) { const a = 2 * Math.PI * k / n; p.push([e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]); }
        return { pts: p, closed: true };
      }
      case 'poly': return { pts: e.pts.map(q => [q[0], q[1]]), closed: !!e.closed && e.pts.length > 2 };
    }
    return { pts: [], closed: false };
  }

  function area(p) { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; }
  const toCl = p => p.map(q => ({ X: Math.round(q[0] * SC), Y: Math.round(q[1] * SC) }));
  const fromCl = p => p.map(q => [q.X / SC, q.Y / SC]);

  function offsetPaths(paths, delta) {
    const co = new ClipperLib.ClipperOffset(2, 0.01 * SC);
    co.AddPaths(paths.map(toCl), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const sol = new ClipperLib.Paths(); co.Execute(sol, delta * SC);
    return sol.map(fromCl).filter(p => p.length > 2);
  }
  function unionEvenOdd(paths) {
    const c = new ClipperLib.Clipper();
    c.AddPaths(paths.map(toCl), ClipperLib.PolyType.ptSubject, true);
    const sol = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
    return sol.map(fromCl);
  }
  // somma delle forme: tutte orientate allo stesso modo e unite con regola non-zero
  function unionNonZero(paths) {
    const c = new ClipperLib.Clipper();
    c.AddPaths(paths.map(p => toCl(area(p) < 0 ? p.slice().reverse() : p)), ClipperLib.PolyType.ptSubject, true);
    const sol = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return sol.map(fromCl);
  }
  function rotateTo(pts, x, y) {
    let bi = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; bi = i; } });
    return pts.slice(bi).concat(pts.slice(0, bi));
  }
  function levels(depth, sd) {
    const z = []; let c = 0; sd = Math.max(0.05, +sd || 1);
    while (c > -depth + 1e-6) { c = Math.max(c - sd, -depth); z.push(c); }
    return z;
  }
  function entBBox(ents) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of ents) for (const p of entPoly(e).pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    return isFinite(x0) ? { x0, y0, x1, y1 } : null;
  }

  /* ---------- geometria dell'utensile ---------- */
  // tipo → forma del tagliente. h(ρ): quota del tagliente sopra la punta a distanza ρ dall'asse;
  // rAt(h): raggio di taglio all'altezza h sopra la punta (per la compensazione 2D)
  const GEOM = { flat: 'flat', ball: 'ball', bull: 'bull', face: 'bull', shoulder: 'bull', round: 'bull', vbit: 'vbit', drill: 'drill' };
  const TLABEL = { flat: 'cilindrica', ball: 'sferica', bull: 'torica', vbit: 'conica', drill: 'punta a forare', face: 'spianatore a inserti', shoulder: 'a inserti 90°', round: 'a inserti tondi' };
  function toolGeom(t) {
    const R = Math.max(0.005, (+t.d || 1) / 2), g = GEOM[t.type] || 'flat';
    const cr = g === 'ball' ? R : g === 'bull' ? clamp(+t.cr || 0, 0, R) : 0;
    const ha = clamp(+t.angle || (g === 'drill' ? 118 : 90), 10, 179) / 2 * Math.PI / 180;
    const rt = g === 'vbit' ? clamp((+t.tip || 0) / 2, 0, R) : 0;
    const h = rho => {
      rho = Math.min(Math.max(rho, 0), R);
      if (g === 'ball' || g === 'bull') { const c = R - cr; if (rho <= c) return 0; const u = rho - c; return cr - Math.sqrt(Math.max(0, cr * cr - u * u)); }
      if (g === 'vbit') return rho <= rt ? 0 : (rho - rt) / Math.tan(ha);
      if (g === 'drill') return rho / Math.tan(ha);
      return 0;
    };
    const rAt = hh => {
      if (g === 'ball' || g === 'bull') return hh >= cr ? R : (R - cr) + Math.sqrt(Math.max(0, cr * cr - (cr - hh) ** 2));
      if (g === 'vbit') return Math.min(R, rt + hh * Math.tan(ha));
      if (g === 'drill') return Math.min(R, hh * Math.tan(ha));
      return R;
    };
    const tipLen = g === 'drill' ? R / Math.tan(ha) : g === 'vbit' ? (R - rt) / Math.tan(ha) : cr;
    return { R, g, cr, ha, rt, h, rAt, tipLen };
  }

  /* ---------- costruttore di movimenti ---------- */
  class MB {
    constructor(x, y, z, tool) { this.m = []; this.x = x; this.y = y; this.z = z; this.t = tool; }
    rapid(x, y, z) {
      if (Math.abs(x - this.x) < 1e-6 && Math.abs(y - this.y) < 1e-6 && Math.abs(z - this.z) < 1e-6) return;
      this.m.push({ r: 1, x, y, z }); this.x = x; this.y = y; this.z = z;
    }
    feed(x, y, z) {
      const dx = x - this.x, dy = y - this.y, dz = z - this.z, dxy = Math.hypot(dx, dy);
      if (dxy < 1e-6 && Math.abs(dz) < 1e-6) return;
      const f = (dz < -1e-6 && dxy < -dz) ? this.t.plunge : this.t.feed;
      this.m.push({ r: 0, x, y, z, f }); this.x = x; this.y = y; this.z = z;
    }
    up(z) { if (this.z < z) this.rapid(this.x, this.y, z); }
    travel(x, y, zDown, retract) {
      if (Math.hypot(x - this.x, y - this.y) > 1e-6) { this.up(retract); this.rapid(x, y, this.z); }
      if (zDown < this.z) this.rapid(x, y, zDown);
    }
  }

  function targetEnts(op, S, pred) {
    const all = S.sketch.filter(pred);
    if (!op.targets || !op.targets.length) return all;
    const set = new Set(op.targets);
    return all.filter(e => set.has(e.id));
  }

  /* ---------- 2D: contorno ---------- */
  function tabbed(L, n, len) {
    const P = L.concat([L[0]]); const s = [0];
    for (let i = 1; i < P.length; i++) s.push(s[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const T = s[s.length - 1];
    len = Math.min(len, T / n * 0.5);
    const iv = []; for (let i = 0; i < n; i++) { const c = T * (i + 0.5) / n; iv.push([c - len / 2, c + len / 2]); }
    const bps = iv.flat().sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], s0 = s[i], s1 = s[i + 1];
      out.push({ x: a[0], y: a[1], s: s0 });
      for (const t of bps) if (t > s0 + 1e-9 && t < s1 - 1e-9) {
        const u = (t - s0) / (s1 - s0); out.push({ x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, s: t });
      }
    }
    out.push({ x: P[P.length - 1][0], y: P[P.length - 1][1], s: T });
    return { pts: out, inTab: t => iv.some(([a, b]) => t > a && t < b) };
  }

  function opProfile(op, ctx) {
    const { mb, tool, S, warn } = ctx, p = op.p, r = toolGeom(tool).rAt(+p.depth || 0), rt = S.set.retract;
    const ents = targetEnts(op, S, () => true);
    if (!ents.length) { warn.push('Nessuna forma da contornare: disegna una forma o assegna la selezione.'); return; }
    if (p.depth > S.stock.t + 0.5) warn.push(`La profondità (${p.depth} mm) supera lo spessore del grezzo (${S.stock.t} mm).`);
    const zs = levels(p.depth, p.stepdown);
    const tabZ = -p.depth + (+p.tabH || 0);
    const useTabs = (+p.tabs || 0) > 0 && p.tabH > 0 && tabZ < 0;
    // linee aperte: sulla linea, andata e ritorno
    const openE = ents.filter(e => { const P = entPoly(e); return !P.closed && P.pts.length > 1; });
    if (openE.length && p.side !== 'on') warn.push('Le linee aperte vengono lavorate sulla linea (senza compensazione).');
    for (const e of openE) {
      let pts = entPoly(e).pts;
      const d0 = Math.hypot(pts[0][0] - mb.x, pts[0][1] - mb.y), d1 = Math.hypot(pts[pts.length - 1][0] - mb.x, pts[pts.length - 1][1] - mb.y);
      if (d1 < d0) pts = pts.slice().reverse();
      mb.travel(pts[0][0], pts[0][1], 0.5, rt);
      for (const z of zs) { mb.feed(mb.x, mb.y, z); for (const q of pts) mb.feed(q[0], q[1], z); pts = pts.slice().reverse(); }
      mb.up(rt);
    }
    // forme chiuse: di default si contorna la somma (forme sovrapposte = una sagoma sola)
    const closedP = ents.map(e => entPoly(e)).filter(P => P.closed).map(P => area(P.pts) < 0 ? P.pts.slice().reverse() : P.pts);
    const groups = p.combine === 'separate' ? closedP.map(P => [P]) : (closedP.length ? [unionNonZero(closedP)] : []);
    const off = p.side === 'outside' ? r + (+p.allow || 0) : p.side === 'inside' ? -(r + (+p.allow || 0)) : 0;
    // orientamento naturale: contorni esterni antiorari, fori orari. Concorde (M3): esterno → orario, interno → antiorario
    const rev = p.side === 'inside' ? !p.climb : !!p.climb;
    for (const G of groups) {
      const loops = off ? offsetPaths(G, off) : G;
      if (!loops.length) { warn.push(`Forma troppo piccola per l'utensile Ø${tool.d}: nessun percorso interno.`); continue; }
      loops.sort((u, v) => area(u) - area(v)); // prima i contorni interni
      for (let L of loops) {
        if (rev) L = L.slice().reverse();
        L = rotateTo(L, mb.x, mb.y);
        const tb = useTabs ? tabbed(L, +p.tabs, (+p.tabW || 0) + 2 * r) : null;
        const pts = tb ? tb.pts : L.concat([L[0]]).map(q => ({ x: q[0], y: q[1], s: 0 }));
        mb.travel(pts[0].x, pts[0].y, 0.5, rt);
        for (const z of zs) {
          for (let k = 0; k < pts.length; k++) {
            const q = pts[k];
            let zz = z;
            if (k > 0 && tb && tb.inTab((pts[k - 1].s + q.s) / 2)) zz = Math.max(z, tabZ);
            if (k === 0) { if (tb && tb.inTab(1e-6)) zz = Math.max(z, tabZ); mb.feed(q.x, q.y, zz); continue; }
            if (Math.abs(mb.z - zz) > 1e-6) mb.feed(mb.x, mb.y, zz);
            mb.feed(q.x, q.y, zz);
          }
        }
        mb.up(rt);
      }
    }
  }

  /* ---------- 2D: tasca ---------- */
  function pocketRegion(op, S) {
    const P = targetEnts(op, S, e => entPoly(e).closed).map(e => entPoly(e).pts);
    if (!P.length) return [];
    return op.p.combine === 'islands' ? unionEvenOdd(P) : unionNonZero(P);
  }
  function opPocket(op, ctx) {
    const { mb, tool, S, warn } = ctx, p = op.p, r = toolGeom(tool).rAt(+p.depth || 0), rt = S.set.retract;
    if (toolGeom(tool).g === 'drill') warn.push('Una punta a forare non è adatta a svuotare tasche.');
    const ents = targetEnts(op, S, e => entPoly(e).closed);
    if (!ents.length) { warn.push('La tasca richiede forme chiuse (rettangoli, cerchi o polilinee chiuse).'); return; }
    if (p.depth > S.stock.t + 0.5) warn.push(`La profondità supera lo spessore del grezzo (${S.stock.t} mm).`);
    const region = pocketRegion(op, S);
    const so = Math.max(0.05, tool.d * clamp(+p.stepover || 40, 5, 95) / 100);
    const rings = [];
    for (let k = 0; k < 4000; k++) {
      const loops = offsetPaths(region, -(r + (+p.allow || 0) + k * so));
      if (!loops.length) break;
      loops.forEach(L => rings.push({ k, L }));
    }
    if (!rings.length) { warn.push(`L'utensile Ø${tool.d} non entra nella tasca.`); return; }
    rings.sort((a, b) => b.k - a.k);
    const zs = levels(p.depth, p.stepdown);
    let prevZ = 0;
    for (const z of zs) {
      let first = true;
      for (const ring of rings) {
        let L = ring.L; if (!p.climb) L = L.slice().reverse();
        L = rotateTo(L, mb.x, mb.y);
        const d = Math.hypot(L[0][0] - mb.x, L[0][1] - mb.y);
        if (first || d > tool.d * 0.95 || mb.z > z + 1e-6) {
          mb.travel(L[0][0], L[0][1], prevZ + 0.5, rt);
          mb.feed(L[0][0], L[0][1], z);
        } else mb.feed(L[0][0], L[0][1], z);
        for (let i = 1; i < L.length; i++) mb.feed(L[i][0], L[i][1], z);
        mb.feed(L[0][0], L[0][1], z);
        first = false;
      }
      prevZ = z;
    }
    mb.up(rt);
  }

  /* ---------- superfici del modello ---------- */
  // raggruppa i triangoli in superfici: vicini con normali entro ~30° stanno nella stessa faccia
  function groupFaces(tris) {
    const n = tris.length / 9, fid = new Int32Array(n).fill(-1), N = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = i * 9, ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2],
        vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
      let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx; const l = Math.hypot(x, y, z) || 1;
      N[i * 3] = x / l; N[i * 3 + 1] = y / l; N[i * 3 + 2] = z / l;
    }
    const vk = new Map(); let nv = 0; const q = v => Math.round(v * 1e4);
    const vid = (o) => { const k = q(tris[o]) + ',' + q(tris[o + 1]) + ',' + q(tris[o + 2]); let id = vk.get(k); if (id === undefined) { id = nv++; vk.set(k, id); } return id; };
    const V = new Int32Array(n * 3); for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) V[i * 3 + k] = vid(i * 9 + k * 3);
    const em = new Map();
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
      const a = V[i * 3 + k], b = V[i * 3 + (k + 1) % 3], key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const l = em.get(key); if (l) l.push(i); else em.set(key, [i]);
    }
    const cosT = Math.cos(30 * Math.PI / 180); let f = 0; const stack = [];
    for (let s = 0; s < n; s++) {
      if (fid[s] >= 0) continue; fid[s] = f; stack.push(s);
      while (stack.length) {
        const i = stack.pop();
        for (let k = 0; k < 3; k++) {
          const a = V[i * 3 + k], b = V[i * 3 + (k + 1) % 3], key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
          for (const j of em.get(key)) {
            if (fid[j] >= 0) continue;
            if (Math.abs(N[i * 3] * N[j * 3] + N[i * 3 + 1] * N[j * 3 + 1] + N[i * 3 + 2] * N[j * 3 + 2]) < cosT) continue;
            fid[j] = f; stack.push(j);
          }
        }
      }
      f++;
    }
    return fid;
  }
  // sezione del modello a quota z: anelli chiusi con, per ogni tratto, la superficie da cui viene
  function section(tris, fid, z) {
    const segs = [];
    for (let t = 0, i = 0; t < tris.length; t += 9, i++) {
      const P = [[tris[t], tris[t + 1], tris[t + 2] - z], [tris[t + 3], tris[t + 4], tris[t + 5] - z], [tris[t + 6], tris[t + 7], tris[t + 8] - z]];
      for (const p of P) if (Math.abs(p[2]) < 1e-9) p[2] = 1e-9;
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const a = P[k], b = P[(k + 1) % 3];
        if ((a[2] > 0) !== (b[2] > 0)) { const u = a[2] / (a[2] - b[2]); pts.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); }
      }
      if (pts.length === 2 && Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) > 1e-7) segs.push({ a: pts[0], b: pts[1], f: fid ? fid[i] : 0 });
    }
    const key = p => Math.round(p[0] * 1000) + ',' + Math.round(p[1] * 1000);
    const adj = new Map();
    segs.forEach((s, i) => { for (const k of [key(s.a), key(s.b)]) { const l = adj.get(k); if (l) l.push(i); else adj.set(k, [i]); } });
    const used = new Uint8Array(segs.length), loops = [];
    for (let s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue; used[s0] = 1;
      const pts = [segs[s0].a, segs[s0].b], fs = [segs[s0].f];
      const k0 = key(segs[s0].a);
      let cur = key(segs[s0].b), guard = 0;
      while (cur !== k0 && guard++ < segs.length) {
        const nx = (adj.get(cur) || []).find(j => !used[j]); if (nx === undefined) break;
        used[nx] = 1; const s = segs[nx];
        const far = key(s.a) === cur ? s.b : s.a;
        pts.push(far); fs.push(s.f); cur = key(far);
      }
      if (cur === k0 && pts.length > 3) { pts.pop(); loops.push({ pts, f: fs }); }
    }
    // pulizia: unisce tratti allineati della stessa superficie
    for (const L of loops) {
      const P = [], F = [];
      for (let i = 0; i < L.pts.length; i++) {
        const a = L.pts[(i - 1 + L.pts.length) % L.pts.length], b = L.pts[i], c = L.pts[(i + 1) % L.pts.length];
        const fPrev = L.f[(i - 1 + L.f.length) % L.f.length], fNext = L.f[i];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (fPrev === fNext && Math.abs(cr) < 1e-9) continue;
        P.push(b); F.push(fNext);
      }
      L.pts = P; L.f = F;
    }
    loops.forEach(L => { L.outer = loops.filter(o => o !== L && pointIn(L.pts[0], o.pts)).length % 2 === 0; });
    return loops.filter(L => L.pts.length > 2);
  }
  function pointIn(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  function modelSection(model) {
    if (!model || !model.tris || !model.tris.length) return [];
    if (model._sec && model._secVer === model.ver) return model._sec;
    let z0 = Infinity, z1 = -Infinity; for (let i = 2; i < model.tris.length; i += 3) { if (model.tris[i] < z0) z0 = model.tris[i]; if (model.tris[i] > z1) z1 = model.tris[i]; }
    model._sec = section(model.tris, model.fid, (z0 + z1) / 2); model._secVer = model.ver;
    return model._sec;
  }
  // tratti consecutivi del bordo che appartengono alle superfici selezionate
  function edgeChains(loops, sel) {
    const out = [];
    for (const L of loops) {
      const n = L.pts.length, on = L.f.map(f => sel.has(f));
      if (on.every(Boolean)) { out.push({ pts: L.pts.slice(), closed: true }); continue; }
      for (let i = 0; i < n; i++) {
        if (!on[i] || on[(i - 1 + n) % n]) continue;
        const pts = [L.pts[i]]; let k = i;
        while (on[k % n] && pts.length <= n) { pts.push(L.pts[(k + 1) % n]); k++; }
        out.push({ pts, closed: false });
      }
    }
    return out;
  }
  function bufferChains(chains, d) {
    const co = new ClipperLib.ClipperOffset(2, 0.005 * SC);
    for (const c of chains) co.AddPath(toCl(c.pts), ClipperLib.JoinType.jtRound, c.closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound);
    const sol = new ClipperLib.Paths(); co.Execute(sol, d * SC); return sol;
  }
  function blankFromModel(model, faces, A) {
    const loops = modelSection(model); if (!loops.length) return [];
    const R = unionEvenOdd(loops.map(L => L.pts));
    const sel = new Set(faces || []);
    if (!(A > 1e-6) || !sel.size) return R;
    const chains = edgeChains(loops, sel); if (!chains.length) return R;
    const co = new ClipperLib.ClipperOffset(2, 0.005 * SC);
    for (const c of chains) co.AddPath(toCl(c.pts), ClipperLib.JoinType.jtRound, c.closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenButt);
    const buf = new ClipperLib.Paths(); co.Execute(buf, A * SC);
    const cl = new ClipperLib.Clipper();
    cl.AddPaths(R.map(toCl), ClipperLib.PolyType.ptSubject, true);
    cl.AddPaths(buf, ClipperLib.PolyType.ptClip, true);
    const sol = new ClipperLib.Paths();
    cl.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftNonZero);
    return sol.map(fromCl);
  }

  /* ---------- riconoscimento di fori e tasche (2,5D, dall'alto) ----------
     Seziona il pezzo appena sotto la faccia superiore: ogni anello vuoto è un'apertura.
     Dentro ogni apertura cerca i fondi piani rivolti in alto: il più alto dà la profondità
     della tasca, poi riseziona sotto quel fondo e ripete (tasche a gradini, isole).
     Senza fondo piano: foro passante oppure cieco con punta conica. Superfici inclinate o
     curve: la zona resta alle lavorazioni 3D. */
  function recognize(model, S) {
    const t = model.tris, fid = model.fid, n = t.length / 9, d = 0.02;
    let zTop = -Infinity, zBot = Infinity;
    for (let i = 2; i < t.length; i += 3) { if (t[i] > zTop) zTop = t[i]; if (t[i] < zBot) zBot = t[i]; }
    const CX = new Float32Array(n), CY = new Float32Array(n), CZ = new Float32Array(n), MZ = new Float32Array(n), AR = new Float32Array(n), SL = new Uint8Array(n);
    const floors = new Map();
    let slopeTot = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 9, ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2], vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
      CX[i] = (t[o] + t[o + 3] + t[o + 6]) / 3; CY[i] = (t[o + 1] + t[o + 4] + t[o + 7]) / 3; CZ[i] = (t[o + 2] + t[o + 5] + t[o + 8]) / 3;
      MZ[i] = Math.min(t[o + 2], t[o + 5], t[o + 8]); AR[i] = l / 2;
      if (l < 1e-12) continue;
      const az = Math.abs(nz / l);
      if (az > 0.9995) { if (nz > 0 && CZ[i] < zTop - d && !floors.has(fid[i])) floors.set(fid[i], { z: CZ[i], x: CX[i], y: CY[i] }); }
      else if (az > 0.002) { SL[i] = 1; slopeTot += AR[i]; }
    }
    const bbOf = P => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of P) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return { x0, y0, x1, y1 }; };
    const inBB = (b, x, y) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
    const circleOf = P => {
      if (P.length < 12) return null;
      let cx = 0, cy = 0, A = 0; // baricentro d'area: non dipende da vertici doppi
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const c = P[j][0] * P[i][1] - P[i][0] * P[j][1]; A += c; cx += (P[j][0] + P[i][0]) * c; cy += (P[j][1] + P[i][1]) * c; }
      if (Math.abs(A) < 1e-9) return null; cx /= 3 * A; cy /= 3 * A;
      const rs = P.map(p => Math.hypot(p[0] - cx, p[1] - cy)), rm = rs.reduce((a, b) => a + b, 0) / rs.length;
      return rs.every(r => Math.abs(r - rm) < Math.max(0.03, rm * 0.015)) ? { cx, cy, r: rm } : null;
    };
    const feats = [], skipped3d = [];
    const explore = (H, zFrom, sec, lvl) => {
      if (lvl > 12) return;
      const bb = bbOf(H.pts);
      const fl = [...floors.values()].filter(f => f.z < zFrom - d / 2 && inBB(bb, f.x, f.y) && pointIn([f.x, f.y], H.pts));
      let minz = Infinity, slope = 0, area = 0;
      for (let i = 0; i < n; i++) {
        if (CZ[i] >= zFrom || !inBB(bb, CX[i], CY[i]) || !pointIn([CX[i], CY[i]], H.pts)) continue;
        if (MZ[i] < minz) minz = MZ[i]; area += AR[i]; if (SL[i]) slope += AR[i];
      }
      const islands = sec.filter(L => L.outer && L !== H && pointIn(L.pts[0], H.pts));
      const circ = islands.length ? null : circleOf(H.pts);
      if (!fl.length) {
        const cone = slope > area * 0.02;
        // senza fondo e senza punta conica: il foro sbuca nel vuoto (sotto una flangia) → è passante
        const through = minz <= zBot + 0.05 || !cone;
        if (!through && !circ && slope > area * 0.05) { skipped3d.push(H); return; }
        feats.push({ kind: circ ? 'hole' : 'pocket', H, islands, circ, top: zFrom, depth: through ? -minz + 0.3 : -minz, through, cone: !through && cone });
        return;
      }
      const z1 = Math.max(...fl.map(f => f.z));
      if (slope > area * 0.15 && !circ) { skipped3d.push(H); return; }
      feats.push({ kind: circ ? 'hole' : 'pocket', H, islands, circ, top: zFrom, depth: -z1, through: false, cone: false });
      const sec2 = section(t, fid, z1 - d);
      for (const L of sec2) if (!L.outer && pointIn(L.pts[0], H.pts)) explore(L, z1, sec2, lvl + 1);
    };
    const sec0 = section(t, fid, zTop - d);
    for (const L of sec0) if (!L.outer) explore(L, zTop, sec0, 0);
    // ribassi esterni (flange, spallamenti): fondi piani fuori dal contorno a quel livello
    const W = S.stock.w, Hs = S.stock.h, mg = 8;
    const cen = P => { let cx = 0, cy = 0, A = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const c = P[j][0] * P[i][1] - P[i][0] * P[j][1]; A += c; cx += (P[j][0] + P[i][0]) * c; cy += (P[j][1] + P[i][1]) * c; } return Math.abs(A) < 1e-12 ? P[0] : [cx / (3 * A), cy / (3 * A)]; };
    const exterior = (sec, zFrom, lvl) => {
      if (lvl > 12) return;
      const outs = sec.filter(L => L.outer);
      const top = outs.filter(L => !outs.some(o => o !== L && pointIn(L.pts[0], o.pts)));
      const fl = [...floors.values()].filter(f => f.z < zFrom - d / 2 && f.x > -1 && f.x < W + 1 && f.y > -1 && f.y < Hs + 1 && !top.some(L => pointIn([f.x, f.y], L.pts)));
      if (!fl.length) return;
      const z1 = Math.max(...fl.map(f => f.z));
      feats.push({ kind: 'step', H: { pts: [[-mg, -mg], [W + mg, -mg], [W + mg, Hs + mg], [-mg, Hs + mg]] }, islands: top, circ: null, top: zFrom, depth: -z1, through: false, cone: false });
      const sec2 = section(t, fid, z1 - d);
      const known = feats.filter(f => f.kind !== 'step');
      for (const L of sec2) {
        if (L.outer) continue;
        const c = cen(L.pts);
        if (known.some(f => pointIn(c, f.H.pts))) continue; // già trovata dall'alto
        explore(L, z1, sec2, lvl + 1);
      }
      exterior(sec2, z1, lvl + 1);
    };
    exterior(sec0, zTop, 0);
    // contorno esterno a fondo pezzo
    const secB = section(t, fid, zBot + d);
    const outers = secB.filter(L => L.outer && !secB.some(o => o !== L && o.outer && pointIn(L.pts[0], o.pts)));
    let modelSlope = 0, modelArea = 0; for (let i = 0; i < n; i++) { modelArea += AR[i]; if (SL[i]) modelSlope += AR[i]; }
    return { feats, outers, skipped3d, zTop, zBot, prismatic: modelSlope < modelArea * 0.01 };
  }

  /* ---------- grezzo da taglio laser ---------- */
  // sagoma del grezzo: forme assegnate (contorno + fori, regola pari/dispari) allargate del sovrametallo laser,
  // oppure sezione del modello 3D allargata solo sulle superfici di bordo selezionate
  function blankRegion(S, model) {
    if (S.stock.src === 'model' && model) return blankFromModel(model, S.stock.edgeFaces, Math.max(0, +S.stock.laserAllow || 0));
    const ids = new Set(S.stock.shape || []);
    const P = S.sketch.filter(e => ids.has(e.id)).map(e => entPoly(e)).filter(p => p.closed).map(p => p.pts);
    if (!P.length) return [];
    const R = unionEvenOdd(P), A = Math.max(0, +S.stock.laserAllow || 0);
    return A > 1e-6 ? offsetPaths(R, A) : R;
  }
  // maschera pari/dispari della regione sulla griglia (1 = materiale)
  function rasterRegion(loops, nx, ny, res) {
    const mask = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const y = j * res, xs = [];
      for (const L of loops) for (let i = 0, k = L.length - 1; i < L.length; k = i++) {
        const a = L[k], b = L[i];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] / res - 1e-9)), i1 = Math.min(nx - 1, Math.floor(xs[k + 1] / res + 1e-9));
        for (let i = i0; i <= i1; i++) mask[j * nx + i] = 1;
      }
    }
    return mask;
  }
  // contornatura del sovrametallo: profilo esterno e fori interni portati a quota in passate radiali
  // contornatura dei soli bordi selezionati del modello: percorsi aperti, con entrata e uscita in aria
  function opTrimModel(op, ctx) {
    const { mb, tool, S, warn, model } = ctx, p = op.p, r = toolGeom(tool).rAt(+p.depth || 0), rt = S.set.retract;
    const loops = modelSection(model);
    if (!loops.length) { warn.push('Non riesco a ricavare il contorno dal modello: verifica la faccia d\'appoggio.'); return; }
    const sel = new Set(S.stock.edgeFaces || []);
    if (!sel.size) { warn.push('Nessun bordo selezionato: in Grezzo scegli le superfici da contornare.'); return; }
    const chains = edgeChains(loops, sel);
    if (!chains.length) { warn.push('Le superfici selezionate non toccano il contorno a metà spessore.'); return; }
    const R = unionEvenOdd(loops.map(L => L.pts));
    const A = Math.max(0, +S.stock.laserAllow || 0);
    if (p.depth > S.stock.t + 0.5) warn.push(`La profondità supera lo spessore (${S.stock.t} mm).`);
    const step = Math.max(0.05, +p.radial || 0.5);
    const offs = []; let a = A;
    do { a = Math.max(0, a - step); offs.push(a); } while (a > 1e-6);
    const zs = levels(p.depth, p.stepdown);
    const near = (x, y) => { // punto più vicino sul bordo selezionato
      let bd = Infinity, bx = 0, by = 0;
      for (const c of chains) { const P = c.closed ? c.pts.concat([c.pts[0]]) : c.pts;
        for (let i = 1; i < P.length; i++) { const A0 = P[i - 1], B = P[i], dx = B[0] - A0[0], dy = B[1] - A0[1], L2 = dx * dx + dy * dy;
          const u = L2 ? clamp(((x - A0[0]) * dx + (y - A0[1]) * dy) / L2, 0, 1) : 0, qx = A0[0] + u * dx, qy = A0[1] + u * dy, d = Math.hypot(qx - x, qy - y);
          if (d < bd) { bd = d; bx = qx; by = qy; } } }
      return [bx, by];
    };
    let count = 0;
    for (const off of offs) {
      const d = r + off;
      const keepOut = offsetPaths(R, d - 0.01);
      const ring = bufferChains(chains, d).map(P => P.concat([P[0]]));
      const cl = new ClipperLib.Clipper();
      cl.AddPaths(ring, ClipperLib.PolyType.ptSubject, false);
      cl.AddPaths(keepOut.map(toCl), ClipperLib.PolyType.ptClip, true);
      const tree = new ClipperLib.PolyTree();
      cl.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftEvenOdd);
      let paths = ClipperLib.Clipper.OpenPathsFromPolyTree(tree).map(fromCl).filter(P => P.length > 1);
      // ricuce i pezzi che si toccano agli estremi
      for (let again = true; again;) {
        again = false;
        outer: for (let i = 0; i < paths.length; i++) for (let j = 0; j < paths.length; j++) {
          if (i === j) continue; const A1 = paths[i], B1 = paths[j], e = A1[A1.length - 1], s = B1[0];
          if (Math.hypot(e[0] - s[0], e[1] - s[1]) < 0.02) { paths[i] = A1.concat(B1.slice(1)); paths.splice(j, 1); again = true; break outer; }
        }
      }
      paths = paths.filter(P => { let L = 0; for (let i = 1; i < P.length; i++) L += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return L > 0.2; });
      for (let P of paths) {
        // concorde: il pezzo resta a destra della direzione di avanzamento
        const m = Math.max(1, Math.floor(P.length / 2)), A0 = P[m - 1], B = P[m], q = near(B[0], B[1]);
        const cr = (B[0] - A0[0]) * (q[1] - B[1]) - (B[1] - A0[1]) * (q[0] - B[0]);
        if ((cr > 0) === !!p.climb) P = P.slice().reverse();
        for (const z of zs) {
          mb.travel(P[0][0], P[0][1], 0.5, rt);
          mb.feed(P[0][0], P[0][1], z);
          for (let i = 1; i < P.length; i++) mb.feed(P[i][0], P[i][1], z);
          mb.up(rt);
        }
        count++;
      }
    }
    if (!count) warn.push(`L'utensile Ø${tool.d} non riesce a raggiungere i bordi selezionati.`);
    if (A > 0) warn.push(`Sovrametallo laser ${A} mm tolto sui bordi selezionati in ${offs.length} passat${offs.length > 1 ? 'e' : 'a'} radial${offs.length > 1 ? 'i' : 'e'}.`);
  }
  function opTrim(op, ctx) {
    if (ctx.S.stock.kind === 'profile' && ctx.S.stock.src === 'model' && (!op.targets || !op.targets.length)) {
      if (!ctx.model) { ctx.warn.push('Riapri il modello 3D per contornare i bordi selezionati.'); return; }
      return opTrimModel(op, ctx);
    }
    const { mb, tool, S, warn } = ctx, p = op.p, r = toolGeom(tool).rAt(+p.depth || 0), rt = S.set.retract;
    const ids = new Set(op.targets && op.targets.length ? op.targets : (S.stock.kind === 'profile' ? S.stock.shape || [] : []));
    const ents = S.sketch.filter(e => ids.has(e.id) && entPoly(e).closed);
    if (!ents.length) { warn.push('Imposta il grezzo come sagoma laser, oppure assegna le forme del pezzo finito.'); return; }
    const R = unionEvenOdd(ents.map(e => entPoly(e).pts));
    let A = 0;
    if (S.stock.kind === 'profile') A = Math.max(0, +S.stock.laserAllow || 0);
    else warn.push('Il grezzo non è una sagoma laser: eseguo una sola passata sul profilo finito.');
    if (p.depth > S.stock.t + 0.5) warn.push(`La profondità supera lo spessore (${S.stock.t} mm).`);
    const step = Math.max(0.05, +p.radial || 0.5);
    const offs = []; let a = A;
    do { a = Math.max(0, a - step); offs.push(a); } while (a > 1e-6);
    const zs = levels(p.depth, p.stepdown);
    const holesIn = R.filter(L => area(L) < 0).length;
    for (const off of offs) {
      let loops = offsetPaths(R, r + off);
      if (off === 0) {
        const h = loops.filter(L => area(L) < 0).length;
        if (h < holesIn) warn.push(holesIn - h > 1 ? `${holesIn - h} fori interni sono troppo piccoli per l'utensile Ø${tool.d}: non vengono ripresi.` : `1 foro interno è troppo piccolo per l'utensile Ø${tool.d}: non viene ripreso.`);
      }
      loops.sort((u, v) => area(u) - area(v)); // prima i fori interni, poi il contorno esterno
      for (let L of loops) {
        if (p.climb) L = L.slice().reverse();
        L = rotateTo(L, mb.x, mb.y);
        mb.travel(L[0][0], L[0][1], 0.5, rt);
        for (const z of zs) {
          mb.feed(L[0][0], L[0][1], z);
          for (let i = 1; i < L.length; i++) mb.feed(L[i][0], L[i][1], z);
          mb.feed(L[0][0], L[0][1], z);
        }
        mb.up(rt);
      }
    }
    if (A > 0) warn.push(`Sovrametallo laser ${A} mm tolto in ${offs.length} passat${offs.length > 1 ? 'e' : 'a'} radial${offs.length > 1 ? 'i' : 'e'}.`);
  }

  /* ---------- spianatura della faccia superiore ---------- */
  function opFace(op, ctx) {
    const { mb, tool, S, warn, model } = ctx, p = op.p, R = toolGeom(tool).R, rt = S.set.retract;
    const W = S.stock.w, H = S.stock.h, depth = Math.max(0.01, +p.depth || 0.5);
    const so = Math.max(0.1, tool.d * clamp(+p.stepover || 70, 5, 95) / 100);
    const zs = levels(depth, +p.stepdown || depth);
    const axis = p.dir === 'y' ? 'y' : 'x', A = axis === 'x' ? W : H, B = axis === 'x' ? H : W;
    const ext = R + 2, edge = Math.min(R * 0.8, B / 2), rows = [];
    for (let b = edge; b < B - edge + 1e-6; b += so) rows.push(b);
    if (!rows.length || rows[rows.length - 1] < B - edge - 1e-6) rows.push(B - edge);
    const P = (a, b) => axis === 'x' ? [a, b] : [b, a];
    for (const z of zs) {
      let fwd = true;
      const s0 = P(-ext, rows[0]); mb.travel(s0[0], s0[1], 0.5, rt); mb.feed(s0[0], s0[1], z);
      for (let k = 0; k < rows.length; k++) {
        const e = P(fwd ? A + ext : -ext, rows[k]);
        if (k) { const st = P(fwd ? -ext : A + ext, rows[k]); mb.feed(st[0], st[1], z); }
        mb.feed(e[0], e[1], z); fwd = !fwd;
      }
      mb.up(rt);
    }
    if (model) warn.push(`La spianatura toglie ${depth} mm dalla faccia superiore: il modello parte da Z0, quindi viene abbassato anche il pezzo.`);
    if (toolGeom(tool).g !== 'bull' && toolGeom(tool).g !== 'flat') warn.push('Per spianare usa uno spianatore o una fresa a testa piana.');
  }

  /* ---------- 2D: foratura ---------- */
  function opDrill(op, ctx) {
    const { mb, tool, S, warn } = ctx, p = op.p, G0 = toolGeom(tool), r = G0.R, rt = S.set.retract;
    const isDrill = G0.g === 'drill';
    let holes = targetEnts(op, S, e => e.type === 'circle');
    if (!holes.length) { warn.push('Nessun foro: disegna dei cerchi o assegnali alla foratura.'); return; }
    const depth = +p.depth + (isDrill && p.full ? G0.tipLen : 0);
    if (depth > S.stock.t + 0.5 + (isDrill ? G0.tipLen : 0)) warn.push(`La profondità supera lo spessore del grezzo (${S.stock.t} mm).`);
    const order = []; let cx = mb.x, cy = mb.y; holes = holes.slice();
    while (holes.length) {
      let bi = 0, bd = Infinity;
      holes.forEach((h, i) => { const d = Math.hypot(h.cx - cx, h.cy - cy); if (d < bd) { bd = d; bi = i; } });
      const h = holes.splice(bi, 1)[0]; order.push(h); cx = h.cx; cy = h.cy;
    }
    let small = 0, big = 0, mism = 0;
    for (const h of order) {
      const hr = h.r - r;
      if (isDrill && Math.abs(hr) > 0.03) mism++;
      else if (hr < -0.05) small++;
      if (!isDrill && hr > 0.05) {
        if (hr > r * 0.95) big++;
        const pitch = clamp(+p.pitch || r, 0.05, tool.d);
        const n = circleSegs(hr);
        mb.travel(h.cx + hr, h.cy, 0.5, rt);
        let z = 0, a = 0; const dzSeg = pitch / n;
        mb.feed(h.cx + hr, h.cy, 0);
        while (z > -depth + 1e-6) {
          a += 2 * Math.PI / n; z = Math.max(z - dzSeg, -depth);
          mb.feed(h.cx + hr * Math.cos(a), h.cy + hr * Math.sin(a), z);
        }
        for (let k = 1; k <= n; k++) { a += 2 * Math.PI / n; mb.feed(h.cx + hr * Math.cos(a), h.cy + hr * Math.sin(a), z); }
        mb.feed(h.cx, h.cy, z);
        mb.up(rt);
      } else {
        mb.travel(h.cx, h.cy, 0.5, rt);
        const pk = +p.peck > 0 ? +p.peck : depth;
        let cur = 0; const s0 = mb.m.length;
        while (cur > -depth + 1e-6) {
          const nz = Math.max(cur - pk, -depth);
          if (cur < 0) mb.rapid(h.cx, h.cy, cur + 0.3);
          mb.feed(h.cx, h.cy, nz); cur = nz;
          if (cur > -depth + 1e-6) mb.rapid(h.cx, h.cy, 0.5);
        }
        const cyc = { id: op.id + ':' + h.id, op: op.id, x: h.cx, y: h.cy, depth, peck: pk < depth - 1e-6 ? pk : 0, clear: 0.5, ret: rt, f: tool.plunge };
        for (let q = s0; q < mb.m.length; q++) mb.m[q].cyc = cyc;
        mb.up(rt);
      }
    }
    if (mism) warn.push(`${mism} for${mism > 1 ? 'i hanno' : 'o ha'} un diametro diverso dalla punta Ø${tool.d}: il foro avrà il diametro della punta.`);
    if (small) warn.push(`${small} for${small > 1 ? 'i sono più piccoli' : 'o è più piccolo'} dell'utensile Ø${tool.d}: verranno allargati.`);
    if (big) warn.push(`${big} for${big > 1 ? 'i larghi lasciano' : 'o largo lascia'} un'anima centrale: nei fori ciechi usa una Tasca.`);
  }

  /* ---------- 3D: mappa delle altezze ---------- */
  function heightmap(tris, res, W, H, bottom) {
    const nx = Math.floor(W / res) + 1, ny = Math.floor(H / res) + 1;
    const Hm = new Float32Array(nx * ny).fill(bottom);
    for (let t = 0; t < tris.length; t += 9) {
      const ax = tris[t], ay = tris[t + 1], az = tris[t + 2], bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5], cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;
      const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) / res)), i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) / res));
      const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) / res)), j1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy) / res));
      for (let j = j0; j <= j1; j++) {
        const y = j * res;
        for (let i = i0; i <= i1; i++) {
          const x = i * res;
          const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
          const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
          const z = l1 * az + l2 * bz + l3 * cz, idx = j * nx + i;
          if (z > Hm[idx]) Hm[idx] = z;
        }
      }
    }
    return { H: Hm, nx, ny, res };
  }

  function toolSurface(hm, R, hfn, bottom) {
    const { H, nx, ny, res } = hm;
    const C = new Float32Array(nx * ny).fill(-1e9);
    const k = Math.ceil(R / res);
    for (let dj = -k; dj <= k; dj++) for (let di = -k; di <= k; di++) {
      const d = Math.hypot(di, dj) * res; if (d > R + 1e-9) continue;
      const dz = -hfn(d);
      const j0 = Math.max(0, -dj), j1 = Math.min(ny, ny - dj), i0 = Math.max(0, -di), i1 = Math.min(nx, nx - di);
      for (let j = j0; j < j1; j++) {
        const row = j * nx, src = (j + dj) * nx + di;
        for (let i = i0; i < i1; i++) { const v = H[src + i] + dz; if (v > C[row + i]) C[row + i] = v; }
      }
    }
    for (let i = 0; i < C.length; i++) if (C[i] < bottom) C[i] = bottom;
    return C;
  }

  function lineIdx(nx, ny, step, axis) {
    const across = axis === 'x' ? ny : nx, out = [];
    for (let a = 0; a < across; a += step) out.push(a);
    if (out[out.length - 1] !== across - 1) out.push(across - 1);
    return out;
  }

  // collega due punti seguendo la superficie se vicini, altrimenti disimpegno rapido
  function link(mb, x, y, z, surf, hm, D, rt, rapidFloor) {
    const dist = Math.hypot(x - mb.x, y - mb.y);
    if (dist < 1e-6) { mb.feed(x, y, z); return; }
    if (dist <= 4 * D) {
      let zmax = Math.max(mb.z, z);
      const n = Math.ceil(dist / hm.res) + 1;
      for (let k = 0; k <= n; k++) {
        const px = mb.x + (x - mb.x) * k / n, py = mb.y + (y - mb.y) * k / n;
        const i = clamp(Math.round(px / hm.res), 0, hm.nx - 1), j = clamp(Math.round(py / hm.res), 0, hm.ny - 1);
        zmax = Math.max(zmax, surf(j * hm.nx + i));
      }
      if (zmax <= rt) {
        if (zmax > mb.z + 1e-6) mb.feed(mb.x, mb.y, zmax);
        mb.feed(x, y, zmax); mb.feed(x, y, z); return;
      }
    }
    mb.travel(x, y, Math.min(rt, Math.max(z + 0.5, rapidFloor)), rt);
    mb.feed(x, y, z);
  }

  function simplifyRun(pts, tol) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const u = L > 0 ? Math.hypot(b[0] - a[0], b[1] - a[1]) / L : 0;
      if (Math.abs(a[2] + (c[2] - a[2]) * u - b[2]) > tol) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function need3D(ctx) {
    if (!ctx.model || !ctx.model.tris || !ctx.model.tris.length) { ctx.warn.push('Serve un modello 3D: apri un file STEP, IGES, STL, OBJ o PLY.'); return false; }
    return true;
  }
  function pickRes(S, r) { return Math.max(r, Math.sqrt(S.stock.w * S.stock.h / 1.5e6)); }

  function opRough3d(op, ctx) {
    if (!need3D(ctx)) return;
    const { mb, tool, S } = ctx, p = op.p, r = tool.d / 2, rt = S.set.retract, bottom = -S.stock.t;
    const allow = Math.max(0, +p.allow || 0);
    const hm = ctx.getHM(pickRes(S, clamp(tool.d / 6, 0.2, 0.6)));
    const G0 = toolGeom(tool);
    const C = toolSurface(hm, r + allow, rho => G0.h(rho - allow), bottom);
    if (G0.g === 'drill') ctx.warn.push('Una punta a forare non è adatta alla sgrossatura.');
    let floor = Infinity;
    for (let i = 0; i < C.length; i++) { C[i] = Math.max(C[i] + allow, bottom); if (C[i] < floor) floor = C[i]; }
    if (floor >= -1e-3) { ctx.warn.push('Non c\'è materiale da sgrossare sopra il modello.'); return; }
    const so = Math.max(1, Math.round(tool.d * clamp(+p.stepover || 40, 5, 95) / 100 / hm.res));
    const lv = []; { let L = 0; const sd = Math.max(0.05, +p.stepdown || 1); while (L > floor + 1e-6) { L = Math.max(L - sd, floor); lv.push(L); } }
    const axis = p.dir === 'y' ? 'y' : 'x', { nx, ny, res } = hm;
    const lines = lineIdx(nx, ny, so, axis), along = axis === 'x' ? nx : ny;
    let flip = false;
    lv.forEach((L, li) => {
      const prev = li ? lv[li - 1] : 0;
      const surf = idx => Math.max(L, C[idx]);
      for (const a of lines) {
        const runs = []; let cur = null;
        for (let b = 0; b < along; b++) {
          const idx = axis === 'x' ? a * nx + b : b * nx + a;
          const z = Math.max(L, C[idx]);
          if (z < prev - 1e-4) {
            const x = (axis === 'x' ? b : a) * res, y = (axis === 'x' ? a : b) * res;
            if (!cur) { cur = []; runs.push(cur); } cur.push([x, y, z]);
          } else cur = null;
        }
        if (!runs.length) continue;
        if (flip) { runs.reverse(); runs.forEach(rn => rn.reverse()); }
        flip = !flip;
        for (const rn of runs) {
          const pts = simplifyRun(rn, 0.002);
          link(mb, pts[0][0], pts[0][1], pts[0][2], surf, hm, tool.d, rt, prev + 0.5);
          for (let k = 1; k < pts.length; k++) mb.feed(pts[k][0], pts[k][1], pts[k][2]);
        }
      }
    });
    mb.up(rt);
  }

  function opFinish3d(op, ctx) {
    if (!need3D(ctx)) return;
    const { mb, tool, S } = ctx, p = op.p, r = tool.d / 2, rt = S.set.retract, bottom = -S.stock.t;
    const G0 = toolGeom(tool);
    if (G0.g !== 'ball' && G0.g !== 'bull') ctx.warn.push('Per la finitura 3D è consigliata una fresa sferica o torica.');
    const soMM = Math.max(0.02, tool.d * clamp(+p.stepover || 10, 1, 90) / 100);
    const hm = ctx.getHM(pickRes(S, clamp(Math.min(soMM / 2, tool.d / 10), 0.08, 0.5)));
    const C = toolSurface(hm, r, G0.h, bottom);
    const { nx, ny, res, H } = hm;
    let i0 = 0, i1 = nx - 1, j0 = 0, j1 = ny - 1;
    if (p.limit) {
      let a0 = Infinity, a1 = -1, b0 = Infinity, b1 = -1;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (H[j * nx + i] < -1e-3) { if (i < a0) a0 = i; if (i > a1) a1 = i; if (j < b0) b0 = j; if (j > b1) b1 = j; }
      if (a1 < 0) { ctx.warn.push('Il modello non ha superfici sotto la faccia del grezzo.'); return; }
      const g = Math.ceil((r + res) / res);
      i0 = Math.max(0, a0 - g); i1 = Math.min(nx - 1, a1 + g); j0 = Math.max(0, b0 - g); j1 = Math.min(ny - 1, b1 + g);
    }
    const step = Math.max(1, Math.round(soMM / res));
    const axis = p.dir === 'y' ? 'y' : 'x';
    const lines = []; const A0 = axis === 'x' ? j0 : i0, A1 = axis === 'x' ? j1 : i1;
    for (let a = A0; a <= A1; a += step) lines.push(a);
    if (lines[lines.length - 1] !== A1) lines.push(A1);
    const B0 = axis === 'x' ? i0 : j0, B1 = axis === 'x' ? i1 : j1;
    const surf = idx => C[idx];
    let flip = false;
    for (const a of lines) {
      let pts = [];
      for (let b = B0; b <= B1; b++) {
        const idx = axis === 'x' ? a * nx + b : b * nx + a;
        pts.push([(axis === 'x' ? b : a) * res, (axis === 'x' ? a : b) * res, C[idx]]);
      }
      if (flip) pts.reverse(); flip = !flip;
      pts = simplifyRun(pts, 0.004);
      link(mb, pts[0][0], pts[0][1], pts[0][2], surf, hm, tool.d, rt, rt);
      for (let k = 1; k < pts.length; k++) mb.feed(pts[k][0], pts[k][1], pts[k][2]);
    }
    mb.up(rt);
  }

  const OPS = { face: opFace, profile: opProfile, pocket: opPocket, drill: opDrill, trim: opTrim, rough3d: opRough3d, finish3d: opFinish3d };
  const OP_LABEL = { face: 'Spianatura', profile: 'Contorno', pocket: 'Tasca', drill: 'Foratura', trim: 'Contornatura sovrametallo', rough3d: 'Sgrossatura 3D', finish3d: 'Finitura 3D' };

  /* ---------- programma completo ---------- */
  function buildProgram(S, model, getHM, cache) {
    const set = S.set, out = [];
    let x = 0, y = 0;
    for (const op of S.ops) {
      if (!op.on) continue;
      const warn = [], tool = S.tools.find(t => t.id === op.tool);
      if (!tool) { out.push({ op, tool: null, m: [], warn: ['Scegli un utensile.'] }); continue; }
      let m;
      const heavy = op.type === 'rough3d' || op.type === 'finish3d';
      const key = heavy ? JSON.stringify([op.type, op.p, tool, S.stock, set.retract, set.safeZ, model ? model.ver : 0]) : null;
      if (heavy && cache && cache.has(key)) { const c = cache.get(key); m = c.m; warn.push(...c.warn); }
      else {
        const mb = new MB(x, y, set.safeZ, tool);
        const ctx = { mb, tool, S, warn, model, getHM };
        try { OPS[op.type](op, ctx); } catch (err) { warn.push('Errore nel calcolo: ' + err.message); }
        mb.up(set.safeZ);
        m = mb.m;
        if (heavy && cache) cache.set(key, { m, warn: warn.slice() });
      }
      if (m.length) { const l = m[m.length - 1]; x = l.x; y = l.y; }
      out.push({ op, tool, m, warn });
    }
    return out;
  }

  function num(n) {
    let s = (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
    if (s === '-0') s = '0'; return s;
  }

  // riconosce tratti di cerchio (o d'elica) in una sequenza di G1 fitti: tolleranza 0,005 mm
  function circ3(a, b, c) {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-9) return null;
    const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
    const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    return { x, y, r: Math.hypot(a[0] - x, a[1] - y) };
  }
  function fitArc(sx, sy, sz, M, j, planar) {
    const tol = 0.005, f = M[j].f, pts = [[sx, sy, sz]], maxStep = 15 * Math.PI / 180;
    let best = null;
    for (let k = j; k < M.length && k < j + 720; k++) {
      const m = M[k]; if (m.r || m.f !== f || m.cyc || (planar && Math.abs(m.z - sz) > 1e-6)) break;
      pts.push([m.x, m.y, m.z]);
      const n = pts.length; if (n < 5) continue;
      const C = circ3(pts[0], pts[n >> 1], pts[n - 1]);
      if (!C || C.r < 0.1 || C.r > 5000) break;
      const ang = p => Math.atan2(p[1] - C.y, p[0] - C.x);
      let ok = true, dir = 0, sweep = 0, prev = ang(pts[0]); const sw = [0];
      for (let i = 1; i < n && ok; i++) {
        const p = pts[i];
        if (Math.abs(Math.hypot(p[0] - C.x, p[1] - C.y) - C.r) > tol) { ok = false; break; }
        let da = ang(p) - prev; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        if (Math.abs(da) < 1e-9 || Math.abs(da) > maxStep) { ok = false; break; }
        const sd = Math.sign(da); if (!dir) dir = sd; else if (sd !== dir) { ok = false; break; }
        sweep += da; sw.push(sweep); prev = ang(p);
      }
      if (!ok || Math.abs(sweep) > 2 * Math.PI - 0.05) break;
      const z0 = pts[0][2], z1 = pts[n - 1][2];
      for (let i = 1; i < n; i++) if (Math.abs(z0 + (z1 - z0) * sw[i] / sweep - pts[i][2]) > tol) { ok = false; break; }
      if (!ok) break;
      best = { end: k, cx: C.x, cy: C.y, ccw: dir > 0 };
    }
    return best;
  }
  /* ---------- postprocessori ----------
     grbl      GRBL 1.1 (hobby/router): niente cicli fissi, pausa M0 al cambio utensile
     linuxcnc  LinuxCNC / Mach3: T M6, G43 H, cicli G81/G83
     fanuc     Fanuc ISO: %, O, N, punto decimale obbligatorio, G28 al cambio, G43 H, G81/G83
     heidenhain Heidenhain TNC dialogo in chiaro: BEGIN PGM, BLK FORM, TOOL CALL, L/CC/C, CYCL DEF 200 */
  const POSTS = {
    grbl: { label: 'GRBL', ext: 'nc', cycles: false, helix: true },
    linuxcnc: { label: 'LinuxCNC / Mach3', ext: 'ngc', cycles: true, helix: true },
    fanuc: { label: 'Fanuc', ext: 'nc', cycles: true, helix: true },
    heidenhain: { label: 'Heidenhain TNC', ext: 'h', cycles: true, helix: false }
  };
  const ascii = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/Ø/g, 'D').replace(/[°]/g, ' GR');
  function writeGcode(S, prog) {
    const set = S.set, post = POSTS[set.post] ? set.post : 'grbl', PP = POSTS[post];
    const FA = post === 'fanuc', HH = post === 'heidenhain', ISO = !HH;
    const useCycles = PP.cycles && set.cycles !== false, arcs = set.arcs !== false;
    const cool = set.coolant || 'off';
    const L = [], pos = [];
    let hn = 0, nn = 0;
    const nStep = 10, numbered = FA && set.lineNums !== false;
    const out = (t, raw) => { if (HH && !raw) L.push(`${hn++} ${t}`); else if (numbered && !raw) { nn += nStep; if (nn > 99999) nn = nStep; L.push(`N${nn} ${t}`); } else L.push(t); };
    // formati numerici
    const fx = v => { if (FA) { let s = num(v); if (!s.includes('.')) s += '.'; return s; } if (HH) { const s = num(v); return s.startsWith('-') ? s : '+' + s; } return num(v); };
    const fF = v => FA ? Math.round(v) + '.' : String(Math.round(v));
    const G = c => FA && c < 10 ? 'G0' + c : 'G' + c;
    const cmt = t => {
      if (HH) return out('; ' + ascii(t).replace(/[;]/g, ',').slice(0, 70));
      const c = (FA ? ascii(t).toUpperCase().replace(/[^A-Z0-9 .,\-/+=:]/g, ' ') : t.replace(/[()]/g, '')).replace(/\s+/g, ' ').trim().slice(0, FA ? 60 : 120);
      out('(' + c + ')', FA);
    };
    const used = [];
    prog.forEach(sg => { if (sg.tool && sg.m.length && !used.includes(sg.tool)) used.push(sg.tool); });
    const pname = (ascii(set.file || 'pezzo').toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'PEZZO').slice(0, 16);
    const toolTxt = t => `T${t.num} ${t.name} - D${num(t.d)} ${TLABEL[t.type] || t.type}${t.cr ? ' R' + num(t.cr) : ''}` + (t.z ? ` - z${t.z} fz${num(t.fz)} Vc${num(t.vc)} - S${Math.round(t.rpm)} F${Math.round(t.feed)}` : '');
    // ---- intestazione
    if (HH) {
      out(`BEGIN PGM ${pname} MM`);
      out(`BLK FORM 0.1 Z X+0 Y+0 Z${fx(-S.stock.t)}`);
      out(`BLK FORM 0.2 X${fx(S.stock.w)} Y${fx(S.stock.h)} Z+0`);
      cmt('Truciolo CAD/CAM - zero pezzo: angolo anteriore sinistro, Z0 faccia superiore');
      used.forEach(t => cmt(toolTxt(t)));
    } else {
      if (FA) { L.push('%'); L.push(`O${String(Math.max(1, Math.min(9999, +set.progNum || 1000))).padStart(4, '0')} (${pname})`); }
      else { cmt('Truciolo CAD/CAM - fresatrice'); cmt(`Programma: ${set.file || 'pezzo'}`); }
      cmt(`Grezzo X${num(S.stock.w)} Y${num(S.stock.h)} Z${num(S.stock.t)} mm`);
      cmt(FA ? 'Zero: X0 Y0 angolo ant. sx, Z0 faccia sup.' : 'Zero pezzo: X0 Y0 angolo anteriore sinistro, Z0 faccia superiore');
      used.forEach(t => cmt(FA ? `T${t.num} D${num(t.d)} ${TLABEL[t.type] || t.type} S${Math.round(t.rpm)} F${Math.round(t.feed)}` : toolTxt(t)));
      out(FA ? 'G17 G21 G40 G49 G80 G90 G94' : (post === 'grbl' ? 'G21 G90 G17 G94' : 'G17 G21 G40 G49 G80 G90 G94'));
      if (post !== 'grbl') out('G54');
      out(`${G(0)} Z${fx(set.safeZ)}`);
    }
    let cx = 0, cy = 0, cz = set.safeZ, mode = '', cf = null, curT = null, inCyc = false, cycDef = null, cycKey = null;
    let feedLen = 0, rapidLen = 0, time = 0;
    pos.push({ x: 0, y: 0, z: set.safeZ, r: 1, line: L.length, seg: -1 });
    const endCycle = () => { if (inCyc && ISO) { out(G(80)); mode = ''; } inCyc = false; cycKey = null; };
    const spindleOn = t => {
      const S1 = Math.round(t.rpm);
      if (HH) { out(`TOOL CALL ${t.num} Z S${S1} F${Math.round(t.feed)}`); out(`L Z${fx(set.safeZ)} R0 FMAX ${cool !== 'off' ? 'M13' : 'M3'}`); return; }
      out(`S${S1} M03`.replace('M03', FA ? 'M03' : 'M3'));
      if (cool === 'flood') out(FA ? 'M08' : 'M8'); else if (cool === 'mist') out(FA ? 'M07' : 'M7');
      out(FA ? 'G04 X2.' : 'G4 P2');
    };
    prog.forEach((sg, si) => {
      if (!sg.m.length) return;
      endCycle();
      cmt(`${si + 1}. ${sg.op.name} - ${OP_LABEL[sg.op.type]}`);
      if (curT !== sg.tool) {
        const t = sg.tool;
        if (post === 'grbl') {
          if (curT) { out('M5'); if (cool !== 'off') out('M9'); out(`G0 Z${fx(set.safeZ)}`); cmt(`Cambio utensile: monta T${t.num} ${t.name}, azzera Z e riparti`); out('M0'); }
          else cmt(`Monta T${t.num} ${t.name}`);
          spindleOn(t);
        } else if (post === 'linuxcnc') {
          if (curT) { out('M5'); if (cool !== 'off') out('M9'); }
          out(`T${t.num} M6`); out(`G43 H${t.num}`); spindleOn(t);
        } else if (FA) {
          if (curT) { out('M05'); if (cool !== 'off') out('M09'); }
          out('G91 G28 Z0.'); out('G90');
          out(`T${String(t.num).padStart(2, '0')} M06`);
          out('G90 G54');
          spindleOn(t);
          out(`G00 G43 H${String(t.num).padStart(2, '0')} Z${fx(set.safeZ)}`);
        } else { // Heidenhain
          if (curT) out(`L Z${fx(set.safeZ)} R0 FMAX M5${cool !== 'off' ? ' M9' : ''}`);
          spindleOn(t);
        }
        curT = t; cf = null; mode = ''; cycDef = null;
        cz = set.safeZ;
      }
      const M = sg.m;
      // riconosce, per ogni foro, l'avvicinamento (rapido XY, discesa a 0,5) e il ritorno in disimpegno
      if (useCycles) for (let bI = 0; bI < M.length; bI++) {
        const c = M[bI].cyc; if (!c || (bI > 0 && M[bI - 1].cyc === c)) continue;
        let e = bI; while (e + 1 < M.length && M[e + 1].cyc === c) e++;
        c._b = bI; c._e = e;
        const same = m => Math.abs(m.x - c.x) < 1e-6 && Math.abs(m.y - c.y) < 1e-6;
        const dn = M[bI - 1];
        if (dn && dn.r && !dn.cyc && same(dn) && Math.abs(dn.z - c.clear) < 1e-6) {
          dn.apDown = c; const xy = M[bI - 2];
          if (xy && xy.r && !xy.cyc && same(xy) && xy.z >= c.ret - 1e-6) xy.apXY = c;
        }
        const up = M[e + 1]; if (up && up.r && same(up) && up.z > c.clear) up.afterUp = c;
      }
      const consume = (from, to) => {
        for (let q = from; q <= to; q++) {
          const p = M[q], d = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
          if (p.r) { rapidLen += d; time += d / Math.max(1, set.rapid); } else { feedLen += d; time += d / Math.max(1, p.f); }
          cx = p.x; cy = p.y; cz = p.z; pos.push({ x: cx, y: cy, z: cz, r: p.r, line: L.length, seg: si });
        }
      };
      const hhDef = (c, key) => {
        if (cycDef === key) return;
        out('CYCL DEF 200 FORATURA ~'); const q = (k, v, d, last) => out(`  ${k}=${fx(v)} ;${d}${last ? '' : ' ~'}`, true);
        q('Q200', c.clear, 'DISTANZA SICUREZZA'); q('Q201', -c.depth, 'PROFONDITA'); q('Q206', Math.round(c.f), 'AVANZ. INCREMENTO');
        q('Q202', c.peck > 0 ? c.peck : c.depth, 'PROF. INCREMENTO'); q('Q210', 0, 'TEMPO ATTESA SOPRA'); q('Q203', 0, 'COORD. SUPERFICIE');
        q('Q204', c.ret, '2. DIST. SICUREZZA'); q('Q211', 0, 'TEMPO ATTESA SOTTO', true);
        cycDef = key;
      };
      const isoCycle = (c, key) => {
        if (inCyc && cycKey === key) { out(`X${fx(c.x)} Y${fx(c.y)}`); return; }
        endCycle();
        let t = `G98 ${c.peck > 0 ? 'G83' : 'G81'} X${fx(c.x)} Y${fx(c.y)} Z${fx(-c.depth)} R${fx(c.clear)}`;
        if (c.peck > 0) t += ` Q${fx(c.peck)}`;
        t += ` F${fF(c.f)}`; out(t); inCyc = true; cycKey = key; mode = 'CYC'; cf = c.f;
      };
      for (let j = 0; j < M.length; j++) {
        const mv = M[j];
        // ---- foro con ciclo fisso: rapido XY + ciclo, senza scendere a mano
        const c0 = useCycles ? (mv.apXY || (mv.cyc && mv.cyc._b === j ? mv.cyc : null) || (mv.apDown && !(M[j - 1] && M[j - 1].apXY === mv.apDown) ? mv.apDown : null)) : null;
        if (c0) {
          const c = c0, key = [c.op, c.depth, c.peck, c.f].join('|');
          const last = (M[c._e + 1] && M[c._e + 1].afterUp === c) ? c._e + 1 : c._e;
          const zStart = cz; // piano iniziale (G98) = quota da cui parte il ciclo
          if (HH) { hhDef(c, key); out(`L X${fx(c.x)} Y${fx(c.y)} R0 FMAX M99`); }
          else isoCycle(c, key);
          consume(j, last);
          cx = c.x; cy = c.y; cz = HH ? Math.max(c.ret, zStart) : zStart;
          if (HH) cz = c.ret;
          j = last; continue;
        }
        endCycle();
        // ---- archi
        if (arcs && !mv.r) {
          const fit = fitArc(cx, cy, cz, M, j, !PP.helix);
          if (fit) {
            const e = M[fit.end];
            if (HH) {
              out(`CC X${fx(fit.cx)} Y${fx(fit.cy)}`);
              let t = `C X${fx(e.x)} Y${fx(e.y)} DR${fit.ccw ? '+' : '-'} R0`;
              if (mv.f !== cf) { t += ` F${fF(mv.f)}`; cf = mv.f; }
              out(t); mode = 'C';
            } else {
              const g = fit.ccw ? G(3) : G(2);
              let t = g + ' X' + fx(e.x) + ' Y' + fx(e.y);
              if (Math.abs(e.z - cz) > 5e-4) t += ' Z' + fx(e.z);
              t += ' I' + fx(fit.cx - cx) + ' J' + fx(fit.cy - cy);
              if (mv.f !== cf) { t += ' F' + fF(mv.f); cf = mv.f; }
              out(t); mode = g;
            }
            for (let q = j; q <= fit.end; q++) {
              const p = M[q], d = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
              feedLen += d; time += d / Math.max(1, p.f); cx = p.x; cy = p.y; cz = p.z;
              pos.push({ x: cx, y: cy, z: cz, r: 0, line: L.length, seg: si });
            }
            j = fit.end; continue;
          }
        }
        // ---- rette
        const d = Math.hypot(mv.x - cx, mv.y - cy, mv.z - cz);
        if (d < 5e-4) continue;
        let ax = '';
        if (Math.abs(mv.x - cx) > 5e-4) ax += ' X' + fx(mv.x);
        if (Math.abs(mv.y - cy) > 5e-4) ax += ' Y' + fx(mv.y);
        if (Math.abs(mv.z - cz) > 5e-4) ax += ' Z' + fx(mv.z);
        if (HH) {
          let t = 'L' + ax + ' R0';
          if (mv.r) t += ' FMAX'; else if (mv.f !== cf) { t += ' F' + fF(mv.f); cf = mv.f; }
          out(t);
        } else {
          const g = mv.r ? G(0) : G(1);
          let t = (g !== mode ? g : '') + ax;
          if (!mv.r && mv.f !== cf) { t += ' F' + fF(mv.f); cf = mv.f; }
          out(t.trim()); mode = g;
        }
        if (mv.r) { rapidLen += d; time += d / Math.max(1, set.rapid); } else { feedLen += d; time += d / Math.max(1, mv.f); }
        cx = mv.x; cy = mv.y; cz = mv.z;
        pos.push({ x: cx, y: cy, z: cz, r: mv.r, line: L.length, seg: si });
      }
    });
    endCycle();
    // ---- chiusura
    if (HH) {
      out(`L Z${fx(Math.max(cz, set.safeZ))} R0 FMAX M5${cool !== 'off' ? ' M9' : ''}`);
      out('L X+0 Y+0 R0 FMAX M30');
      out(`END PGM ${pname} MM`);
    } else if (FA) {
      if (cz < set.safeZ - 5e-4) out(`G00 Z${fx(set.safeZ)}`); out('M05'); if (cool !== 'off') out('M09');
      out('G91 G28 Z0.'); out('G90'); out('G00 X0. Y0.'); out('M30'); L.push('%');
    } else {
      if (cz < set.safeZ - 5e-4) out(`G0 Z${fx(set.safeZ)}`); out('M5'); if (cool !== 'off') out('M9'); out('G0 X0 Y0'); out('M30');
    }
    pos.push({ x: cx, y: cy, z: set.safeZ, r: 1, line: L.length - 2, seg: -1 }, { x: 0, y: 0, z: set.safeZ, r: 1, line: L.length - 1, seg: -1 });
    return { text: L.join(HH ? '\r\n' : '\n') + (HH ? '\r\n' : '\n'), lines: L, pos, feedLen, rapidLen, time, tools: used.length, ext: PP.ext, post };
  }

  /* ---------- lettori di file ---------- */
  function parseSTL(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength >= 84) {
      const n = dv.getUint32(80, true);
      if (84 + n * 50 === buf.byteLength) {
        const t = new Float32Array(n * 9);
        for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let k = 0; k < 9; k++) t[i * 9 + k] = dv.getFloat32(o + k * 4, true); }
        return t;
      }
    }
    const txt = new TextDecoder().decode(buf), v = [];
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g; let mm;
    while ((mm = re.exec(txt))) v.push(+mm[1], +mm[2], +mm[3]);
    return new Float32Array(v.slice(0, v.length - v.length % 9));
  }
  function parseOBJ(txt) {
    const V = [], out = [];
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim().split(/\s+/);
      if (s[0] === 'v') V.push([+s[1], +s[2], +s[3]]);
      else if (s[0] === 'f') {
        const idx = s.slice(1).map(q => { const i = parseInt(q.split('/')[0], 10); return i < 0 ? V.length + i : i - 1; });
        for (let k = 1; k < idx.length - 1; k++) for (const ii of [idx[0], idx[k], idx[k + 1]]) { const p = V[ii]; if (!p) continue; out.push(p[0], p[1], p[2]); }
      }
    }
    return new Float32Array(out.slice(0, out.length - out.length % 9));
  }
  function parsePLY(buf) {
    const u8 = new Uint8Array(buf);
    const headEnd = (() => { const s = new TextDecoder().decode(u8.slice(0, Math.min(u8.length, 4096))); const i = s.indexOf('end_header'); return i < 0 ? -1 : s.indexOf('\n', i) + 1; })();
    if (headEnd <= 0) throw new Error('Intestazione PLY non valida');
    const head = new TextDecoder().decode(u8.slice(0, headEnd)).split(/\r?\n/);
    const fmtL = head.find(l => l.startsWith('format')) || '';
    const els = []; let cur = null;
    for (const l of head) {
      const s = l.trim().split(/\s+/);
      if (s[0] === 'element') { cur = { name: s[1], n: +s[2], props: [] }; els.push(cur); }
      else if (s[0] === 'property' && cur) cur.props.push(s[1] === 'list' ? { list: true, ct: s[2], it: s[3], name: s[4] } : { t: s[1], name: s[2] });
    }
    const V = [], F = [];
    const size = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
    if (fmtL.includes('ascii')) {
      const tok = new TextDecoder().decode(u8.slice(headEnd)).trim().split(/\s+/).map(Number); let o = 0;
      for (const el of els) for (let i = 0; i < el.n; i++) {
        const rec = {};
        for (const p of el.props) { if (p.list) { const c = tok[o++]; rec[p.name] = tok.slice(o, o + c); o += c; } else rec[p.name] = tok[o++]; }
        if (el.name === 'vertex') V.push([rec.x, rec.y, rec.z]); else if (el.name === 'face') F.push(rec.vertex_indices || rec.vertex_index || []);
      }
    } else {
      const le = fmtL.includes('little'), dv = new DataView(buf); let o = headEnd;
      const rd = t => {
        let v;
        switch (t) {
          case 'char': case 'int8': v = dv.getInt8(o); break; case 'uchar': case 'uint8': v = dv.getUint8(o); break;
          case 'short': case 'int16': v = dv.getInt16(o, le); break; case 'ushort': case 'uint16': v = dv.getUint16(o, le); break;
          case 'int': case 'int32': v = dv.getInt32(o, le); break; case 'uint': case 'uint32': v = dv.getUint32(o, le); break;
          case 'float': case 'float32': v = dv.getFloat32(o, le); break; default: v = dv.getFloat64(o, le);
        }
        o += size[t]; return v;
      };
      for (const el of els) for (let i = 0; i < el.n; i++) {
        const rec = {};
        for (const p of el.props) { if (p.list) { const c = rd(p.ct), a = []; for (let k = 0; k < c; k++) a.push(rd(p.it)); rec[p.name] = a; } else rec[p.name] = rd(p.t); }
        if (el.name === 'vertex') V.push([rec.x, rec.y, rec.z]); else if (el.name === 'face') F.push(rec.vertex_indices || rec.vertex_index || []);
      }
    }
    const out = [];
    for (const f of F) for (let k = 1; k < f.length - 1; k++) for (const ii of [f[0], f[k], f[k + 1]]) { const p = V[ii]; if (p) out.push(p[0], p[1], p[2]); }
    return new Float32Array(out.slice(0, out.length - out.length % 9));
  }
  function occtToTris(res) {
    const out = [];
    for (const m of res.meshes || []) {
      const P = m.attributes.position.array, I = m.index ? m.index.array : null;
      if (I) for (const i of I) out.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      else for (let i = 0; i < P.length; i++) out.push(P[i]);
    }
    return new Float32Array(out.slice(0, out.length - out.length % 9));
  }

  function bulgePts(p1, p2, b) {
    const th = 4 * Math.atan(b), dx = p2[0] - p1[0], dy = p2[1] - p1[1], c = Math.hypot(dx, dy);
    if (c < 1e-9 || Math.abs(b) < 1e-9) return [];
    const r = c / (2 * Math.sin(th / 2)), h = r * Math.cos(th / 2);
    const cx = (p1[0] + p2[0]) / 2 - dy / c * h, cy = (p1[1] + p2[1]) / 2 + dx / c * h;
    const a1 = Math.atan2(p1[1] - cy, p1[0] - cx), R = Math.abs(r);
    const n = Math.max(4, Math.ceil(Math.abs(th) * R / 0.4)), out = [];
    for (let k = 1; k < n; k++) { const a = a1 + th * k / n; out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); }
    return out;
  }
  function arcPts(cx, cy, r, a0, a1) {
    let sweep = a1 - a0; while (sweep <= 0) sweep += 360;
    const n = Math.max(4, Math.ceil(sweep * Math.PI / 180 * r / 0.4)), out = [];
    for (let k = 0; k <= n; k++) { const a = (a0 + sweep * k / n) * Math.PI / 180; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return out;
  }
  function parseDXF(txt) {
    const raw = txt.split(/\r?\n/), pr = [];
    for (let i = 0; i + 1 < raw.length; i += 2) pr.push([parseInt(raw[i].trim(), 10), raw[i + 1].trim()]);
    let scale = 1;
    for (let i = 0; i < pr.length; i++) if (pr[i][0] === 9 && pr[i][1] === '$INSUNITS') { const u = +pr[i + 1][1]; scale = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 }[u] || 1; }
    let i = pr.findIndex((p, k) => p[0] === 2 && p[1] === 'ENTITIES' && pr[k - 1] && pr[k - 1][1] === 'SECTION');
    if (i < 0) i = 0;
    const ents = []; let cur = null;
    for (i++; i < pr.length; i++) {
      const [c, v] = pr[i];
      if (c === 0) { if (cur) ents.push(cur); if (v === 'ENDSEC') { cur = null; break; } cur = { type: v, g: [] }; continue; }
      if (cur) cur.g.push([c, v]);
    }
    if (cur) ents.push(cur);
    const out = []; const g1 = (e, c) => { const f = e.g.find(q => q[0] === c); return f ? parseFloat(f[1]) : 0; };
    for (let k = 0; k < ents.length; k++) {
      const e = ents[k];
      if (e.type === 'LINE') out.push({ type: 'line', x1: g1(e, 10), y1: g1(e, 20), x2: g1(e, 11), y2: g1(e, 21) });
      else if (e.type === 'CIRCLE') out.push({ type: 'circle', cx: g1(e, 10), cy: g1(e, 20), r: g1(e, 40) });
      else if (e.type === 'ARC') out.push({ type: 'poly', closed: false, pts: arcPts(g1(e, 10), g1(e, 20), g1(e, 40), g1(e, 50), g1(e, 51)) });
      else if (e.type === 'LWPOLYLINE') {
        const vs = []; let flag = 0;
        for (const [c, v] of e.g) { if (c === 10) vs.push({ x: +v, y: 0, b: 0 }); else if (c === 20 && vs.length) vs[vs.length - 1].y = +v; else if (c === 42 && vs.length) vs[vs.length - 1].b = +v; else if (c === 70) flag = +v; }
        const closed = !!(flag & 1), pts = [];
        vs.forEach((p, q) => { pts.push([p.x, p.y]); const nx = vs[q + 1] || (closed ? vs[0] : null); if (nx && p.b) pts.push(...bulgePts([p.x, p.y], [nx.x, nx.y], p.b)); });
        if (pts.length > 1) out.push({ type: 'poly', closed, pts });
      } else if (e.type === 'POLYLINE') {
        const flag = g1(e, 70), vs = [];
        while (ents[k + 1] && ents[k + 1].type === 'VERTEX') { k++; vs.push({ x: g1(ents[k], 10), y: g1(ents[k], 20), b: g1(ents[k], 42) }); }
        const closed = !!(flag & 1), pts = [];
        vs.forEach((p, q) => { pts.push([p.x, p.y]); const nx = vs[q + 1] || (closed ? vs[0] : null); if (nx && p.b) pts.push(...bulgePts([p.x, p.y], [nx.x, nx.y], p.b)); });
        if (pts.length > 1) out.push({ type: 'poly', closed, pts });
      } else if (e.type === 'SPLINE') {
        const pts = []; const fit = e.g.some(q => q[0] === 11);
        for (const [c, v] of e.g) { if (c === (fit ? 11 : 10)) pts.push([+v, 0]); else if (c === (fit ? 21 : 20) && pts.length) pts[pts.length - 1][1] = +v; }
        if (pts.length > 1) out.push({ type: 'poly', closed: !!(g1(e, 70) & 1), pts });
      } else if (e.type === 'ELLIPSE') {
        const cx = g1(e, 10), cy = g1(e, 20), mx = g1(e, 11), my = g1(e, 21), ratio = g1(e, 40) || 1;
        let t0 = g1(e, 41), t1 = e.g.some(q => q[0] === 42) ? g1(e, 42) : Math.PI * 2; if (t1 <= t0) t1 += Math.PI * 2;
        const a = Math.hypot(mx, my), ang = Math.atan2(my, mx), b = a * ratio, n = Math.max(24, Math.ceil((t1 - t0) * a / 0.4)), pts = [];
        for (let q = 0; q <= n; q++) { const t = t0 + (t1 - t0) * q / n, ex = a * Math.cos(t), ey = b * Math.sin(t); pts.push([cx + ex * Math.cos(ang) - ey * Math.sin(ang), cy + ex * Math.sin(ang) + ey * Math.cos(ang)]); }
        const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6; if (full) pts.pop();
        out.push({ type: 'poly', closed: full, pts });
      }
    }
    if (scale !== 1) out.forEach(e => scaleEnt(e, scale));
    return out;
  }
  function scaleEnt(e, s) {
    if (e.type === 'line') { e.x1 *= s; e.y1 *= s; e.x2 *= s; e.y2 *= s; }
    else if (e.type === 'circle') { e.cx *= s; e.cy *= s; e.r *= s; }
    else if (e.type === 'rect') { e.x *= s; e.y *= s; e.w *= s; e.h *= s; e.rr = (e.rr || 0) * s; }
    else if (e.type === 'poly') e.pts = e.pts.map(p => [p[0] * s, p[1] * s]);
  }
  function moveEnt(e, dx, dy) {
    if (e.type === 'line') { e.x1 += dx; e.y1 += dy; e.x2 += dx; e.y2 += dy; }
    else if (e.type === 'circle') { e.cx += dx; e.cy += dy; }
    else if (e.type === 'rect') { e.x += dx; e.y += dy; }
    else if (e.type === 'poly') e.pts = e.pts.map(p => [p[0] + dx, p[1] + dy]);
  }

  /* ---------- modello di esempio: portasapone ---------- */
  function sampleModel() {
    const W = 120, Hh = 80, T = 18, st = 0.5, nx = W / st + 1, ny = Hh / st + 1, out = [];
    const f = (x, y) => { const q = ((x - 60) / 34) ** 2 + ((y - 40) / 20) ** 2; return q < 1 ? -9 * Math.sqrt(1 - q) : 0; };
    const Z = []; for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) Z.push(f(i * st, j * st));
    const P = (i, j) => [i * st, j * st, Z[j * nx + i]];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1); out.push(...a, ...b, ...c, ...a, ...c, ...d); }
    const quad = (a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
    quad([0, 0, -T], [W, 0, -T], [W, 0, 0], [0, 0, 0]);
    quad([W, 0, -T], [W, Hh, -T], [W, Hh, 0], [W, 0, 0]);
    quad([W, Hh, -T], [0, Hh, -T], [0, Hh, 0], [W, Hh, 0]);
    quad([0, Hh, -T], [0, 0, -T], [0, 0, 0], [0, Hh, 0]);
    quad([0, 0, -T], [0, Hh, -T], [W, Hh, -T], [W, 0, -T]);
    return new Float32Array(out);
  }

  G.CAM = { POSTS, recognize, toolGeom, TLABEL, groupFaces, modelSection, edgeChains, blankRegion, rasterRegion, pocketRegion, uid, clamp, entPoly, entBBox, area, offsetPaths, buildProgram, writeGcode, heightmap, parseSTL, parseOBJ, parsePLY, parseDXF, occtToTris, scaleEnt, moveEnt, sampleModel, OP_LABEL, num };
})(typeof window !== 'undefined' ? window : globalThis);
