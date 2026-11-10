// App icon: the Dynamic Island as one bold black pill floating near the top of
// a screen. Built the way current Fluent / Liquid Glass icons are: one large
// shape that still reads at 16px, a 2-step gradient on the tile, a soft sheen
// on top, and a shadow that only the symbol casts onto the tile.
const T = 8;          // tile inset
const R = 56;         // tile corner radius
const W = 180;        // island width
const H = 68;         // island height
const x0 = 128 - W / 2;
const x1 = 128 + W / 2;
const top = 58;       // the island sits in the upper part, as on a phone screen
const bottom = top + H;
const r = H / 2;

const island = `M${x0 + r} ${top} H${x1 - r} A${r} ${r} 0 0 1 ${x1 - r} ${bottom} H${x0 + r} A${r} ${r} 0 0 1 ${x0 + r} ${top} Z`;

function icon(v) {
  const cy = top + H / 2;
  const tile = `x="${T}" y="${T}" width="${256 - 2 * T}" height="${256 - 2 * T}" rx="${R}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${v.from}"/><stop offset="1" stop-color="${v.to}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="${v.sheen}"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${v.islandTop}"/><stop offset="1" stop-color="${v.island}"/>
    </linearGradient>
    <clipPath id="t"><rect ${tile}/></clipPath>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="180%">
      <feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="${v.shadow}" flood-opacity="${v.shadowOpacity}"/>
    </filter>
  </defs>
  <rect ${tile} fill="url(#bg)"/>
  <g clip-path="url(#t)">
    <rect ${tile} fill="url(#sheen)"/>
    <path d="${island}" fill="url(#gloss)" filter="url(#drop)"/>
    <circle cx="${x0 + 34}" cy="${cy}" r="14" fill="${v.mark}"/>
    <rect x="${x1 - 58}" y="${cy - 11}" width="8" height="22" rx="4" fill="${v.mark}"/>
    <rect x="${x1 - 45}" y="${cy - 18}" width="8" height="36" rx="4" fill="${v.mark}"/>
    <rect x="${x1 - 32}" y="${cy - 8}" width="8" height="16" rx="4" fill="${v.mark}"/>
  </g>
  <rect x="${T + 0.75}" y="${T + 0.75}" width="${256 - 2 * T - 1.5}" height="${256 - 2 * T - 1.5}" rx="${R - 0.75}" fill="none" stroke="#fff" stroke-opacity="${v.ring}" stroke-width="1.5"/>
</svg>`;
}

const VARIANTS = {
  sky: { name: 'Небо', from: '#4a74ff', to: '#1d36c9', sheen: 0.28, island: '#000', islandTop: '#1c1c22', mark: '#fff', shadow: '#00104d', shadowOpacity: 0.55, ring: 0.18 },
  night: { name: 'Ночь', from: '#3a3a44', to: '#101014', sheen: 0.16, island: '#000', islandTop: '#141418', mark: '#ffd84a', shadow: '#000', shadowOpacity: 0.7, ring: 0.2 },
  dawn: { name: 'Рассвет', from: '#ff9a6b', to: '#7b3cf0', sheen: 0.24, island: '#000', islandTop: '#1c1c22', mark: '#fff', shadow: '#2a0050', shadowOpacity: 0.5, ring: 0.16 },
};

module.exports = { icon, VARIANTS };
