// Display formatting — designations, size labels, type names, numbers.

// Designation generator for random seeds
const STAR_PREFIXES = ['LYRA','VEGA','RIGEL','ALTAIR','SIRIUS','ANTARES','POLLUX','CASTOR','ORION','CYGNUS','PROXIMA','KEPLER','HYPERION','CETI','DRACONIS','ANDROMEDA','NEMESIS','PEGASUS','HELIOS','PHOENIX','TITAN','APHELION','PERIHELION','EXOMOON','SAGITTA','LUPUS','CORVUS','OPHIUCHUS','CRUX','BOOTES'];

function randomDesignation() {
  const a = STAR_PREFIXES[Math.floor(Math.random() * STAR_PREFIXES.length)];
  const n = Math.floor(Math.random() * 9000 + 1000);
  const sub = (Math.random() < 0.4) ? '-' + String.fromCharCode(65 + Math.floor(Math.random() * 26)) : '';
  return `${a}-${n}${sub}`;
}

const SIZE_LABELS = ['MICRO','PLUTO','MERCURY','MARS','VENUS','EARTH','URANUS','NEPTUNE','SATURN','JUPITER'];
function sizeLabel(t) {
  const idx = Math.min(SIZE_LABELS.length - 1, Math.floor(t * SIZE_LABELS.length));
  return SIZE_LABELS[idx];
}

const TYPE_NAMES = {
  terrestrial: 'TERRESTRIAL',
  primordial: 'PRIMORDIAL',
  ocean: 'OCEAN WORLD',
  desert: 'DESERT',
  ice: 'ICE / FROZEN',
  volcanic: 'VOLCANIC',
  cratered: 'CRATERED ROCK',
  dwarf_planet: 'DWARF PLANET',
  asteroid: 'ASTEROID',
  gas_giant: 'GAS GIANT',
  ice_giant: 'ICE GIANT',
  brown_dwarf: 'BROWN DWARF',
};

function fmt(n, digits) {
  digits = digits || 2;
  if (Math.abs(n) >= 1000) return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n.toFixed(digits);
}

export { STAR_PREFIXES, randomDesignation, SIZE_LABELS, sizeLabel, TYPE_NAMES, fmt };
