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

  /**
   * ノード n の位置にある目印。無ければ 2 ホップ隣まで探す。
   * `used` に入っている名前は飛ばす。同じ店の名前で 2 回曲がれと言われると、
   * どちらの角のことか現地で区別できないため。
   */
  landmarkAt(n, used) {
    const ok = (m) => m && !(used && used.has(m.name_ja));
    if (ok(this.lm.get(n))) return this.lm.get(n);
    // 近い順に見る。遠くの店を指しても現地で照合できない。
    const cand = [];
    for (const j of this.adj[n]) {
      const L = this.links[j];
      const v = L[0] === n ? L[1] : L[0];
      if (L[2] <= 30) cand.push([L[2], v]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    for (const [d, v] of cand) {
      if (ok(this.lm.get(v))) return this.lm.get(v);
      for (const j2 of this.adj[v]) {
        const L2 = this.links[j2];
        const w = L2[0] === v ? L2[1] : L2[0];
        if (w !== n && d + L2[2] <= 40 && ok(this.lm.get(w))) return this.lm.get(w);
      }
    }
    return null;
  }

  /*
   * 出発地・目的地の名前と紛らわしい目印を除くための集合。
   * OSM では建物と店舗が別々に登録されていて、目的地が「MORE'S」でも
   * 目印側に「b-MORE'S」が入っていたりする。片方がもう片方を含むなら同じ場所とみなす。
   */
  endpointNames(from, to) {
    const names = [];
    for (const p of this.pois) {
      if (p.node !== from && p.node !== to) continue;
      if (p.name_ja) names.push(p.name_ja);
      if (p.name_en) names.push(p.name_en);
    }
    const norm = (v) => String(v).toLowerCase().replace(/[\s'’`\-‐−・.,()（）「」『』]/g, '');
    const keys = names.map(norm).filter((v) => v.length >= 2);
    const out = new Set();
    for (const m of this.lm.values()) {
      const n = norm(m.name_ja);
      if (keys.some((k) => n.includes(k) || k.includes(n))) out.add(m.name_ja);
    }
    return out;
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
    return this.describe(from, path, to);
  }

  describe(from, linkIdx, to) {
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
    const steps = this.instructions(from, segs, this.endpointNames(from, to));
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
  /*
   * 手順のリストを作る。
   *
   * 曲がりは「直前のリンクとの角度」では判定しない。NWD の経路には、通路を斜めに
   * 横切ったり柱を避けたりする 6〜9m の寄り道が挟まっていて、リンク単位で見ると
   * そこが 90 度の曲がりに見えてしまう。歩く人はそれを曲がったとは感じない。
   *
   * 代わりに、その地点の前後 SMOOTH_M メートルの進行方向を比べる。
   * 寄り道はこの長さで均されて消え、本当に向きが変わる場所だけが残る。
   */
  instructions(from, segs, exclude) {
    const nodesSeq = [from, ...segs.map((s) => s.to)];
    const cum = [0];
    for (let i = 0; i < segs.length; i++) cum.push(cum[i] + segs[i].L[2]);

    // 累積距離 d の地点の座標（リンクの途中なら按分する）
    const pointAt = (d) => {
      let k = 0;
      while (k < cum.length - 2 && cum[k + 1] < d) k++;
      const span = cum[k + 1] - cum[k];
      const f = span > 0 ? Math.min(1, Math.max(0, (d - cum[k]) / span)) : 0;
      const a = this.nodes[nodesSeq[k]], b = this.nodes[nodesSeq[k + 1]];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    };

    const out = [];
    const VERT = { [RT.ELEVATOR]: 'elevator', [RT.ESCALATOR]: 'escalator', [RT.STAIRS]: 'stairs' };

    let i = 0;
    while (i < segs.length) {
      const rt = segs[i].L[3];

      if (VERT[rt]) {
        // 1基のエレベーターが複数リンクに分かれているので、連続する同種はまとめる
        let j = i;
        let meters = 0;
        let accessible = true;
        while (j < segs.length && segs[j].L[3] === rt) {
          meters += segs[j].L[2];
          if (rt === RT.ELEVATOR) accessible = accessible && segs[j].L[7] >= 3;
          j++;
        }
        out.push({
          type: VERT[rt],
          meters: rt === RT.ELEVATOR ? 0 : meters,
          fromFloor: this.nodes[nodesSeq[i]][2],
          toFloor: this.nodes[nodesSeq[j]][2],
          accessible: rt === RT.ELEVATOR && accessible,
          at: this.nodes[nodesSeq[j]],
          startNode: nodesSeq[i],
          endNode: nodesSeq[j],
        });
        i = j;
        continue;
      }

      // 縦移動に挟まれた、ひとつながりの水平区間
      let j = i;
      while (j < segs.length && !VERT[segs[j].L[3]]) j++;

      // 区間の中で「曲がった」と感じる地点を拾う
      const turns = [];
      for (let k = i + 1; k < j; k++) {
        const back = Math.max(cum[i], cum[k] - SMOOTH_M);
        const fwd = Math.min(cum[j], cum[k] + SMOOTH_M);
        // 前後どちらかが短すぎると向きが定まらない
        if (cum[k] - back < 4 || fwd - cum[k] < 4) continue;
        const here = this.nodes[nodesSeq[k]];
        const d = angleDiff(bearing(pointAt(back), here), bearing(here, pointAt(fwd)));
        const lab = turnLabel(d);
        if (lab !== 'straight') turns.push({ k, lab, mag: Math.abs(d) });
      }

      // 近すぎる曲がりは、いちばん大きいものだけ残す。
      // 数メートルおきに「右、左、右」と言われても従えない。
      const kept = [];
      for (const tn of turns) {
        const last = kept[kept.length - 1];
        if (last && cum[tn.k] - cum[last.k] < MIN_STEP_M) {
          if (tn.mag > last.mag) kept[kept.length - 1] = tn;
          continue;
        }
        kept.push(tn);
      }

      const pushWalk = (a, b, endTurn) => {
        if (b <= a) return;
        out.push({
          type: 'walk',
          meters: cum[b] - cum[a],
          at: this.nodes[nodesSeq[a]],
          at2: this.nodes[nodesSeq[b]],
          floor: this.nodes[nodesSeq[a]][2],
          outdoor: this.nodes[nodesSeq[a]][3] === 1, // 施設外なら GPS が期待できる
          startNode: nodesSeq[a],
          endNode: nodesSeq[b],
          endTurn: endTurn || null,
        });
      };
      let a = i;
      for (const tn of kept) { pushWalk(a, tn.k, tn.lab); a = tn.k; }
      pushWalk(a, j, null);
      i = j;
    }

    const merged = out.map((o) => ({ ...o, meters: Math.round(o.meters) }));

    /*
     * 各手順を「歩く区間 ＋ その終わりでする動作」として仕上げる。
     *
     * 「曲がってから歩く」形にすると、歩いている間じゅう画面が
     * すでに済んだ動作を指し続け、次に何をするのかが分からない。
     * カーナビが「500m先を右折」と言うのと同じ理由で、これから来る動作を先に見せる。
     */
    for (let k = 0; k < merged.length; k++) {
      const s = merged[k];
      if (isVerticalStep(s) || s.type === 'crossing') continue;
      const next = merged[k + 1];
      if (s.endTurn) s.endAction = s.endTurn;
      else if (!next) s.endAction = 'goal';
      else if (isVerticalStep(next)) s.endAction = next.type;
      else s.endAction = 'straight';
      s.endLandmarkNode = s.endNode;
    }

    /*
     * 目印は曲がる手順にだけ付ける。「エレベーターの前へ」「到着」に添えても
     * 文には出ないのに地図にだけ名前が出て、何を指しているのか分からなくなる。
     *
     * 出発地・目的地と同じ名前の目印も使わない。目的地が MORE'S のときに
     * 「MORE'S のところで右へ曲がる」と言われると、着いたのかどうか分からない。
     */
    const TURNS = new Set(['left', 'right', 'back']);
    const used = new Set(exclude || []);
    for (const s of merged) {
      s.landmark = null;
      if (isVerticalStep(s) || !TURNS.has(s.endAction) || s.endLandmarkNode == null) continue;
      const lm = this.landmarkAt(s.endLandmarkNode, used);
      if (!lm) continue;
      s.landmark = lm;
      used.add(lm.name_ja);
    }
    return merged;
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

/*
 * 曲がりを判定するときに前後を見る距離。
 * 短いと寄り道を曲がりと誤判定し、長いと本物の曲がりを見落とす。
 * 川崎の寄り道は 6〜9m なので、その倍を超える 20m にしてある。
 */
const SMOOTH_M = 20;

export function isVerticalStep(s) {
  return !!s && (s.type === 'elevator' || s.type === 'escalator' || s.type === 'stairs');
}

function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

function turnLabel(d) {
  if (Math.abs(d) < 35) return 'straight';
  if (Math.abs(d) > 150) return 'back';
  return d > 0 ? 'right' : 'left';
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
