/*
 * router.js — 歩行空間ネットワークデータ(NWD)上の経路探索
 *
 * データ配列の形（build_kawasaki.py と対応）:
 *   nodes[i] = [lat, lon, floor, in_out]
 *   links[j] = [a, b, dist, route_type, lev_diff, vtcl_slope, width, elevator, rt_struct, roof]
 *
 * 経路種別 route_type: 1=通路 2=動く歩道 3=踏切 4=エレベーター 5=エスカレーター 6=階段 7=スロープ
 * 段差 lev_diff:  1=0cm 2=0-2cm 3=2-5cm 4=5-10cm 5=10cm超
 * 縦断勾配 vtcl_slope: 1=0% 2=0-5% 3/4=5-8% 5/6=8-18% 7/8=18%超
 * 幅員 width: 1=1.0m未満 2=1.0-2.0m 3=2.0-3.0m 4=3.0m以上
 */

export const RT = { PASSAGE: 1, WALKWAY: 2, CROSSING: 3, ELEVATOR: 4, ESCALATOR: 5, STAIRS: 6, SLOPE: 7 };

/*
 * 通行プロファイル。
 *
 * エレベーターを幅員・勾配のふるいから必ず除外すること。NWD ではエレベーターの
 * 幅員は「扉の幅」として記録されており、川崎駅では 77 本中 54 本が width=1
 * (1.0m未満) になっている。ここを素通しにしないと EV の 7 割が落ちて
 * 段差ゼロ経路が繋がらなくなる。
 */
/*
 * ランク区分（仕様 表3.3）。links[10] に「幅員・縦断勾配・段差」の順で3文字。
 *   S = 2m以上 / 0%      / 0cm
 *   A = 1m以上~2m未満 / 0~5%   / 0~2cm   … 移動等円滑化ガイドライン適合
 *   B = －          / 5~8%   / 2~5cm   … 電動車椅子で通行可能
 *   C = 1m未満      / 8~18%  / 5~10cm  … 一部モビリティで通行可能
 *   Z = 通行不可,  X = 不明
 * 車椅子の可否はこのランクで判定するのが仕様に沿っていて確実。
 */
const RANK_ORDER = { S: 0, A: 1, B: 2, C: 3, Z: 9, X: 9 };

function rankOk(L, maxRank) {
  const r = L[10] || 'XXX';
  for (let i = 0; i < 3; i++) {
    // エレベーターの幅員は「扉の幅」なので幅員ランクは見ない（54/77 が Z になる）
    if (i === 0 && L[3] === RT.ELEVATOR) continue;
    if ((RANK_ORDER[r[i]] ?? 9) > maxRank) return false;
  }
  return true;
}

/*
 * 通行条件は「荷物」と「移動手段」の 2 軸で決める。
 * 車椅子で特大スーツケースを持っている人もいるので、
 * 5 択の排他選択にすると組み合わせが表現できない。
 * 実際の可否は 2 つの条件の AND（厳しい方）になる。
 */
export const LUGGAGE = {
  // 荷物なし: 段差ゼロであること以外の制約は付けない
  none: () => true,
  // スーツケース: 段差 ≤2cm・勾配 ≤8%・幅員 ≥1.0m
  suitcase: (L) => L[4] <= 2 && L[5] <= 4 && L[6] >= 2,
  // 特大: 幅員 ≥2.0m
  xl: (L) => L[4] <= 2 && L[5] <= 4 && L[6] >= 3,
};

export const MOBILITY = {
  walk: () => true,
  // 手動車椅子: 移動等円滑化ガイドライン適合（3ランクとも S か A）
  wheel: (L) => rankOk(L, RANK_ORDER.A),
  // 電動車椅子: 仕様上 B まで通行可能（勾配 5~8%、段差 2~5cm）
  wheel_e: (L) => rankOk(L, RANK_ORDER.B),
};

/** 車椅子で使えるエレベーターか（種別 3=車椅子, 5=車椅子・視覚障害者）。 */
function elevatorUsable(L, mobility) {
  if (mobility === 'walk') return true;
  return L[7] === 3 || L[7] === 5;
}

/** 荷物 × 移動手段からプロファイルを作る。 */
export function makeProfile(luggage, mobility) {
  const lug = LUGGAGE[luggage] || LUGGAGE.none;
  const mob = MOBILITY[mobility] || MOBILITY.walk;
  return {
    id: `${luggage}+${mobility}`,
    luggage,
    mobility,
    allow(L) {
      if (L[3] === RT.STAIRS || L[3] === RT.ESCALATOR) return false;
      // エレベーターの幅員は「扉の幅」なので、荷物の幅の条件は当てはめない。
      // 車椅子のときだけ、車椅子対応であることを求める。
      if (L[3] === RT.ELEVATOR) return elevatorUsable(L, mobility);
      return lug(L) && mob(L);
    },
  };
}

export const PROFILES = {
  any: { id: 'any', allow: () => true },
  stepfree: { id: 'stepfree', allow: (L) => L[3] !== RT.STAIRS && L[3] !== RT.ESCALATOR },
};

/** プロファイルは id 文字列でも { allow } オブジェクトでも受け取る。 */
function asProfile(p) {
  if (p && typeof p.allow === 'function') return p;
  return PROFILES[p] || PROFILES.any;
}

/* エレベーターは待ち時間があるので距離換算のペナルティを足す。
   これが無いと「EV を何度も乗り換える」不自然な経路が出る。 */
const ELEVATOR_PENALTY_M = 25;
const CROSSING_PENALTY_M = 15; // 横断歩道は信号待ちがある

export class Graph {
  constructor(doc) {
    this.meta = doc.meta;
    this.nodes = doc.nodes;
    this.links = doc.links;
    this.pois = doc.pois || [];
    this.adj = new Array(this.nodes.length);
    for (let i = 0; i < this.nodes.length; i++) this.adj[i] = [];
    this.links.forEach((L, j) => {
      this.adj[L[0]].push(j);
      this.adj[L[1]].push(j);
    });
    // 目印。距離だけの案内（「18m進んで右」）は現地で照合できないので、
    // 曲がる地点の近くにある店舗や建物の名前を添えるために引く。
    this.lm = new Map();
    for (const m of doc.landmarks || []) {
      if (!this.lm.has(m.node)) this.lm.set(m.node, m);
    }
  }

  /** ノード n の位置にある目印。無ければ 1 ホップ隣まで探す。 */
  landmarkAt(n) {
    if (this.lm.has(n)) return this.lm.get(n);
    for (const j of this.adj[n]) {
      const L = this.links[j];
      const v = L[0] === n ? L[1] : L[0];
      if (L[2] <= 25 && this.lm.has(v)) return this.lm.get(v);
    }
    return null;
  }

  cost(L) {
    let c = L[2];
    if (L[3] === RT.ELEVATOR) c += ELEVATOR_PENALTY_M;
    if (L[3] === RT.CROSSING) c += CROSSING_PENALTY_M;
    if (L[5] >= 5) c += L[2] * 0.5; // 8%超の勾配は体感距離を割り増し
    return c;
  }

  /** ダイクストラ。到達不能なら null。 */
  route(from, to, profile) {
    const prof = asProfile(profile);
    const n = this.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prevNode = new Int32Array(n).fill(-1);
    const prevLink = new Int32Array(n).fill(-1);
    dist[from] = 0;
    const pq = new MinHeap();
    pq.push(0, from);
    while (pq.size) {
      const [d, u] = pq.pop();
      if (d > dist[u]) continue;
      if (u === to) break;
      for (const j of this.adj[u]) {
        const L = this.links[j];
        if (!prof.allow(L)) continue;
        const v = L[0] === u ? L[1] : L[0];
        const nd = d + this.cost(L);
        if (nd < dist[v]) {
          dist[v] = nd;
          prevNode[v] = u;
          prevLink[v] = j;
          pq.push(nd, v);
        }
      }
    }
    if (!isFinite(dist[to])) return null;

    const path = [];
    for (let v = to; v !== from; v = prevNode[v]) path.push(prevLink[v]);
    path.reverse();
    return this.describe(from, path);
  }

  describe(from, linkIdx) {
    let cur = from;
    const segs = [];
    let meters = 0;
    let worstStep = 1;
    let minWidth = 4;
    const floors = [];
    for (const j of linkIdx) {
      const L = this.links[j];
      const next = L[0] === cur ? L[1] : L[0];
      meters += L[2];
      if (L[3] !== RT.ELEVATOR) {
        worstStep = Math.max(worstStep, L[4] === 99 ? worstStep : L[4]);
        minWidth = Math.min(minWidth, L[6] === 99 ? minWidth : L[6]);
      }
      const f = this.nodes[next][2];
      if (!floors.length || floors[floors.length - 1] !== f) floors.push(f);
      segs.push({ link: j, from: cur, to: next, L });
      cur = next;
    }
    const steps = this.instructions(from, segs);
    // 乗車回数は「まとめたあとの EV 手順の数」で数える。リンク数で数えると
    // 1 基のエレベーターが複数回に見える。
    const elevators = steps.filter((s) => s.type === 'elevator').length;
    return {
      segments: segs,
      nodes: [from, ...segs.map((s) => s.to)],
      meters: Math.round(meters),
      minutes: Math.max(1, Math.round(meters / 60 + elevators * 1.5)), // 大荷物で 60m/分、EV 待ち 1.5分
      elevators,
      worstStep,
      minWidth,
      floors,
      steps,
    };
  }

  /** 曲がり角とフロア移動をまとめて、手順のリストにする。 */
  instructions(from, segs) {
    const out = [];
    let run = null;
    const flush = () => { if (run) { out.push(run); run = null; } };
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const rt = s.L[3];
      // 縦移動（EV / ES / 階段）は水平移動と分けて 1 手順にする。
      // 階段とエスカレーターは段差ゼロ経路には出ないが、
      // 「階段を含む経路」を比較表示するときに使う。
      const VERT = { [RT.ELEVATOR]: 'elevator', [RT.ESCALATOR]: 'escalator', [RT.STAIRS]: 'stairs' };
      if (VERT[rt]) {
        flush();
        out.push({
          type: VERT[rt],
          meters: rt === RT.ELEVATOR ? 0 : s.L[2],
          fromFloor: this.nodes[s.from][2],
          toFloor: this.nodes[s.to][2],
          accessible: rt === RT.ELEVATOR && s.L[7] >= 3,
          at: this.nodes[s.to],
          startNode: s.from,
          endNode: s.to,
          landmark: this.landmarkAt(s.from),
        });
        continue;
      }
      const turn = i > 0 ? this.turnAt(segs[i - 1], s) : null;
      if (run && turn && turn !== 'straight') flush();
      if (!run) {
        run = {
          type: rt === RT.CROSSING ? 'crossing' : 'walk',
          meters: 0, turn,
          at: this.nodes[s.from],
          floor: this.nodes[s.from][2],
          outdoor: this.nodes[s.from][3] === 1, // 施設外なら GPS が期待できる
          startNode: s.from,
          landmark: this.landmarkAt(s.from),
        };
      }
      run.meters += s.L[2];
      run.at2 = this.nodes[s.to];
      run.endNode = s.to;
    }
    flush();
    return mergeShort(out).map((o) => ({ ...o, meters: Math.round(o.meters) }));
  }

  turnAt(prev, cur) {
    const b1 = bearing(this.nodes[prev.from], this.nodes[prev.to]);
    const b2 = bearing(this.nodes[cur.from], this.nodes[cur.to]);
    let d = ((b2 - b1 + 540) % 360) - 180;
    if (Math.abs(d) < 35) return 'straight';
    if (Math.abs(d) > 150) return 'back';
    return d > 0 ? 'right' : 'left';
  }

  /** 指定プロファイルで from から到達できるノード集合。 */
  reachable(from, profile) {
    const prof = asProfile(profile);
    const seen = new Uint8Array(this.nodes.length);
    const st = [from];
    seen[from] = 1;
    while (st.length) {
      const u = st.pop();
      for (const j of this.adj[u]) {
        const L = this.links[j];
        if (!prof.allow(L)) continue;
        const v = L[0] === u ? L[1] : L[0];
        if (!seen[v]) { seen[v] = 1; st.push(v); }
      }
    }
    return seen;
  }

  nearestNode(lat, lon) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const d = (this.nodes[i][0] - lat) ** 2 + (this.nodes[i][1] - lon) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
}

/*
 * NWD は数メートル単位でノードが刻まれているため、素直に曲がり角を出すと
 * 「1m 右へ曲がる」のような手順が並ぶ。短い区間は直前の手順に吸収して、
 * 実際に案内として意味のある単位にまとめる。
 */
const MIN_STEP_M = 12;

function mergeShort(runs) {
  const out = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    // 1基のエレベーター（や1本の階段）が複数リンクに分割されていることがある。
    // 連続する同種の縦移動は 1 回にまとめる（そうしないと「3回乗り換え」に見える）。
    const VERTICAL = r.type === 'elevator' || r.type === 'escalator' || r.type === 'stairs';
    if (VERTICAL && prev && prev.type === r.type) {
      prev.toFloor = r.toFloor;
      prev.accessible = prev.accessible && r.accessible;
      prev.meters += r.meters;
      prev.at = r.at;
      prev.endNode = r.endNode;
      continue;
    }
    if (VERTICAL || r.type === 'crossing' || !prev || prev.type !== 'walk' || r.type !== 'walk') {
      out.push({ ...r });
      continue;
    }
    // 短すぎる区間、または曲がらずに続く区間は直前にくっつける
    if (r.meters < MIN_STEP_M || !r.turn || r.turn === 'straight') {
      prev.meters += r.meters;
      prev.at2 = r.at2;
      prev.endNode = r.endNode;
      continue;
    }
    out.push({ ...r });
  }
  // 先頭が極端に短い場合は次に寄せる
  if (out.length > 1 && out[0].type === 'walk' && out[0].meters < MIN_STEP_M && out[1].type === 'walk') {
    out[1].meters += out[0].meters;
    out[1].turn = out[0].turn;
    out[1].startNode = out[0].startNode;
    out[1].at = out[0].at;
    out[1].landmark = out[0].landmark || out[1].landmark;
    out.shift();
  }
  return out;
}

function bearing(a, b) {
  const p = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * p) * Math.cos(b[0] * p);
  const x = Math.cos(a[0] * p) * Math.sin(b[0] * p) -
            Math.sin(a[0] * p) * Math.cos(b[0] * p) * Math.cos((b[1] - a[1]) * p);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** 素朴なバイナリヒープ。ノード 2,288 件なので十分。 */
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    this.k.push(key); this.v.push(val);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      this.swap(p, i); i = p;
    }
  }
  pop() {
    const top = [this.k[0], this.v[0]];
    const lk = this.k.pop(), lv = this.v.pop();
    if (this.k.length) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        this.swap(m, i); i = m;
      }
    }
    return top;
  }
  swap(a, b) {
    [this.k[a], this.k[b]] = [this.k[b], this.k[a]];
    [this.v[a], this.v[b]] = [this.v[b], this.v[a]];
  }
}
