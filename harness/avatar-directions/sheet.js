/*
 * Contact sheets for the avatar directions.
 *   index.html?d=A    one direction: sidebars of 12 (dark, light) at real
 *                     size, every variant at 48px, a size ramp, 96px
 *   index.html?d=all  every direction side by side, lettered
 */
(function () {
  'use strict';
  const { list, hues } = window.AVATAR_DIRECTIONS;
  const params = new URLSearchParams(location.search);
  const which = params.get('d') || 'all';
  const only = params.get('only'); // a comma list of letters for the summary

  const TEAM = [
    ['Chief of Staff', 'blue'],
    ['Hiring', 'green'],
    ['Finance', 'amber'],
    ['Sales', 'red'],
    ['Social', 'pink'],
    ['Research', 'violet'],
    ['Acme Site', 'teal'],
    ['Support', 'orange'],
    ['Lead Gen', 'sky'],
    ['Legal', 'slate'],
    ['Ops', 'green'],
    ['Travel', 'pink'],
  ];
  const SELECTED = 2;

  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const av = (dir, i, hue, px, theme, ctx) => dir.render(i, hue, px, theme, ctx || {});
  const variantOf = (dir, i) => i % dir.variants.length;

  function sidebar(dir, theme, compact, face, rows) {
    const s = el('div', `panel t-${theme} sidebar${compact ? ' sidebar--compact' : ''}`);
    const label = face !== undefined && dir.faces ? dir.faces[face] : theme === 'dark' ? 'Dark' : 'Light';
    s.appendChild(el('div', 'label', label));
    TEAM.slice(0, rows || 12).forEach(([name, hue], i) => {
      const selected = i === SELECTED;
      const row = el('div', `row${selected ? ' row--on' : ''}`);
      row.innerHTML =
        `<span class="av">${av(dir, variantOf(dir, i), hue, 24, theme, { name, selected, face })}</span>` +
        `<span class="name">${name}</span>`;
      s.appendChild(row);
    });
    return s;
  }

  function grid(dir, theme, px, count, cols) {
    const g = el('div', `panel t-${theme} grid`);
    g.style.gridTemplateColumns = `repeat(${cols}, ${px}px)`;
    for (let i = 0; i < count; i++) {
      const hue = hues[(i * 3) % hues.length];
      g.appendChild(el('span', 'cell', av(dir, variantOf(dir, i), hue, px, theme, { name: TEAM[i % 12][0] })));
    }
    return g;
  }

  /** Faces × shapes, for a direction whose face is chosen separately. */
  function faceGrid(dir, theme, px) {
    const g = el('div', `panel t-${theme} grid grid--faces`);
    g.style.gridTemplateColumns = `90px repeat(${dir.variants.length}, ${px}px)`;
    dir.faces.forEach((f, fi) => {
      g.appendChild(el('span', 'caption', f));
      dir.variants.forEach((_, vi) => {
        const [name, hue] = TEAM[(fi * 4 + vi) % 12];
        g.appendChild(el('span', 'cell', av(dir, vi, hue, px, theme, { name, face: fi })));
      });
    });
    return g;
  }

  /** The four face treatments on one shape, 2x2. */
  function faceSquare(dir, theme) {
    const g = el('div', `panel t-${theme} grid`);
    g.style.gridTemplateColumns = 'repeat(2, 48px)';
    dir.faces.forEach((_, fi) => {
      const [name, hue] = TEAM[fi + 1];
      g.appendChild(el('span', 'cell', av(dir, fi % dir.variants.length, hue, 48, theme, { name, face: fi })));
    });
    return g;
  }

  function ramp(dir, theme) {
    const r = el('div', `panel t-${theme} ramp`);
    [0, 1].forEach((n) => {
      const [name, hue] = TEAM[n * 4 + 1];
      const line = el('div', 'ramp__line');
      [16, 20, 28, 48, 96].forEach((px) => {
        line.appendChild(el('span', 'cell', av(dir, variantOf(dir, n * 4 + 1), hue, px, theme, { name })));
      });
      r.appendChild(line);
    });
    r.appendChild(el('div', 'caption', '16 · 20 · 28 · 48 · 96px'));
    return r;
  }

  function hero(dir, theme) {
    const h = el('div', `panel t-${theme} hero`);
    for (let i = 0; i < Math.max(4, Math.min(dir.variants.length, 5)); i++) {
      const [name, hue] = TEAM[i];
      h.appendChild(el('span', 'cell', av(dir, variantOf(dir, i), hue, 96, theme, { name })));
    }
    return h;
  }

  function directionSheet(dir) {
    document.body.className = 'one';
    const root = el('main', 'sheet');
    root.appendChild(
      el(
        'header',
        'head',
        `<span class="letter">${dir.key}</span><div><h1>${dir.name}</h1><p>${dir.rule}</p>` +
          `<p class="variants">${dir.variants.join(' · ')}</p></div>`
      )
    );
    const two = (make) => {
      const w = el('div', 'pair');
      w.appendChild(make('dark'));
      w.appendChild(make('light'));
      return w;
    };
    root.appendChild(el('h2', null, 'Sidebar, real size (24px)'));
    root.appendChild(two((t) => sidebar(dir, t)));
    if (dir.faces) {
      root.appendChild(el('h2', null, 'The face is a separate choice: each treatment in a sidebar'));
      ['dark', 'light'].forEach((t) => {
        const four = el('div', 'quad');
        dir.faces.forEach((_, fi) => four.appendChild(sidebar(dir, t, true, fi, 6)));
        root.appendChild(four);
      });
      root.appendChild(el('h2', null, 'Every shape × every face at 48px'));
      root.appendChild(faceGrid(dir, 'dark', 48));
      root.appendChild(faceGrid(dir, 'light', 48));
    } else {
      root.appendChild(el('h2', null, 'Every variant at 48px'));
      root.appendChild(two((t) => grid(dir, t, 48, 12, 4)));
    }
    root.appendChild(el('h2', null, 'Sizes'));
    root.appendChild(two((t) => ramp(dir, t)));
    root.appendChild(el('h2', null, '96px'));
    root.appendChild(hero(dir, 'dark'));
    root.appendChild(hero(dir, 'light'));
    return root;
  }

  function summary() {
    document.body.className = 'all';
    const root = el('main', 'summary');
    root.style.setProperty('--cols', params.get('cols') || '2');
    const keys = only ? only.split(',') : null;
    list
      .filter((d) => !keys || keys.includes(d.key))
      .forEach((dir) => {
        const card = el('section', 'card');
        card.appendChild(el('header', 'card__head', `<span class="letter">${dir.key}</span><h1>${dir.name}</h1>`));
        const sides = el('div', 'pair');
        sides.appendChild(sidebar(dir, 'dark', true));
        sides.appendChild(sidebar(dir, 'light', true));
        card.appendChild(sides);
        const big = el('div', 'pair');
        big.appendChild(dir.faces ? faceSquare(dir, 'dark') : grid(dir, 'dark', 48, 4, 2));
        big.appendChild(dir.faces ? faceSquare(dir, 'light') : grid(dir, 'light', 48, 4, 2));
        card.appendChild(big);
        root.appendChild(card);
      });
    return root;
  }

  const dir = list.find((d) => d.key === which);
  document.getElementById('root').appendChild(dir ? directionSheet(dir) : summary());
})();
