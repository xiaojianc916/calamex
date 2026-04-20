import type { IFileIconGlyph } from '@/types/file-icon';

const createGlyph = (body: string, viewBox = '0 0 48 48'): IFileIconGlyph => ({
    viewBox,
    body,
});

const fileGlyph = createGlyph(`
  <path d="M12 6h16l8 8v28H12z" fill="#9aa0ab" fill-opacity=".08" />
  <path data-stroke stroke="#c9cbd3" d="M12 9a3 3 0 0 1 3-3h13l8 8v25a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" />
  <path data-stroke stroke="#c9cbd3" d="M28 6v5a3 3 0 0 0 3 3h5" />
`);

const iniGlyph = createGlyph(`
  <path d="M12 6h17l7 7v26a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" fill="#9aa0ab" fill-opacity=".08" />
  <path data-stroke stroke="#c9cbd3" d="M12 9a3 3 0 0 1 3-3h14l7 7v24a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" />
  <path data-stroke stroke="#c9cbd3" d="M29 6v4a3 3 0 0 0 3 3h4" />
  <line x1="16" y1="20" x2="26" y2="20" data-stroke stroke="#c9cbd3" />
  <line x1="16" y1="25" x2="22" y2="25" data-stroke stroke="#c9cbd3" />
  <line x1="24" y1="25" x2="31" y2="25" data-stroke stroke="#c9cbd3" />
  <g transform="translate(30 34)">
    <circle r="5" fill="#e69a5a" fill-opacity=".25" />
    <g fill="#e69a5a">
      <rect x="-1" y="-7" width="2" height="2.5" />
      <rect x="-1" y="4.5" width="2" height="2.5" />
      <rect x="-7" y="-1" width="2.5" height="2" />
      <rect x="4.5" y="-1" width="2.5" height="2" />
    </g>
    <circle r="5" data-stroke stroke="#e69a5a" />
    <circle r="1.6" data-stroke stroke="#e69a5a" />
  </g>
`);

const docGlyph = createGlyph(`
  <path d="M12 6h17l7 7v26a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" fill="#6d8eff" fill-opacity=".10" />
  <path data-stroke stroke="#6d8eff" d="M12 9a3 3 0 0 1 3-3h14l7 7v24a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" />
  <path data-stroke stroke="#6d8eff" d="M29 6v4a3 3 0 0 0 3 3h4" />
  <rect x="16" y="19" width="10" height="2.5" rx="1" fill="#6d8eff" />
  <line x1="16" y1="26" x2="32" y2="26" data-stroke stroke="#6d8eff" />
  <line x1="16" y1="30" x2="32" y2="30" data-stroke stroke="#6d8eff" />
  <line x1="16" y1="34" x2="26" y2="34" data-stroke stroke="#6d8eff" />
`);

const xlsGlyph = createGlyph(`
  <rect x="6" y="10" width="36" height="28" rx="3" fill="#6fbf8a" fill-opacity=".10" />
  <rect x="6" y="10" width="36" height="28" rx="3" data-stroke stroke="#6fbf8a" />
  <path d="M6 13a3 3 0 0 1 3-3h30a3 3 0 0 1 3 3v4H6z" fill="#6fbf8a" fill-opacity=".28" />
  <line x1="6" y1="17" x2="42" y2="17" data-stroke stroke="#6fbf8a" />
  <line x1="6" y1="24" x2="42" y2="24" data-stroke stroke="#6fbf8a" />
  <line x1="6" y1="31" x2="42" y2="31" data-stroke stroke="#6fbf8a" />
  <line x1="18" y1="10" x2="18" y2="38" data-stroke stroke="#6fbf8a" />
  <line x1="30" y1="10" x2="30" y2="38" data-stroke stroke="#6fbf8a" />
`);

const imageGlyph = createGlyph(`
  <rect x="6" y="8" width="36" height="32" rx="3" fill="#a885f3" fill-opacity=".10" />
  <rect x="6" y="8" width="36" height="32" rx="3" data-stroke stroke="#a885f3" />
  <circle cx="15" cy="17" r="2.6" fill="#a885f3" />
  <path d="M6 32 L14 23 L20 28 L27 19 L42 34 V40 H6 Z" fill="#a885f3" fill-opacity=".35" />
  <path data-stroke stroke="#a885f3" d="M6 32 L14 23 L20 28 L27 19 L42 34" />
`);

const zipGlyph = createGlyph(`
  <rect x="8" y="6" width="32" height="36" rx="4" fill="#e0a243" fill-opacity=".10" />
  <rect x="8" y="6" width="32" height="36" rx="4" data-stroke stroke="#e0a243" />
  <line x1="8" y1="18" x2="40" y2="18" data-stroke stroke="#e0a243" />
  <g fill="#e0a243">
    <rect x="11" y="17" width="2" height="2" rx=".3" />
    <rect x="15" y="17" width="2" height="2" rx=".3" />
    <rect x="19" y="17" width="2" height="2" rx=".3" />
    <rect x="27" y="17" width="2" height="2" rx=".3" />
    <rect x="31" y="17" width="2" height="2" rx=".3" />
    <rect x="35" y="17" width="2" height="2" rx=".3" />
  </g>
  <path d="M21 14 h6 v4 l-3 2 l-3 -2 z" fill="#e0a243" />
  <line x1="24" y1="20" x2="24" y2="24" data-stroke stroke="#e0a243" />
  <circle cx="24" cy="25.5" r="1.5" fill="none" data-stroke stroke="#e0a243" />
`);

const shGlyph = createGlyph(`
  <rect x="5" y="8" width="38" height="32" rx="3" fill="#4fb8a5" fill-opacity=".10" />
  <rect x="5" y="8" width="38" height="32" rx="3" data-stroke stroke="#4fb8a5" />
  <line x1="5" y1="15" x2="43" y2="15" data-stroke stroke="#4fb8a5" />
  <g fill="#4fb8a5">
    <circle cx="10" cy="11.5" r="1.1" />
    <circle cx="14" cy="11.5" r="1.1" />
    <circle cx="18" cy="11.5" r="1.1" />
  </g>
  <polyline points="11,23 15,28 11,33" data-stroke stroke="#4fb8a5" />
  <line x1="18" y1="33" x2="26" y2="33" data-stroke stroke="#4fb8a5" />
  <rect x="29" y="26" width="2.5" height="8" fill="#4fb8a5" />
`);

const ps1Glyph = createGlyph(`
  <rect x="6" y="10" width="36" height="28" rx="2" fill="#6d8eff" fill-opacity=".25" />
  <rect x="6" y="10" width="36" height="28" rx="2" data-stroke stroke="#6d8eff" />
  <line x1="6" y1="16" x2="42" y2="16" data-stroke stroke="#6d8eff" stroke-opacity=".6" />
  <polyline points="12,22 20,28 12,34" data-stroke stroke="#ffffff" />
  <line x1="22" y1="34" x2="32" y2="34" data-stroke stroke="#ffffff" />
`);

const batGlyph = createGlyph(`
  <rect x="6" y="10" width="36" height="28" rx="2" fill="#2a2a30" />
  <rect x="6" y="10" width="36" height="28" rx="2" data-stroke stroke="#c9cbd3" />
  <line x1="6" y1="16" x2="42" y2="16" data-stroke stroke="#c9cbd3" stroke-opacity=".5" />
  <circle cx="10" cy="13" r="1" fill="#e26d6d" />
  <circle cx="13" cy="13" r="1" fill="#e7c463" />
  <circle cx="16" cy="13" r="1" fill="#6fbf8a" />
  <text x="24" y="30" font-size="9" fill="#c9cbd3">BAT</text>
  <rect x="36" y="27" width="2" height="4" fill="#6fbf8a" />
`);

const makefileGlyph = createGlyph(`
  <path d="M14 34 L22 14 L28 20 L18 38 Z" fill="#d6855a" fill-opacity=".3" stroke="#d6855a" stroke-width="1.6" />
  <rect x="24" y="10" width="10" height="6" rx="1" fill="#d6855a" transform="rotate(30 29 13)" />
`);

export const FILE_ICON_GLYPHS = {
    folder: createGlyph(`
    <path d="M6 14a4 4 0 0 1 4-4h8l3 3h18a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#6d8eff" fill-opacity=".12" />
    <path data-stroke stroke="#6d8eff" d="M6 14a4 4 0 0 1 4-4h8l3 3h18a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" />
  `),
    'folder-open': createGlyph(`
    <path data-stroke stroke="#6d8eff" d="M6 15a4 4 0 0 1 4-4h8l3 3h18a4 4 0 0 1 4 4v3" />
    <path d="M6 18h36l-3.8 16.4a3 3 0 0 1-2.9 2.3H9a3 3 0 0 1-3-3z" fill="#6d8eff" fill-opacity=".15" />
    <path data-stroke stroke="#6d8eff" d="M6 18h36l-3.8 16.4a3 3 0 0 1-2.9 2.3H9a3 3 0 0 1-3-3z" />
  `),
    file: fileGlyph,
    txt: createGlyph(`
    <rect x="20" y="4" width="8" height="4" rx="1" fill="#9aa0ab" fill-opacity=".3" />
    <rect x="20" y="4" width="8" height="4" rx="1" data-stroke stroke="#b5bac4" />
    <rect x="10" y="8" width="28" height="34" rx="3" fill="#c9cbd3" fill-opacity=".06" />
    <rect x="10" y="8" width="28" height="34" rx="3" data-stroke stroke="#c9cbd3" />
    <line x1="16" y1="17" x2="32" y2="17" data-stroke stroke="#c9cbd3" />
    <line x1="16" y1="22" x2="30" y2="22" data-stroke stroke="#c9cbd3" />
    <line x1="16" y1="27" x2="32" y2="27" data-stroke stroke="#c9cbd3" />
    <line x1="16" y1="32" x2="26" y2="32" data-stroke stroke="#c9cbd3" />
    <line x1="28" y1="32" x2="28" y2="35" data-stroke stroke="#c9cbd3" />
  `),
    pdf: createGlyph(`
    <path d="M12 6h17l7 7v26a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" fill="#e26d6d" fill-opacity=".18" />
    <path data-stroke stroke="#e26d6d" d="M12 9a3 3 0 0 1 3-3h14l7 7v24a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" />
    <path data-stroke stroke="#e26d6d" d="M29 6v4a3 3 0 0 0 3 3h4" />
    <rect x="14" y="26" width="20" height="10" rx="2" fill="#e26d6d" />
    <text x="24" y="33.5" font-size="7" fill="#0b0b0d" letter-spacing=".5">PDF</text>
  `),
    doc: docGlyph,
    xls: xlsGlyph,
    csv: xlsGlyph,
    ppt: createGlyph(`
    <rect x="6" y="6" width="36" height="36" rx="8" fill="#e69a5a" />
    <rect x="6" y="6" width="36" height="36" rx="8" fill="none" stroke="#c97a3e" stroke-width="1.4" />
    <circle cx="24" cy="24" r="9" fill="none" stroke="#ffffff" stroke-width="2" />
    <path d="M24 24 L24 15 A9 9 0 0 1 33 24 Z" fill="#ffffff" />
  `),
    image: imageGlyph,
    svg: createGlyph(`
    <rect x="6" y="10" width="36" height="28" rx="2" fill="#e0a243" fill-opacity=".15" />
    <rect x="6" y="10" width="36" height="28" rx="2" fill="none" stroke="#e0a243" stroke-width="1.6" />
    <circle cx="18" cy="24" r="5" fill="none" stroke="#e0a243" stroke-width="1.6" />
    <rect x="26" y="20" width="8" height="8" fill="none" stroke="#e0a243" stroke-width="1.6" transform="rotate(45 30 24)" />
    <circle cx="12" cy="16" r="1.5" fill="#e0a243" />
    <circle cx="36" cy="32" r="1.5" fill="#e0a243" />
    <circle cx="30" cy="15" r="1" fill="#e0a243" />
    <text x="24" y="42" font-size="4" fill="#e0a243" font-weight="700">SVG</text>
  `),
    zip: zipGlyph,
    js: createGlyph(`
    <rect x="7" y="7" width="34" height="34" rx="6" fill="#e7c463" fill-opacity=".18" />
    <rect x="7" y="7" width="34" height="34" rx="6" data-stroke stroke="#e7c463" />
    <text x="24" y="31" font-size="14" fill="#e7c463">JS</text>
  `),
    ts: createGlyph(`
    <rect x="7" y="7" width="34" height="34" rx="6" fill="#6d8eff" fill-opacity=".18" />
    <rect x="7" y="7" width="34" height="34" rx="6" data-stroke stroke="#6d8eff" />
    <text x="24" y="31" font-size="14" fill="#6d8eff">TS</text>
  `),
    html: createGlyph(`
    <rect x="6" y="6" width="36" height="36" rx="6" fill="#e69a5a" />
    <rect x="6" y="6" width="36" height="36" rx="6" fill="none" stroke="#c97a3e" stroke-width="1.4" />
    <polyline points="19,18 12,24 19,30" fill="none" stroke="#ffffff" stroke-width="2.6" />
    <polyline points="29,18 36,24 29,30" fill="none" stroke="#ffffff" stroke-width="2.6" />
    <line x1="27" y1="17" x2="21" y2="33" stroke="#ffffff" stroke-width="2.6" />
  `),
    css: createGlyph(`
    <rect x="6" y="6" width="36" height="36" rx="6" fill="#5ec4d6" />
    <rect x="6" y="6" width="36" height="36" rx="6" fill="none" stroke="#3a9bad" stroke-width="1.4" />
    <path d="M17 14 q-4 0 -4 4 v4 q0 2 -2 2 q2 0 2 2 v4 q0 4 4 4" fill="none" stroke="#ffffff" stroke-width="2.4" />
    <path d="M31 14 q4 0 4 4 v4 q0 2 2 2 q-2 0 -2 2 v4 q0 4 -4 4" fill="none" stroke="#ffffff" stroke-width="2.4" />
    <circle cx="20" cy="24" r="1.6" fill="#e7c463" />
    <circle cx="24" cy="24" r="1.6" fill="#e58ab8" />
    <circle cx="28" cy="24" r="1.6" fill="#ffffff" />
  `),
    json: createGlyph(`
    <rect x="6" y="6" width="36" height="36" rx="6" fill="#e7c463" />
    <rect x="6" y="6" width="36" height="36" rx="6" fill="none" stroke="#c9a540" stroke-width="1.4" />
    <path d="M17 14 q-4 0 -4 4 v4 q0 2 -2 2 q2 0 2 2 v4 q0 4 4 4" fill="none" stroke="#0b0b0d" stroke-width="2.2" />
    <path d="M31 14 q4 0 4 4 v4 q0 2 2 2 q-2 0 -2 2 v4 q0 4 -4 4" fill="none" stroke="#0b0b0d" stroke-width="2.2" />
    <rect x="19" y="19" width="4" height="1.6" fill="#0b0b0d" />
    <rect x="25" y="19" width="6" height="1.6" fill="#0b0b0d" fill-opacity=".55" />
    <rect x="19" y="25" width="4" height="1.6" fill="#0b0b0d" />
    <rect x="25" y="25" width="6" height="1.6" fill="#0b0b0d" fill-opacity=".55" />
  `),
    md: createGlyph(`
    <path d="M12 6h18l8 8v28H12z" fill="#5ec4d6" fill-opacity=".18" />
    <path d="M12 6h18l8 8v28H12z" fill="none" stroke="#5ec4d6" stroke-width="1.6" />
    <path d="M30 6v8h8" fill="none" stroke="#5ec4d6" stroke-width="1.6" />
    <path d="M16 34 V22 L20 28 L24 22 V34" fill="none" stroke="#5ec4d6" stroke-width="1.8" />
    <path d="M30 22 V33 M27 30 L30 34 L33 30" fill="none" stroke="#5ec4d6" stroke-width="1.8" />
  `),
    rs: createGlyph(`
    <rect x="6" y="6" width="36" height="36" rx="6" fill="#d6855a" fill-opacity=".18" />
    <rect x="6" y="6" width="36" height="36" rx="6" fill="none" stroke="#d6855a" stroke-width="1.6" />
    <circle cx="24" cy="24" r="8" fill="none" stroke="#d6855a" stroke-width="2" />
    <circle cx="24" cy="24" r="3" fill="#d6855a" />
    <path d="M24 14 v-4 M34 24 h4 M24 34 v4 M14 24 h-4" stroke="#d6855a" stroke-width="2" />
    <path d="M31 17 l3 -3 M31 31 l3 3 M17 31 l-3 3 M17 17 l-3 -3" stroke="#d6855a" stroke-width="2" />
  `),
    py: createGlyph(`
    <circle cx="24" cy="24" r="15" fill="#6d8eff" fill-opacity=".2" />
    <path d="M24 9 C18 9 18 14 18 17 H30 V22 H13 C10 22 8 25 8 30 C8 36 12 39 18 39 H18 V34 C18 32 20 30 22 30 H27 C32 30 36 27 36 22 V17 C36 12 32 9 28 9 Z" fill="#6d8eff" />
    <circle cx="22" cy="13" r="1.2" fill="#ffffff" />
    <path d="M40 24 C40 30 38 33 32 33 H30 V38 C30 40 28 40 26 40 H18 V36 H26 C30 36 34 35 36 31 C38 27 40 22 40 18 V18 C40 13 36 9 32 9 H32 V14 H34 C37 14 40 17 40 22 Z" fill="#e7c463" />
    <circle cx="26" cy="35" r="1.2" fill="#ffffff" />
  `),
    go: createGlyph(`
    <ellipse cx="14" cy="12" rx="3" ry="4" fill="#5ec4d6" fill-opacity=".25" />
    <ellipse cx="14" cy="12" rx="3" ry="4" data-stroke stroke="#5ec4d6" />
    <ellipse cx="34" cy="12" rx="3" ry="4" fill="#5ec4d6" fill-opacity=".25" />
    <ellipse cx="34" cy="12" rx="3" ry="4" data-stroke stroke="#5ec4d6" />
    <ellipse cx="24" cy="26" rx="15" ry="14" fill="#5ec4d6" fill-opacity=".18" />
    <ellipse cx="24" cy="26" rx="15" ry="14" data-stroke stroke="#5ec4d6" />
    <circle cx="18" cy="22" r="4" fill="#0b0b0d" />
    <circle cx="30" cy="22" r="4" fill="#0b0b0d" />
    <circle cx="18" cy="22" r="4" data-stroke stroke="#5ec4d6" />
    <circle cx="30" cy="22" r="4" data-stroke stroke="#5ec4d6" />
    <circle cx="19.5" cy="22" r="1.2" fill="#5ec4d6" />
    <circle cx="31.5" cy="22" r="1.2" fill="#5ec4d6" />
    <rect x="22.4" y="29" width="1.6" height="4" rx=".3" fill="#5ec4d6" />
    <rect x="24" y="29" width="1.6" height="4" rx=".3" fill="#5ec4d6" />
  `),
    java: createGlyph(`
    <path data-stroke stroke="#d6855a" d="M17 12 q2 -2 0 -4 q-2 -2 0 -4" />
    <path data-stroke stroke="#d6855a" d="M24 12 q2 -2 0 -4 q-2 -2 0 -4" />
    <path data-stroke stroke="#d6855a" d="M31 12 q2 -2 0 -4 q-2 -2 0 -4" />
    <path d="M10 16 h22 v14 a5 5 0 0 1 -5 5 H15 a5 5 0 0 1 -5 -5 z" fill="#d6855a" fill-opacity=".18" />
    <path data-stroke stroke="#d6855a" d="M10 16 h22 v14 a5 5 0 0 1 -5 5 H15 a5 5 0 0 1 -5 -5 z" />
    <path data-stroke stroke="#d6855a" d="M32 20 a5 5 0 0 1 0 10" />
    <ellipse cx="21" cy="40" rx="15" ry="2" fill="#d6855a" fill-opacity=".25" />
    <ellipse cx="21" cy="40" rx="15" ry="2" data-stroke stroke="#d6855a" />
  `),
    cpp: createGlyph(`
    <path d="M24 4 L40 13 V35 L24 44 L8 35 V13 Z" fill="#6d8eff" fill-opacity=".18" />
    <path data-stroke stroke="#6d8eff" d="M24 4 L40 13 V35 L24 44 L8 35 V13 Z" />
    <text x="24" y="28.5" font-size="9" fill="#6d8eff">C++</text>
  `),
    toml: createGlyph(`
    <path d="M12 6h17l7 7v26a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" fill="#d6855a" fill-opacity=".10" />
    <path data-stroke stroke="#d6855a" d="M12 9a3 3 0 0 1 3-3h14l7 7v24a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" />
    <path data-stroke stroke="#d6855a" d="M29 6v4a3 3 0 0 0 3 3h4" />
    <polyline data-stroke stroke="#d6855a" points="18,20 16,20 16,24 18,24" />
    <polyline data-stroke stroke="#d6855a" points="30,20 32,20 32,24 30,24" />
    <line x1="19" y1="22" x2="29" y2="22" data-stroke stroke="#d6855a" />
    <line x1="15" y1="30" x2="19" y2="30" data-stroke stroke="#d6855a" />
    <line x1="21" y1="30" x2="23" y2="30" data-stroke stroke="#d6855a" />
    <line x1="25" y1="30" x2="33" y2="30" data-stroke stroke="#d6855a" />
    <line x1="15" y1="35" x2="19" y2="35" data-stroke stroke="#d6855a" />
    <line x1="21" y1="35" x2="23" y2="35" data-stroke stroke="#d6855a" />
    <line x1="25" y1="35" x2="31" y2="35" data-stroke stroke="#d6855a" />
  `),
    yaml: createGlyph(`
    <path d="M12 6h17l7 7v26a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" fill="#a885f3" fill-opacity=".10" />
    <path data-stroke stroke="#a885f3" d="M12 9a3 3 0 0 1 3-3h14l7 7v24a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" />
    <path data-stroke stroke="#a885f3" d="M29 6v4a3 3 0 0 0 3 3h4" />
    <line x1="15" y1="19" x2="22" y2="19" data-stroke stroke="#a885f3" />
    <circle cx="24" cy="18.5" r=".8" fill="#a885f3" />
    <circle cx="24" cy="19.7" r=".8" fill="#a885f3" />
    <line x1="19" y1="25" x2="20.5" y2="25" data-stroke stroke="#a885f3" />
    <line x1="22" y1="25" x2="32" y2="25" data-stroke stroke="#a885f3" />
    <line x1="19" y1="30" x2="20.5" y2="30" data-stroke stroke="#a885f3" />
    <line x1="22" y1="30" x2="30" y2="30" data-stroke stroke="#a885f3" />
    <line x1="19" y1="35" x2="20.5" y2="35" data-stroke stroke="#a885f3" />
    <line x1="22" y1="35" x2="33" y2="35" data-stroke stroke="#a885f3" />
  `),
    xml: createGlyph(`
    <path d="M12 6h18l8 8v28H12z" fill="#e69a5a" fill-opacity=".18" />
    <path d="M12 6h18l8 8v28H12z" fill="none" stroke="#e69a5a" stroke-width="1.6" />
    <path d="M30 6v8h8" fill="none" stroke="#e69a5a" stroke-width="1.6" />
    <polyline points="20,22 15,27 20,32" fill="none" stroke="#e69a5a" stroke-width="1.8" />
    <polyline points="28,22 33,27 28,32" fill="none" stroke="#e69a5a" stroke-width="1.8" />
    <line x1="26" y1="21" x2="22" y2="33" stroke="#e69a5a" stroke-width="1.8" />
  `),
    sql: createGlyph(`
    <path d="M10 11 a14 4 0 0 1 28 0 v26 a14 4 0 0 1 -28 0 z" fill="#4fb8a5" fill-opacity=".10" />
    <ellipse cx="24" cy="11" rx="14" ry="4" fill="#4fb8a5" fill-opacity=".25" />
    <ellipse cx="24" cy="11" rx="14" ry="4" data-stroke stroke="#4fb8a5" />
    <path data-stroke stroke="#4fb8a5" d="M10 11 v9 q0 4 14 4 t14 -4 v-9" />
    <path data-stroke stroke="#4fb8a5" d="M10 20 v9 q0 4 14 4 t14 -4 v-9" />
    <path data-stroke stroke="#4fb8a5" d="M10 29 v8 q0 4 14 4 t14 -4 v-8" />
  `),
    git: createGlyph(`
    <circle cx="14" cy="10" r="4" fill="#e69a5a" fill-opacity=".25" />
    <circle cx="14" cy="10" r="4" data-stroke stroke="#e69a5a" />
    <circle cx="14" cy="38" r="4" fill="#e69a5a" fill-opacity=".25" />
    <circle cx="14" cy="38" r="4" data-stroke stroke="#e69a5a" />
    <circle cx="34" cy="24" r="4" fill="#e69a5a" fill-opacity=".25" />
    <circle cx="34" cy="24" r="4" data-stroke stroke="#e69a5a" />
    <line x1="14" y1="14" x2="14" y2="34" data-stroke stroke="#e69a5a" />
    <path data-stroke stroke="#e69a5a" d="M14 16 q0 8 8 8 h8" />
  `),
    lock: createGlyph(`
    <path d="M16 22 V16 Q 16 10 24 10 Q 32 10 32 16 V22" fill="none" stroke="#e7c463" stroke-width="2.2" />
    <rect x="12" y="22" width="24" height="18" rx="2" fill="#e7c463" fill-opacity=".2" stroke="#e7c463" stroke-width="1.6" />
    <circle cx="24" cy="30" r="2" fill="#e7c463" />
    <line x1="24" y1="30" x2="24" y2="35" stroke="#e7c463" stroke-width="1.8" />
  `),
    ini: iniGlyph,
    config: iniGlyph,
    env: createGlyph(`
    <path d="M12 6h17l7 7v26a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" fill="#7b7fd8" fill-opacity=".12" />
    <path data-stroke stroke="#7b7fd8" d="M12 9a3 3 0 0 1 3-3h14l7 7v24a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" />
    <path data-stroke stroke="#7b7fd8" d="M29 6v4a3 3 0 0 0 3 3h4" />
    <rect x="15" y="20" width="5" height="2.4" rx=".5" fill="#7b7fd8" />
    <line x1="21" y1="21.2" x2="22" y2="21.2" data-stroke stroke="#7b7fd8" />
    <circle cx="24" cy="21.2" r=".7" fill="#7b7fd8" />
    <circle cx="26.5" cy="21.2" r=".7" fill="#7b7fd8" />
    <circle cx="29" cy="21.2" r=".7" fill="#7b7fd8" />
    <circle cx="31.5" cy="21.2" r=".7" fill="#7b7fd8" />
    <rect x="15" y="26" width="7" height="2.4" rx=".5" fill="#7b7fd8" />
    <line x1="23" y1="27.2" x2="24" y2="27.2" data-stroke stroke="#7b7fd8" />
    <circle cx="26" cy="27.2" r=".7" fill="#7b7fd8" />
    <circle cx="28.5" cy="27.2" r=".7" fill="#7b7fd8" />
    <circle cx="31" cy="27.2" r=".7" fill="#7b7fd8" />
    <path data-stroke stroke="#7b7fd8" d="M19 36 v-2 a2.5 2.5 0 0 1 5 0 v2" />
    <rect x="17.5" y="36" width="8" height="5" rx="1" fill="#7b7fd8" />
  `),
    sh: shGlyph,
    docker: createGlyph(`
    <g fill="#6d8eff" fill-opacity=".35">
      <rect x="14" y="14" width="6" height="6" rx="1" />
      <rect x="21" y="14" width="6" height="6" rx="1" />
      <rect x="28" y="14" width="6" height="6" rx="1" />
      <rect x="17.5" y="7" width="6" height="6" rx="1" />
      <rect x="24.5" y="7" width="6" height="6" rx="1" />
    </g>
    <g data-stroke stroke="#6d8eff">
      <rect x="14" y="14" width="6" height="6" rx="1" />
      <rect x="21" y="14" width="6" height="6" rx="1" />
      <rect x="28" y="14" width="6" height="6" rx="1" />
      <rect x="17.5" y="7" width="6" height="6" rx="1" />
      <rect x="24.5" y="7" width="6" height="6" rx="1" />
    </g>
    <path d="M6 28 Q 8 22 14 22 H36 Q 42 22 42 28 Q 42 34 34 36 H14 Q 8 36 6 34 Z" fill="#6d8eff" fill-opacity=".22" />
    <path data-stroke stroke="#6d8eff" d="M6 28 Q 8 22 14 22 H36 Q 42 22 42 28 Q 42 34 34 36 H14 Q 8 36 6 34 Z" />
    <path data-stroke stroke="#6d8eff" d="M42 28 l4 -3 v6 z" />
    <circle cx="13" cy="28" r="1" fill="#6d8eff" />
    <path data-stroke stroke="#6d8eff" d="M6 42 q3 -2 6 0 t6 0 t6 0 t6 0 t6 0" />
  `),
    gitignore: createGlyph(`
    <circle cx="14" cy="16" r="3" fill="#e69a5a" fill-opacity=".3" stroke="#e69a5a" stroke-width="1.6" />
    <circle cx="14" cy="32" r="3" fill="#e69a5a" fill-opacity=".3" stroke="#e69a5a" stroke-width="1.6" />
    <circle cx="34" cy="24" r="3" fill="#e69a5a" fill-opacity=".3" stroke="#e69a5a" stroke-width="1.6" />
    <path d="M14 19 V29 M17 32 Q 24 32 24 24 Q 24 16 31 16 Q 34 16 34 21" fill="none" stroke="#e69a5a" stroke-width="1.6" />
    <line x1="8" y1="40" x2="40" y2="8" stroke="#e26d6d" stroke-width="2.2" />
  `),
    readme: createGlyph(`
    <path d="M6 12 q6 -2 18 0 q12 -2 18 0 v26 q-6 -2 -18 0 q-12 -2 -18 0 z" fill="#6d8eff" fill-opacity=".10" />
    <path data-stroke stroke="#6d8eff" d="M6 12 q6 -2 18 0 q12 -2 18 0 v26 q-6 -2 -18 0 q-12 -2 -18 0 z" />
    <line x1="24" y1="12" x2="24" y2="38" data-stroke stroke="#6d8eff" />
    <line x1="10" y1="18" x2="20" y2="17.5" data-stroke stroke="#6d8eff" />
    <line x1="10" y1="23" x2="20" y2="22.5" data-stroke stroke="#6d8eff" />
    <line x1="10" y1="28" x2="18" y2="27.7" data-stroke stroke="#6d8eff" />
    <line x1="28" y1="17.5" x2="38" y2="18" data-stroke stroke="#6d8eff" />
    <line x1="28" y1="22.5" x2="38" y2="23" data-stroke stroke="#6d8eff" />
    <line x1="28" y1="27.7" x2="36" y2="28" data-stroke stroke="#6d8eff" />
  `),
    license: createGlyph(`
    <rect x="8" y="6" width="32" height="28" rx="2" fill="#e0a243" fill-opacity=".12" />
    <rect x="8" y="6" width="32" height="28" rx="2" data-stroke stroke="#e0a243" />
    <line x1="13" y1="13" x2="23" y2="13" data-stroke stroke="#e0a243" />
    <line x1="13" y1="18" x2="35" y2="18" data-stroke stroke="#e0a243" />
    <line x1="13" y1="22" x2="33" y2="22" data-stroke stroke="#e0a243" />
    <line x1="13" y1="26" x2="28" y2="26" data-stroke stroke="#e0a243" />
    <circle cx="32" cy="34" r="6" fill="#e0a243" fill-opacity=".4" />
    <circle cx="32" cy="34" r="6" data-stroke stroke="#e0a243" />
    <circle cx="32" cy="34" r="2.5" fill="#e0a243" />
    <path data-stroke stroke="#e0a243" d="M28 39 L28 44 L32 42 L36 44 L36 39" />
  `),
    vue: createGlyph(`
    <path d="M6 8 L24 40 L42 8 Z" fill="#6fbf8a" fill-opacity=".22" />
    <path data-stroke stroke="#6fbf8a" d="M6 8 L24 40 L42 8 Z" />
    <path d="M15 8 L24 24 L33 8 Z" fill="#6fbf8a" fill-opacity=".45" />
    <path data-stroke stroke="#6fbf8a" d="M15 8 L24 24 L33 8 Z" />
  `),
    jsx: createGlyph(`
    <g transform="translate(24 24)" fill="none" data-stroke stroke="#5ec4d6">
      <ellipse rx="16" ry="6" />
      <ellipse rx="16" ry="6" transform="rotate(60)" />
      <ellipse rx="16" ry="6" transform="rotate(-60)" />
    </g>
    <circle cx="24" cy="24" r="2.6" fill="#5ec4d6" />
  `),
    tsx: createGlyph(`
    <g transform="translate(24 24)" fill="none" data-stroke stroke="#6d8eff">
      <ellipse rx="16" ry="6" />
      <ellipse rx="16" ry="6" transform="rotate(60)" />
      <ellipse rx="16" ry="6" transform="rotate(-60)" />
    </g>
    <circle cx="24" cy="24" r="5" fill="#6d8eff" />
    <text x="24" y="27" font-size="6" fill="#0b0b0d">TS</text>
  `),
    scss: createGlyph(`
    <rect x="6" y="6" width="36" height="36" rx="8" fill="#e58ab8" />
    <rect x="6" y="6" width="36" height="36" rx="8" fill="none" stroke="#bf6d98" stroke-width="1.4" />
    <path d="M18 15 q-4 0 -4 4 v4 q0 2 -2 2 q2 0 2 2 v4 q0 4 4 4" fill="none" stroke="#ffffff" stroke-width="2.6" />
    <path d="M30 15 q4 0 4 4 v4 q0 2 2 2 q-2 0 -2 2 v4 q0 4 -4 4" fill="none" stroke="#ffffff" stroke-width="2.6" />
    <text x="24" y="29" font-size="13" fill="#ffffff">$</text>
  `),
    less: createGlyph(`
    <rect x="7" y="7" width="34" height="34" rx="8" fill="#7b7fd8" fill-opacity=".18" />
    <rect x="7" y="7" width="34" height="34" rx="8" data-stroke stroke="#7b7fd8" />
    <polyline points="20,16 12,24 20,32" data-stroke stroke="#7b7fd8" />
    <path data-stroke stroke="#7b7fd8" d="M24 20 q3 -3 6 0 t6 0" />
    <path data-stroke stroke="#7b7fd8" d="M24 26 q3 -3 6 0 t6 0" />
  `),
    ps1: ps1Glyph,
    bat: batGlyph,
    makefile: makefileGlyph,
} as const satisfies Record<string, IFileIconGlyph>;