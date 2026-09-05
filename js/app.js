import { Graph, RT, PROFILES, makeProfile } from './router.js?v=337d1be7';
import { LANGS, makeT, floorName } from './i18n.js?v=337d1be7';
import { verticalSVG } from './icons.js?v=337d1be7';

/* 荷物と移動手段は独立した 2 軸。車椅子で特大スーツケースを持つ人もいるので、
   5 択の排他選択では組み合わせを表現できない。条件は AND で掛け合わせる。 */
const AXES = [
  { key: 'axis_luggage', state: 'luggage', ids: ['none', 'suitcase', 'xl'], prefix: 'lug_' },
  { key: 'axis_mobility', state: 'mobility', ids: ['walk', 'wheel', 'wheel_e'], prefix: 'mob_' },
];
const AXIS_ICON = {
  none: '🚶', suitcase: '🧳', xl: '🧳',
  walk: '👣', wheel: '♿', wheel_e: '♿',
};

const STORE_LANG = 'walkbavi.lang';

const KIND_ICON = { gate: '🎫', entrance: '🚪', bus: '🚌', dest: '🏬', elevator: '🛗' };
const KIND_ORDER = ['gate', 'entrance', 'bus', 'dest', 'elevator'];

const LINK_STYLE = {
  [RT.ELEVATOR]:  { color: '#0a8f5b', weight: 6, key: 'lg_ev' },
  [RT.STAIRS]:    { color: '#d0402c', weight: 3, key: 'lg_stairs' },
  [RT.ESCALATOR]: { color: '#e08a1e', weight: 3, key: 'lg_es' },
  [RT.SLOPE]:     { color: '#2b6cb0', weight: 4, key: 'lg_slope' },
};
const FLAT_STYLE = { color: '#9aa4ae', weight: 2.5, key: 'lg_flat' };

const state = {
  lang: localStorage.getItem(STORE_LANG) || (navigator.language || 'ja').slice(0, 2),
  luggage: 'suitcase',
  mobility: 'walk',
  from: null,
  to: null,
  phase: 'from',
  floor: 'all',
  navMode: false,
  navIdx: 0,
  showStairs: false,
  gps: null,
  watchId: null,
};
if (!LANGS.some((l) => l.id === state.lang)) state.lang = 'ja';

let t = makeT(state.lang);
let G = null;
let map = null;
let locateBtn = null;
let curRoute = null;   // 現在地ボタンから残距離を出すために保持する
let curSeg = null;     // いま案内している区間。地図をこれに合わせる
const layers = { net: null, route: null, poi: null, pick: null, me: null, acc: null };

/* ------------------------------------------------------------------ init */

async function boot() {
  const res = await fetch('data/kawasaki.json?v=337d1be7');
  G = new Graph(await res.json());
  initMap();
  renderAll();
}

/* 地図上のボタンは Google マップに合わせる。
   現在地は右下、その下にズーム、出典表示は左下。 */
const LOCATE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <circle cx="12" cy="12" r="4" fill="currentColor"/>
  <circle cx="12" cy="12" r="7.6" fill="none" stroke="currentColor" stroke-width="1.8"/>
  <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <path d="M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3"/>
  </g></svg>`;

function initMap() {
  map = L.map('map', { zoomControl: false, tap: true }).setView([35.5308, 139.6970], 17);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    // OSM の標準タイルは z19 まで。20 を要求すると 400 が返るので、
    // それ以上は 19 のタイルを拡大して使う。
    maxZoom: 20,
    maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const Locate = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const b = L.DomUtil.create('button', 'map-btn locate');
      b.type = 'button';
      b.innerHTML = LOCATE_ICON;
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, 'click', (e) => { L.DomEvent.stop(e); toggleLocate(); });
      locateBtn = b;
      return b;
    },
  });
  // Leaflet は下側コーナーでは後から追加したものを上に積む。
  // Google と同じく現在地をズームの上に置きたいので、ズームを先に足す。
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  new Locate().addTo(map);

  layers.net = L.layerGroup().addTo(map);
  layers.route = L.layerGroup().addTo(map);
  layers.poi = L.layerGroup().addTo(map);
}

function toggleLocate() {
  if (state.watchId != null) { stopGps(); renderAll(); return; }
  startGps(curRoute, true);
}

function paintLocateBtn() {
  if (!locateBtn) return;
  const on = state.watchId != null && state.gps && !state.gps.err;
  const err = !!(state.gps && state.gps.err);
  // className を代入すると Leaflet が付けた leaflet-control クラスまで消えて、
  // 余白の指定が効かなくなる。クラスは足し引きで操作する。
  locateBtn.classList.toggle('on', !!on);
  locateBtn.classList.toggle('err', err);
  locateBtn.title = err ? t('gps_error') : t('gps_enable');
}

/* --------------------------------------------------------------- drawing */

function visibleFloor(f) {
  return state.floor === 'all' || Math.abs(f - Number(state.floor)) < 0.01;
}

function drawNetwork() {
  layers.net.clearLayers();
  const prof = currentProfile();
  for (const L2 of G.links) {
    const a = G.nodes[L2[0]], b = G.nodes[L2[1]];
    if (!visibleFloor(a[2]) && !visibleFloor(b[2])) continue;
    const st = LINK_STYLE[L2[3]] || FLAT_STYLE;
    const blocked = !prof.allow(L2);
    L.polyline([[a[0], a[1]], [b[0], b[1]]], {
      color: st.color,
      weight: st.weight,
      opacity: blocked ? 0.75 : 0.5,
      dashArray: blocked && L2[3] !== RT.STAIRS && L2[3] !== RT.ESCALATOR ? '3,5' : null,
    }).addTo(layers.net);
  }
}

/* 荷物と移動手段の 2 軸から、いまの通行条件を作る。 */
function currentProfile() {
  return makeProfile(state.luggage, state.mobility);
}

/* 選んだ条件を 1 行で説明する。両方に条件があるときは並べて出す。 */
function profileDesc() {
  const parts = [];
  if (state.luggage !== 'none') parts.push(t('lug_' + state.luggage + '_d'));
  if (state.mobility !== 'walk') parts.push(t('mob_' + state.mobility + '_d'));
  return parts.length ? parts.join(' ＋ ') : t('cond_none');
}

function allPois() {
  return G.pois;
}

function poiName(p) {
  if (state.lang === 'ja' || !p.name_en) return p.name_ja;
  return p.name_en;
}

/*
 * 表示用の名前。改札 4 件・出入口 16 件・エレベーター 8 件は OSM に固有名が無く、
 * すべて同じ名前になる。「改札」とだけ出しても、どこの改札か分からない。
 * 種別名そのままの POI には、近くの目印を添えて区別できるようにする。
 */
function poiLabel(p) {
  const base = poiName(p);
  const near = state.lang === 'ja' ? p.near_ja : (p.near_en || p.near_ja);
  if (!near) return base;
  const generic = base === t('kind_' + p.kind);
  return generic ? t('poi_near', { n: base, m: near }) : base;
}

function drawPois() {
  layers.poi.clearLayers();
  // 経路表示中はピンが線を隠してしまうので、出発地と目的地だけ残す。
  const only = state.phase === 'route' && state.from && state.to
    ? new Set([state.from.node, state.to.node]) : null;
  for (const p of allPois()) {
    const n = G.nodes[p.node];
    if (only && !only.has(p.node)) continue;
    if (!only && !visibleFloor(n[2])) continue;
    const sel = (state.from && state.from.node === p.node) ? 'from'
      : (state.to && state.to.node === p.node) ? 'to' : '';
    const m = L.marker([n[0], n[1]], {
      icon: L.divIcon({
        className: 'poi-pin' + (sel ? ' poi-' + sel : ''),
        html: `<span>${KIND_ICON[p.kind] || '📍'}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
    });
    m.bindTooltip(poiLabel(p), { direction: 'top' });
    m.on('click', (e) => { L.DomEvent.stop(e); choose(p); });
    m.addTo(layers.poi);
  }
}

function drawRoute(r) {
  layers.route.clearLayers();
  if (!r) return;
  const pts = r.nodes.map((i) => [G.nodes[i][0], G.nodes[i][1]]);
  L.polyline(pts, { color: '#ffffff', weight: 11, opacity: 0.9 }).addTo(layers.route);
  L.polyline(pts, { color: '#1d4ed8', weight: 6, opacity: 1 }).addTo(layers.route);
  // 1基のエレベーターが複数リンクに分かれているので、近接するピンはまとめる。
  const evPins = [];
  for (const s of r.segments) {
    if (s.L[3] !== RT.ELEVATOR) continue;
    const n = G.nodes[s.to];
    if (evPins.some((q) => Math.abs(q[0] - n[0]) < 2e-4 && Math.abs(q[1] - n[1]) < 2e-4)) continue;
    evPins.push([n[0], n[1]]);
  }
  for (const p of evPins) {
    L.marker(p, {
      icon: L.divIcon({ className: 'ev-pin', html: '<span>🛗</span>', iconSize: [28, 28], iconAnchor: [14, 14] }),
    }).addTo(layers.route);
  }
  const ends = [r.nodes[0], r.nodes[r.nodes.length - 1]];
  ends.forEach((i, k) => {
    const n = G.nodes[i];
    L.marker([n[0], n[1]], {
      icon: L.divIcon({ className: 'end-pin ' + (k ? 'goal' : 'start'), html: `<span>${k ? '🏁' : '🧍'}</span>`, iconSize: [32, 32], iconAnchor: [16, 16] }),
    }).addTo(layers.route);
  });

  // 案内中はいまの区間だけ色を変えて、地図と手順を対応させる。
  if (state.navMode) {
    const i = state.navIdx;
    const s = i > 0 && i <= r.steps.length ? r.steps[i - 1] : null;
    curSeg = null;
    if (s) {
      const a = r.nodes.indexOf(s.startNode);
      const b = s.endNode != null ? r.nodes.indexOf(s.endNode) : a;
      if (a >= 0 && b >= a) {
        const seg = r.nodes.slice(a, b + 1).map((k) => [G.nodes[k][0], G.nodes[k][1]]);
        curSeg = seg;
        if (isVertical(s)) {
          // エレベーターは移動距離がほぼ無いので、線を流しても「少しずれる」だけで
          // 何が起きるか伝わらない。その場で波紋を広げて位置を示す。
          L.marker(seg[seg.length - 1], {
            icon: L.divIcon({
              className: 'ripple-pin ' + s.type,
              html: `<b>${stepIcon(s)}</b>`,
              iconSize: [34, 34], iconAnchor: [17, 17],
            }),
            interactive: false,
            zIndexOffset: 600,
          }).addTo(layers.route);
        } else {
          L.polyline(seg, { color: '#f97316', weight: 10, opacity: 1 }).addTo(layers.route);
          // 進む向きは破線を進行方向へ流して示す。線を色分けするだけでは
          // 「どちらへ進むのか」が伝わらない。
          // 歩く人のアイコンも試したが、現在地と誤解されうるので置かない。
          L.polyline(seg, {
            color: '#fff', weight: 5, opacity: 1, className: 'route-flow',
            dashArray: '9 15', lineCap: 'butt',
          }).addTo(layers.route);

          // 区間の「終わり」でする動作を、その地点に置く。
          // 手順は「歩いて、その先で曲がる」形なので、記号も終点側にある。
          const TURN_GLYPH = { left: '⬅️', right: '➡️', back: '↩️' };
          const glyph = TURN_GLYPH[s.endAction] || (s.endAction === 'goal' ? '🏁' : '');
          if (glyph) {
            L.marker(seg[seg.length - 1], {
              icon: L.divIcon({
                className: 'turn-pin', html: `<span>${glyph}</span>`,
                iconSize: [30, 30], iconAnchor: [15, 15],
              }),
              interactive: false,
              zIndexOffset: 700,
            }).addTo(layers.route);
          }

          // 曲がったあとどちらへ向かうのかを、先の 18m だけ薄く見せる。
          // 角に矢印を置くだけでは、その先が右か左か地図から読み取れない。
          if (TURN_GLYPH[s.endAction] && b < r.nodes.length - 1) {
            const lead = leadOutPath(r, b, 18);
            if (lead.length > 1) {
              L.polyline(lead, { color: '#f97316', weight: 5, opacity: 0.4 }).addTo(layers.route);
              curSeg = seg.concat(lead.slice(1));
            }
          }
        }
        // 案内文で名前を出している目印を、地図にも置く。
        // 「◯◯のところで右へ曲がる」と言われても、その◯◯が地図に無いと
        // どの角のことか分からない。名前を出したものは必ず見えるようにする。
        // 縦移動の手順は文中で目印に触れないので、地図にも出さない。
        if (!isVertical(s) && s.landmark && s.landmark.node != null) {
          const ln = G.nodes[s.landmark.node];
          L.marker([ln[0], ln[1]], {
            icon: L.divIcon({
              className: 'lm-pin',
              html: `<i></i><b>${escapeHtml(lmName(s.landmark))}</b>`,
              iconSize: [null, null], iconAnchor: [7, 7],
            }),
            interactive: false,
            zIndexOffset: 650,
          }).addTo(layers.route);
          // 目印が画面に入るように、地図の範囲にも足す
          if (curSeg) curSeg = curSeg.concat([[ln[0], ln[1]]]);
        }
      }
    }
    return; // 表示位置は focusStep が決める
  }
  curSeg = null;
  map.fitBounds(L.polyline(pts).getBounds(), { padding: [40, 40] });
}

/*
 * 曲がり角から先の `budget` メートルぶんの線を返す。
 * 角に矢印を置くだけでは、曲がったあとどちらへ向かうのかが地図から読み取れない。
 * リンク単位で進むと 1 本が長いときに行き過ぎるので、途中で切って点を作る。
 */
function leadOutPath(r, cornerIdx, budget) {
  const pts = [[G.nodes[r.nodes[cornerIdx]][0], G.nodes[r.nodes[cornerIdx]][1]]];
  let remain = budget;
  let k = cornerIdx;
  while (k < r.nodes.length - 1 && remain > 0) {
    const cur = G.nodes[r.nodes[k]];
    const next = G.nodes[r.nodes[k + 1]];
    const d = haversine(cur[0], cur[1], next[0], next[1]);
    if (d <= remain) {
      pts.push([next[0], next[1]]);
      remain -= d;
      k++;
    } else {
      const f = remain / d;
      pts.push([cur[0] + (next[0] - cur[0]) * f, cur[1] + (next[1] - cur[1]) * f]);
      remain = 0;
    }
  }
  return pts;
}

function fitWholeRoute(r) {
  if (!r || !r.nodes.length) return;
  const pts = r.nodes.map((i) => [G.nodes[i][0], G.nodes[i][1]]);
  map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 19 });
}

/* ----------------------------------------------------------------- logic */

function choose(p) {
  if (state.phase === 'from') state.from = p;
  else state.to = p;
  // 片方を選び直しただけなら、もう片方は選び直させずに経路へ戻る。
  // 出発地を変えるたびに目的地を選び直させると、案内を始められない。
  if (state.from && state.to) state.phase = 'route';
  else state.phase = state.from ? 'to' : 'from';
  // 経路が変わったので案内は最初からやり直す
  state.navMode = false;
  state.navIdx = 0;
  state.showStairs = false;
  state.floor = 'all';
  renderAll();
}

function currentRoute() {
  if (!state.from || !state.to) return { r: null, fallback: null };
  const r = G.route(state.from.node, state.to.node, currentProfile());
  const fallback = r ? null : G.route(state.from.node, state.to.node, 'any');
  return { r, fallback };
}

/* --------------------------------------------------------------- render */

function renderAll() {
  t = makeT(state.lang);
  document.documentElement.lang = state.lang;
  document.title = t('title');
  document.body.classList.toggle('nav-on', state.navMode);
  drawNetwork();
  drawPois();
  const { r, fallback } = currentRoute();
  curRoute = r;
  drawRoute(r);
  renderPanel(r, fallback);
  renderChrome();
  paintLocateBtn();
}

function renderChrome() {
  const langs = document.getElementById('langs');
  langs.innerHTML = LANGS.map((l) =>
    `<button class="lang${l.id === state.lang ? ' on' : ''}" data-lang="${l.id}">${l.label}</button>`).join('');
  langs.onclick = (e) => {
    const b = e.target.closest('[data-lang]');
    if (!b) return;
    state.lang = b.dataset.lang;
    localStorage.setItem(STORE_LANG, state.lang);
    renderAll();
  };

  document.getElementById('title').textContent = t('title');
  document.getElementById('subtitle').textContent = t('subtitle');

  const floors = ['all', ...G.meta.floors];
  document.getElementById('floors').innerHTML = floors.map((f) =>
    `<button class="floor${String(f) === String(state.floor) ? ' on' : ''}" data-floor="${f}">${f === 'all' ? t('all_floors') : floorName(state.lang, f)}</button>`).join('');
  // 案内中はフロアが自動で切り替わるので、選択中のボタンを見える位置に送る。
  const onFloor = document.querySelector('.floor.on');
  if (onFloor) onFloor.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  document.getElementById('floors').onclick = (e) => {
    const b = e.target.closest('[data-floor]');
    if (!b) return;
    state.floor = b.dataset.floor;
    renderAll();
  };
  document.getElementById('layerLabel').textContent = t('layer');


  document.getElementById('legend').innerHTML =
    `<b>${t('legend')}</b>` +
    [[FLAT_STYLE.color, 'lg_flat'], ['#0a8f5b', 'lg_ev'], ['#2b6cb0', 'lg_slope'],
     ['#d0402c', 'lg_stairs'], ['#e08a1e', 'lg_es'], ['#1d4ed8', 'lg_route']]
      .map(([c, k]) => `<span class="lg"><i style="background:${c}"></i>${t(k)}</span>`).join('');

  const s = G.meta.source;
  document.getElementById('source').innerHTML =
    `<b>${t('data_note')}</b> <a href="${s.url}" target="_blank" rel="noopener">${s.name}</a> — ${s.publisher} / ${s.license} / ${s.data_updated}` +
    `<br>POI: ${G.meta.poi_source}`;
}

function renderPanel(r, fallback) {
  const el = document.getElementById('panel');
  /* 出発地・目的地と同じ大きさのボタンにすると、どれが主な操作か分からなくなる。
     条件の切り替えは小さいピルにして、選んだものの説明だけ 1 行で出す。 */
  const prof = `<div class="profrow">
      <div class="pills">${AXES.map((a) => `
        <span class="pillgrp" role="group" aria-label="${t(a.key)}">${
          a.ids.map((id) => `<button class="pill${id === state[a.state] ? ' on' : ''}"
            data-axis="${a.state}" data-val="${id}" title="${t(a.prefix + id + '_d')}"
            ><i>${AXIS_ICON[id]}</i>${t(a.prefix + id)}</button>`).join('')
        }</span>`).join('')}</div>
      <p class="profdesc">${profileDesc()}</p>
    </div>`;

  const ctl = document.getElementById('navctl');
  if (state.navMode && r) {
    el.innerHTML = navPanel(r);
    ctl.className = 'navctl';
    ctl.innerHTML = navControls(r);
    ctl.hidden = false;
    for (const box of [el, ctl]) {
      box.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => navAction(b.dataset.act, r); });
    }
    resetScrollIfViewChanged();
    return;
  }
  // 下のバーは常に出しておく。ボタンが無いときに隠すと、そこだけ空白が空いて
  // 何を待たれているのか分からなくなる。押せるものが無いときは次にやることを書く。
  ctl.hidden = false;
  if (state.phase === 'route' && r) {
    // 経路が出ているときは「案内をはじめる」も下に固定する。
    // 手順の一覧が長いので、カード内に置くと押すのに上へ戻る必要がある。
    ctl.className = 'navctl one';
    ctl.innerHTML = `<button class="primary" data-act="nav">▶ ${t('start_nav')}</button>`;
  } else {
    ctl.className = 'navctl msg';
    ctl.innerHTML = `<p>${bottomHint(r, fallback)}</p>`;
  }

  let body = '';
  if (state.phase === 'route' && state.from && state.to) {
    body = routeCard(r, fallback);
  } else {
    body = picker();
  }

  el.innerHTML = `
    <div class="crumbs">
      <button class="crumb${state.phase === 'from' ? ' on' : ''}" data-phase="from">
        <small>${t('step_from')}</small><b>${state.from ? poiLabel(state.from) : '—'}</b></button>
      <button class="swap" data-act="swap" title="${t('swap')}">⇅</button>
      <button class="crumb${state.phase === 'to' ? ' on' : ''}" data-phase="to">
        <small>${t('step_to')}</small><b>${state.to ? poiLabel(state.to) : '—'}</b></button>
    </div>
    ${prof}
    ${body}`;

  el.querySelectorAll('[data-axis]').forEach((b) => {
    b.onclick = () => {
      state[b.dataset.axis] = b.dataset.val;
      state.navMode = false;
      state.navIdx = 0;
      renderAll();
    };
  });
  el.querySelectorAll('[data-phase]').forEach((b) => {
    b.onclick = () => { state.phase = b.dataset.phase; renderAll(); };
  });
  const sw = el.querySelector('[data-act="swap"]');
  if (sw) {
    sw.onclick = () => {
      [state.from, state.to] = [state.to, state.from];
      state.navMode = false;
      state.navIdx = 0;
      state.floor = 'all';
      if (state.from && state.to) state.phase = 'route';
      renderAll();
    };
  }
  const rs = el.querySelector('[data-act="reset"]');
  if (rs) rs.onclick = () => { state.from = state.to = null; state.phase = 'from'; stopGps(); renderAll(); };
  const nv = el.querySelector('[data-act="nav"]');
  if (nv) {
    nv.onclick = () => {
      state.navMode = true;
      state.navIdx = 0;
      syncFloor(r);
      renderAll();
      focusStep(r);
    };
  }
  const cmp = el.querySelector('[data-act="showstairs"]');
  if (cmp) { cmp.onclick = () => { state.showStairs = !state.showStairs; renderAll(); }; }
  const q = el.querySelector('#q');
  if (q) {
    q.oninput = () => renderList(q.value);
    renderList('');
  }
  const startBtn = ctl.querySelector('[data-act="nav"]');
  if (startBtn && r) {
    startBtn.onclick = () => {
      state.navMode = true;
      state.navIdx = 0;
      syncFloor(r);
      renderAll();
      focusStep(r);
    };
  }
  resetScrollIfViewChanged();
}

/* 押せるボタンが無いときに、次にやることを下のバーに出す。 */
function bottomHint(r, fallback) {
  if (state.phase === 'route' && !r) {
    return fallback ? t('hint_no_route') : t('hint_unreachable');
  }
  if (!state.from && !state.to) return t('hint_pick_both');
  if (!state.from) return t('hint_pick_from');
  if (!state.to) return t('hint_pick_to');
  return t('hint_pick_both');
}

/* 出発地・目的地を選んだ直後、一覧をスクロールした位置のままだと
   経路カードの上の方が画面外に残る。表示が切り替わったら先頭に戻す。 */
let lastView = '';
function resetScrollIfViewChanged() {
  const view = `${state.phase}|${state.navMode}|${state.from ? state.from.id : ''}|${state.to ? state.to.id : ''}`;
  if (view === lastView) return;
  lastView = view;
  window.scrollTo({ top: 0 });
}

/* 案内中は手順が変わるたびに先頭へ戻す。
   ページ全体がスクロールするので、下の方を見ていると地図と手順が同時に見えなくなる。 */
function scrollToMap() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function picker() {
  return `<div class="pick">
      <input id="q" type="search" placeholder="${t('search')}" autocomplete="off">
      <div id="list" class="list"></div>
      <p class="hint">${t('pick_on_map')}</p>
    </div>`;
}

/* 一覧が長すぎると地図が押し出されて現在地を見失うので、
   グループごとに既定 6 件までにして「もっと見る」で伸ばす。 */
const PAGE = 6;
const expanded = new Set();

function renderList(query) {
  const list = document.getElementById('list');
  if (!list) return;
  const q = (query || '').trim().toLowerCase();
  const groups = {};
  for (const p of allPois()) {
    if (p.kind === 'elevator') continue; // 目的地ではなく地図上の目印
    const name = (p.name_ja + ' ' + (p.name_en || '') + ' ' + (p.ref || '')).toLowerCase();
    if (q && !name.includes(q)) continue;
    (groups[p.kind] = groups[p.kind] || []).push(p);
  }
  const order = KIND_ORDER.filter((k) => groups[k]);
  list.innerHTML = order.map((k) => {
    const all = groups[k];
    const open = q || expanded.has(k);
    const shown = open ? all : all.slice(0, PAGE);
    const more = all.length - shown.length;
    return `<div class="grp"><h4>${KIND_ICON[k] || '📍'} ${t('kind_' + k) || k} <span>${all.length}</span></h4>
      <div class="cards">${shown.map((p) => card(p)).join('')}</div>
      ${more > 0 ? `<button class="more" data-more="${k}">+${more}</button>` : ''}
    </div>`;
  }).join('') || `<p class="hint">—</p>`;
  list.querySelectorAll('[data-poi]').forEach((b) => {
    b.onclick = () => {
      const p = allPois().find((x) => x.id === b.dataset.poi);
      if (p) choose(p);
    };
  });
  list.querySelectorAll('[data-more]').forEach((b) => {
    b.onclick = () => { expanded.add(b.dataset.more); renderList(query); };
  });
}

function card(p) {
  const n = G.nodes[p.node];
  const badge = p.verified ? '' : `<em title="${t('unverified_warn')}">${t('unverified')}</em>`;
  return `<button class="card" data-poi="${p.id}">
      <span class="ic">${KIND_ICON[p.kind] || '📍'}</span>
      <span class="tx"><b>${poiLabel(p)}${p.ref ? ' <u>' + p.ref + '</u>' : ''}</b>
      <small>${floorName(state.lang, n[2])}</small></span>${badge}
    </button>`;
}

function routeCard(r, fallback) {
  if (!r) {
    // 段差ゼロで行けないときは、階段を含む経路を「どこに階段があるか」も含めて見せる。
    // 使えないと伝えるだけでは、その場で判断できない。
    const stairs = fallback && state.showStairs
      ? `<ol class="steps">
          <li class="s-start"><i>🧍</i><span><b>${t('inst_start')}</b><small>${poiLabel(state.from)}</small></span></li>
          ${fallback.steps.map((s) => stepRow(s)).join('')}
          <li class="s-goal"><i>🏁</i><span><b>${t('inst_goal')}</b><small>${poiLabel(state.to)}</small></span></li>
        </ol>` : '';
    return `<div class="card-out bad">
        <h3>⚠️ ${t('no_route')}</h3>
        <p>${t('no_route_hint')}</p>
        ${fallback ? `<p class="cmp">${t('compare')}: ${fallback.meters}${t('meters')} / ${fallback.minutes}${t('minutes')}</p>
          <button class="ghost wide" data-act="showstairs">${state.showStairs ? '▲ ' : '▼ '}${t('show_stairs')}</button>` : ''}
        ${stairs}
        <button class="ghost" data-act="reset">${t('reset')}</button>
      </div>`;
  }
  const steps = G.meta.codes.lev_diff[r.worstStep] || '—';
  const width = G.meta.codes.width[r.minWidth] || '—';
  const chips = [
    `<span class="chip big">${r.minutes}<small>${t('minutes')}</small></span>`,
    `<span class="chip">${r.meters}<small>${t('meters')}</small></span>`,
    `<span class="chip ev">🛗 ${r.elevators}<small>${t('times')}</small></span>`,
    `<span class="chip">${Math.max(0, r.floors.length - 1)}<small>${t('floors_changed')}</small></span>`,
    `<span class="chip">${steps}<small>${t('max_step')}</small></span>`,
    `<span class="chip">${width}<small>${t('min_width')}</small></span>`,
  ].join('');
  const unverified = (!state.from.verified || !state.to.verified);
  return `<div class="card-out">
      <h3>${t('result')}</h3>
      <div class="chips">${chips}</div>
      <ol class="steps">
        <li class="s-start"><i>🧍</i><span><b>${t('inst_start')}</b><small>${poiLabel(state.from)}</small></span></li>
        ${r.steps.map((s) => stepRow(s)).join('')}
        <li class="s-goal"><i>🏁</i><span><b>${t('inst_goal')}</b><small>${poiLabel(state.to)}</small></span></li>
      </ol>
      <div class="warn"><b>⚠️ ${t('warn_title')}</b><p>${t('warn_body')}</p>
        ${unverified ? `<p>※ ${t('unverified_warn')}</p>` : ''}</div>
      <button class="ghost" data-act="reset">${t('reset')}</button>
    </div>`;
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function lmName(lm) {
  if (!lm) return '';
  return state.lang === 'ja' ? lm.name_ja : (lm.name_en || lm.name_ja);
}

const VERT_KEY = { elevator: 'inst_elevator', escalator: 'inst_escalator', stairs: 'inst_stairs' };

function isVertical(s) {
  return s && VERT_KEY[s.type] !== undefined;
}

/** 縦移動のイラスト。文字が読めなくても何をするか伝わるようにする。 */
function illust(s) {
  if (!isVertical(s)) return '';
  return `<div class="illust">${verticalSVG(
    s.type, floorName(state.lang, s.fromFloor), floorName(state.lang, s.toFloor),
    s.toFloor > s.fromFloor)}</div>`;
}

/*
 * 手順の文。「歩いて、その先で◯◯する」という形にする。
 *
 * 「曲がってから歩く」形だと、歩いている間ずっと画面がすでに済んだ動作を指し、
 * 次に何をするのかが分からない。カーナビが「500m先を右折」と言うのと同じ理由で、
 * これから来る動作を先に見せる。
 */
const END_ACT_KEY = {
  left: 'inst_left', right: 'inst_right', back: 'inst_back',
  elevator: 'inst_to_elevator', escalator: 'inst_to_escalator', stairs: 'inst_to_stairs',
  crossing: 'inst_crossing',
};

/** 区間の終わりでする動作の文（「NewDays のところで右へ曲がる」など） */
function endActionText(s) {
  const key = END_ACT_KEY[s.endAction];
  if (!key) return '';
  const base = t(key);
  // 曲がるときだけ目印を添える。距離だけでは現地で照合できない。
  const lm = lmName(s.landmark);
  const isTurn = s.endAction === 'left' || s.endAction === 'right' || s.endAction === 'back';
  return lm && isTurn ? t('inst_at_landmark', { lm, act: base }) : base;
}

function stepText(s) {
  if (isVertical(s)) {
    return t(VERT_KEY[s.type], {
      a: floorName(state.lang, s.fromFloor), b: floorName(state.lang, s.toFloor),
    });
  }
  if (s.type === 'crossing') return t('inst_crossing');
  if (s.endAction === 'goal') return t('inst_walk_goal', { m: s.meters });
  const act = endActionText(s);
  if (!act) return t('inst_straight');
  // ほとんど歩かない区間で「1m 進み、右へ曲がる」と出すと回りくどい。
  // その場で曲がるだけなので、距離は省く。
  if (s.meters < 5) return act;
  return t('inst_walk_then', { m: s.meters, act });
}

function stepIcon(s) {
  if (s.type === 'elevator') return '🛗';
  if (s.type === 'escalator') return '🛝';
  if (s.type === 'stairs') return '🪜';
  if (s.type === 'crossing') return '🚦';
  // 記号は「区間の終わりでする動作」を指す
  return {
    left: '⬅️', right: '➡️', back: '↩️',
    elevator: '🛗', escalator: '🛝', stairs: '🪜', crossing: '🚦', goal: '🏁',
  }[s.endAction] || '⬆️';
}

function stepRow(s) {
  if (isVertical(s)) {
    return `<li class="s-ev"><i>${stepIcon(s)}</i><span><b>${stepText(s)}</b>
      ${s.accessible ? `<small>${t('ev_accessible')}</small>` : ''}
      ${illust(s)}</span></li>`;
  }
  return `<li><i>${stepIcon(s)}</i><span><b>${stepText(s)}</b>
    <small>${floorName(state.lang, s.floor)}</small></span></li>`;
}

/* ------------------------------------------------------------- nav mode */

/*
 * 屋内では GPS が使えない（誤差数十mで階も取れない）。
 * そこで「1手順ずつ、利用者がタップで進める」方式を主とし、
 * データ上 施設外(in_out=1) の区間に限って現在地を補助的に表示する。
 */
function navPanel(r) {
  const total = r.steps.length + 2;      // 出発 + 手順 + 到着
  const i = state.navIdx;
  const isStart = i === 0;
  const isGoal = i === total - 1;
  const s = isStart || isGoal ? null : r.steps[i - 1];
  const next = i < total - 2 ? r.steps[i] : null;

  const icon = isStart ? '🧍' : isGoal ? '🏁' : stepIcon(s);
  const main = isStart ? t('inst_start') : isGoal ? t('inst_goal') : stepText(s);
  let sub;
  if (isStart) sub = poiLabel(state.from);
  else if (isGoal) sub = poiLabel(state.to);
  else if (isVertical(s)) sub = s.accessible ? t('ev_accessible') : '';
  else sub = floorName(state.lang, s.floor);

  const canGps = s ? s.outdoor : true;
  const gps = state.gps;
  let gpsLine;
  if (!canGps) {
    gpsLine = `<div class="gps off">📵 ${t('gps_indoor')}</div>`;
  } else if (gps && gps.err) {
    gpsLine = `<div class="gps off">📵 ${t('gps_error')}</div>`;
  } else if (gps) {
    gpsLine = `<div class="gps on">📍 ${t('gps_dist', { m: gps.toStep })} (±${Math.round(gps.acc)}m)</div>`;
  } else {
    gpsLine = `<button class="ghost small" data-act="gps">📍 ${t('gps_enable')}</button>`;
  }

  return `<div class="nav">
      <div class="navbar">
        <button class="ghost small" data-act="exitnav">✕</button>
        <div class="prog"><span style="width:${(100 * i) / (total - 1)}%"></span></div>
        <b>${i + 1} / ${total}</b>
      </div>
      <div class="navmain">
        <div class="navicon">${icon}</div>
        <div class="navtx"><b>${main}</b>${sub ? `<small>${sub}</small>` : ''}</div>
      </div>
      ${illust(s)}
      ${next ? `<div class="navnext">${t('then')}: ${stepIcon(next)} ${stepText(next)}</div>` : ''}
      ${gpsLine}
    </div>`;
}

/* 操作ボタンはスクロール領域の外に固定する。手順によってカードの高さが変わるので、
   カード内に置くとボタンの位置が上下してしまい押しにくい。 */
function navControls(r) {
  const i = state.navIdx;
  const isGoal = i === r.steps.length + 1;
  return `<button class="ghost" data-act="prev" ${i === 0 ? 'disabled' : ''}>◀ ${t('prev')}</button>
    <button class="primary" data-act="next" ${isGoal ? 'disabled' : ''}>${t('next')} ▶</button>`;
}

function navAction(act, r) {
  const total = r.steps.length + 2;
  if (act === 'next') state.navIdx = Math.min(total - 1, state.navIdx + 1);
  else if (act === 'prev') state.navIdx = Math.max(0, state.navIdx - 1);
  else if (act === 'exitnav') {
    state.navMode = false;
    state.floor = 'all';   // 案内をやめたら地図の絞り込みも戻す
    stopGps();
  } else if (act === 'gps') { startGps(r, true); return; }
  syncFloor(r);
  renderAll();
  focusStep(r);
  if (act === 'next' || act === 'prev') scrollToMap();
}

/* 案内中は地図のフロア表示を、いま歩いているフロアに合わせる。
   別の階の通路が重なって見えていると、地図と現地が対応しない。 */
function syncFloor(r) {
  if (!state.navMode) return;
  const i = state.navIdx;
  let f;
  if (i === 0) f = G.nodes[state.from.node][2];
  else if (i >= r.steps.length + 1) f = G.nodes[state.to.node][2];
  else {
    const s = r.steps[i - 1];
    // 縦移動の手順では、着く側のフロアを見せたほうが次の行動に繋がる
    f = isVertical(s) ? s.toFloor : s.floor;
  }
  if (f != null) state.floor = String(f);
}

/* いま案内している区間が地図に収まるようにする。
   中心を合わせるだけだと、長い区間の反対側が画面外に出て経路が切れて見える。 */
function focusStep(r) {
  if (curSeg && curSeg.length > 1) {
    const b = L.latLngBounds(curSeg);
    if (b.isValid() && !b.getNorthEast().equals(b.getSouthWest())) {
      // 右下には現在地とズームのボタンが乗っている。均等な余白だと曲がり角が
      // ボタンの下に隠れることがあるので、右下だけ広く取る。
      map.fitBounds(b, {
        paddingTopLeft: [40, 30], paddingBottomRight: [72, 56],
        maxZoom: 19, animate: true,
      });
      return;
    }
  }
  const i = state.navIdx;
  let node;
  if (i === 0) node = state.from.node;
  else if (i >= r.steps.length + 1) node = state.to.node;
  else node = r.steps[i - 1].startNode;
  if (node == null) return;
  const n = G.nodes[node];
  map.setView([n[0], n[1]], Math.max(map.getZoom(), 18), { animate: true });
}

/* GPS は施設外の区間でしか信用できない。屋内では誤差数十mで階も取れないため、
   位置は「次の曲がり角まであと何m」の補助表示にとどめ、案内の主導権はタップに置く。 */
function startGps(r, recenter) {
  if (!navigator.geolocation) { state.gps = { err: true }; renderAll(); return; }
  stopGps();
  let first = true;
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
      let toStep = null;
      if (r) {
        const i = state.navIdx;
        const step = i > 0 && i <= r.steps.length ? r.steps[i - 1] : null;
        const target = step ? G.nodes[step.endNode != null ? step.endNode : step.startNode]
          : G.nodes[i === 0 ? state.from.node : state.to.node];
        if (target) toStep = Math.round(haversine(lat, lon, target[0], target[1]));
      }
      state.gps = { lat, lon, acc, toStep };
      drawMe();
      if (first && recenter) { map.setView([lat, lon], Math.max(map.getZoom(), 18)); first = false; }
      renderAll();
    },
    () => { state.gps = { err: true }; renderAll(); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
  renderAll();
}

function stopGps() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.gps = null;
  for (const k of ['me', 'acc']) {
    if (layers[k]) { layers[k].remove(); layers[k] = null; }
  }
}

function drawMe() {
  if (!state.gps || state.gps.err) return;
  const { lat, lon, acc } = state.gps;
  if (layers.me) layers.me.remove();
  if (layers.acc) layers.acc.remove();
  // 精度の円を出す。屋内では数十mになるので、点だけ出すと過信させる。
  layers.acc = L.circle([lat, lon], {
    radius: Math.min(acc || 0, 120), color: '#1d4ed8', weight: 1,
    fillColor: '#1d4ed8', fillOpacity: 0.12,
  }).addTo(map);
  layers.me = L.circleMarker([lat, lon], {
    radius: 8, color: '#fff', weight: 3, fillColor: '#1d4ed8', fillOpacity: 1,
  }).addTo(map);
}

function haversine(y1, x1, y2, x2) {
  const p = Math.PI / 180;
  return 6371000 * 2 * Math.asin(Math.sqrt(
    Math.sin((y2 - y1) * p / 2) ** 2 +
    Math.cos(y1 * p) * Math.cos(y2 * p) * Math.sin((x2 - x1) * p / 2) ** 2));
}

boot();
