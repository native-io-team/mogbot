/**
 * A picture of a fictional page for the agents'-browser live preview
 * (`agents_browser_live_frame`): a supplier directory, drawn as an SVG data
 * URL so the harness needs no image file and no network. Stands in for the
 * JPEG the Mac sends; the component only puts it in an <img>.
 */

const card = (x: number, y: number, name: string, place: string, tag: string) => `
  <g transform="translate(${x} ${y})">
    <rect width="372" height="196" rx="12" fill="#ffffff" stroke="#e4e2dc"/>
    <rect x="24" y="24" width="48" height="48" rx="10" fill="#e9efe6"/>
    <rect x="36" y="38" width="24" height="20" rx="3" fill="#7a9b6c"/>
    <text x="88" y="44" font-size="19" font-weight="600" fill="#1d2320">${name}</text>
    <text x="88" y="68" font-size="14" fill="#6b706c">${place}</text>
    <rect x="24" y="96" width="300" height="10" rx="5" fill="#eceae4"/>
    <rect x="24" y="116" width="240" height="10" rx="5" fill="#eceae4"/>
    <rect x="24" y="148" width="${tag.length * 8 + 28}" height="28" rx="14" fill="#eef3fb"/>
    <text x="38" y="167" font-size="13" fill="#2f5aa8">${tag}</text>
    <rect x="252" y="148" width="96" height="28" rx="8" fill="#1d2320"/>
    <text x="276" y="167" font-size="13" fill="#ffffff">Contact</text>
  </g>`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="860" viewBox="0 0 1280 860" font-family="Helvetica, Arial, sans-serif">
  <rect width="1280" height="860" fill="#f7f6f2"/>
  <rect width="1280" height="72" fill="#ffffff"/>
  <rect y="71" width="1280" height="1" fill="#e4e2dc"/>
  <circle cx="56" cy="36" r="14" fill="#7a9b6c"/>
  <text x="80" y="43" font-size="20" font-weight="700" fill="#1d2320">Northwind Supply</text>
  <text x="640" y="42" font-size="15" fill="#6b706c">Directory</text>
  <text x="740" y="42" font-size="15" fill="#6b706c">Categories</text>
  <text x="860" y="42" font-size="15" fill="#6b706c">Shipping</text>
  <rect x="1100" y="20" width="132" height="34" rx="8" fill="#1d2320"/>
  <text x="1129" y="42" font-size="14" fill="#ffffff">List a firm</text>
  <text x="40" y="146" font-size="34" font-weight="700" fill="#1d2320">Packaging suppliers</text>
  <text x="40" y="180" font-size="16" fill="#6b706c">214 firms · filtered to “Ships to Canada”</text>
  <rect x="40" y="204" width="560" height="44" rx="10" fill="#ffffff" stroke="#d9d6cf"/>
  <text x="62" y="232" font-size="15" fill="#9a9d98">corrugated boxes, mailers, tape…</text>
  <rect x="616" y="204" width="150" height="44" rx="22" fill="#e9efe6" stroke="#7a9b6c"/>
  <text x="640" y="232" font-size="14" fill="#3f5f33">Ships to Canada ✕</text>
  <rect x="782" y="204" width="120" height="44" rx="22" fill="#ffffff" stroke="#d9d6cf"/>
  <text x="806" y="232" font-size="14" fill="#4a4f4b">Min. order</text>
  ${card(40, 280, 'Boreal Box Co.', 'Winnipeg, MB', 'Corrugated')}
  ${card(454, 280, 'Harbour Mailers', 'Halifax, NS', 'Poly mailers')}
  ${card(868, 280, 'Cedar &amp; Twine', 'Portland, OR', 'Paper tape')}
  ${card(40, 500, 'Prairie Pack', 'Regina, SK', 'Void fill')}
  ${card(454, 500, 'Lakeside Cartons', 'Duluth, MN', 'Folding cartons')}
  ${card(868, 500, 'Fjord Freight Supply', 'Vancouver, BC', 'Pallet wrap')}
  <rect x="454" y="500" width="372" height="196" rx="12" fill="none" stroke="#2f5aa8" stroke-width="3"/>
  <path d="M700 640 l0 26 l7 -7 l6 13 l5 -2 l-6 -13 l10 0 z" fill="#1d2320" stroke="#ffffff" stroke-width="1.5"/>
  <rect x="40" y="724" width="1200" height="1" fill="#e4e2dc"/>
  <text x="40" y="760" font-size="14" fill="#9a9d98">Showing 1–6 of 214</text>
</svg>`;

export const BROWSER_FRAME_SRC = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`;

export const browserFrame = (seq = 1) => ({
  seq,
  src: BROWSER_FRAME_SRC,
  width: 1280,
  height: 860,
  url: 'https://www.northwind-supply.com/directory/packaging?ships=CA',
  title: 'Packaging suppliers · Northwind Supply',
});
