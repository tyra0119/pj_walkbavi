/*
 * icons.js — 縦移動（エレベーター / エスカレーター / 階段）のイラスト
 *
 * 文字が読めなくても何をすればいいか伝わることを狙う。
 * 配色は CSS 変数を使わず currentColor と固定色の組み合わせにして、
 * 小さく縮めても潰れないよう線を太めにしている。
 */

const C = {
  ink: '#1a1f26',
  line: '#c7ced6',
  ev: '#0a8f5b',
  es: '#e08a1e',
  stairs: '#d0402c',
  wall: '#eef1f4',
};

function person(x, y, s, color) {
  // 人 + スーツケース。s は縦の縮尺（1 で高さ約 34）
  return `
    <g transform="translate(${x},${y}) scale(${s})" fill="${color}">
      <circle cx="0" cy="-26" r="5"/>
      <rect x="-4" y="-20" width="8" height="13" rx="3"/>
      <rect x="-4.5" y="-8" width="3.5" height="9" rx="1.5"/>
      <rect x="1" y="-8" width="3.5" height="9" rx="1.5"/>
      <rect x="4" y="-19" width="2.5" height="9" rx="1.2"/>
      <rect x="8" y="-11" width="11" height="12" rx="2" fill="none" stroke="${color}" stroke-width="2.4"/>
      <rect x="12" y="-14" width="3" height="3.5" rx="1" />
    </g>`;
}

/** 上向き / 下向きの太い矢印 */
function arrow(x, y, up, color, h = 30) {
  const d = up
    ? `M0 ${h} L0 8 M-9 17 L0 6 L9 17`
    : `M0 0 L0 ${h - 8} M-9 ${h - 17} L0 ${h - 6} L9 ${h - 17}`;
  return `<g transform="translate(${x},${y})" fill="none" stroke="${color}"
     stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></g>`;
}

/**
 * エレベーター。上下 2 つの階を示し、間を矢印で結ぶ。
 * from / to はフロア名（「地上」「2階・デッキ」など）。
 */
export function elevatorSVG(from, to, up) {
  const top = up ? to : from;
  const bottom = up ? from : to;
  return `<svg viewBox="0 0 240 140" role="img" aria-label="elevator">
    <rect x="14" y="14" width="96" height="112" rx="6" fill="${C.wall}" stroke="${C.line}" stroke-width="2.5"/>
    <line x1="62" y1="20" x2="62" y2="120" stroke="${C.line}" stroke-width="2.5" stroke-dasharray="6 5"/>
    <rect x="22" y="22" width="80" height="96" rx="3" fill="#fff" stroke="${C.ev}" stroke-width="3"/>
    ${person(46, 96, 1.05, C.ink)}
    ${arrow(140, 40, up, C.ev, 58)}
    <line x1="118" y1="30" x2="226" y2="30" stroke="${C.line}" stroke-width="3"/>
    <line x1="118" y1="118" x2="226" y2="118" stroke="${C.line}" stroke-width="3"/>
    <text x="164" y="24" font-size="17" font-weight="700" fill="${C.ink}"
      text-anchor="middle" dominant-baseline="auto">${esc(top)}</text>
    <text x="164" y="136" font-size="17" font-weight="700" fill="${C.ink}"
      text-anchor="middle">${esc(bottom)}</text>
  </svg>`;
}

/*
 * 段のある斜面は常に「左下が低い階・右上が高い階」で描き、
 * 進む向きは矢印で示す。上り下りで階段の絵まで反転させると
 * かえって読み取りにくいため。ラベルは高さの順に置く（from/to の順ではない）。
 */
function slope(color, label) {
  const steps = [0, 1, 2, 3, 4].map((i) => {
    const x = 30 + i * 34;
    const y = 112 - i * 20;
    return `<path d="M${x} ${y} h34 v-20" fill="none" stroke="${color}" stroke-width="5"
      stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return { steps, label };
}

function slopeSVG(from, to, up, color, label, guide) {
  const { steps } = slope(color, label);
  const high = up ? to : from;   // 上にある階
  const low = up ? from : to;    // 下にある階
  // 斜面の向きは約 -29 度。上向き矢印(-90度)を斜面に合わせるには +61 度回す。
  const rot = up ? 61 : 241;
  const ax = up ? 198 : 40;
  const ay = up ? 30 : 104;
  return `<svg viewBox="0 0 240 140" role="img" aria-label="${label}">
    ${guide ? `<path d="M22 120 L204 18" fill="none" stroke="${C.line}" stroke-width="3"/>` : ''}
    ${steps}
    ${person(96, 74, 0.95, C.ink)}
    <g transform="translate(${ax},${ay}) rotate(${rot})">${arrow(0, 0, true, color, 34)}</g>
    <text x="18" y="136" font-size="15" font-weight="700" fill="${C.ink}">${esc(low)}</text>
    <text x="222" y="16" font-size="15" font-weight="700" fill="${C.ink}" text-anchor="end">${esc(high)}</text>
  </svg>`;
}

/** エスカレーター。 */
export function escalatorSVG(from, to, up) {
  return slopeSVG(from, to, up, C.es, 'escalator', true);
}

/** 階段。段差ゼロ経路では使わないが、比較用の「階段あり経路」で出す。 */
export function stairsSVG(from, to, up) {
  return slopeSVG(from, to, up, C.stairs, 'stairs', false);
}

export function verticalSVG(type, from, to, up) {
  if (type === 'escalator') return escalatorSVG(from, to, up);
  if (type === 'stairs') return stairsSVG(from, to, up);
  return elevatorSVG(from, to, up);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
