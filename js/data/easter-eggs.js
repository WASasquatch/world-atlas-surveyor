// Named-world easter-egg seeds (VULCAN, ARRAKIS, ...).

// ============================================================
// EASTER-EGG SEEDS — named worlds from sci-fi and real exoplanets.
// When the user enters one of these as a seed, the planet generator
// overrides type/atmosphere/size/variant to match the canonical world.
// All other generation (continents, mountain noise, clouds, etc.)
// remains seeded by the seed string, so re-rolling produces the same
// world every time — the override just sets the stage.
//
// Lookup is case-insensitive and trimmed. Variant names referenced here
// must exist in TYPE_VARIANTS for the matching type, flagged _easterEgg.
// ============================================================
const EASTER_EGGS = {
  // ===== Solar System — Earth's neighborhood =====
  'MERCURY':      { type: 'cratered',     atmosphere: 'none',  size: 0.32, forceVariant: 'Mercurian' },
  'VENUS':        { type: 'volcanic',     atmosphere: 'dense', size: 0.55, forceVariant: 'Venusian' },
  'MARS':         { type: 'desert',       atmosphere: 'thin',  size: 0.42, forceVariant: 'Mars-like' },
  'JUPITER':      { type: 'gas_giant',    atmosphere: 'dense', size: 0.95, forceVariant: 'Jovian' },
  'SATURN':       { type: 'gas_giant',    atmosphere: 'dense', size: 0.90, forceVariant: 'Saturnian' },
  'URANUS':       { type: 'ice_giant',    atmosphere: 'thick', size: 0.75, forceVariant: 'Uranian' },
  'NEPTUNE':      { type: 'ice_giant',    atmosphere: 'thick', size: 0.78, forceVariant: 'Neptunian' },
  // ----- Moons & dwarf planets -----
  'LUNA':         { type: 'cratered',     atmosphere: 'none',  size: 0.30, forceVariant: 'Lunar' },
  'MOON':         { type: 'cratered',     atmosphere: 'none',  size: 0.30, forceVariant: 'Lunar' },
  'IO':           { type: 'volcanic',     atmosphere: 'thin',  size: 0.32, forceVariant: 'Sulfur World' },
  'EUROPA':       { type: 'ice',          atmosphere: 'none',  size: 0.30, forceVariant: 'Europan' },
  'GANYMEDE':     { type: 'cratered',     atmosphere: 'none',  size: 0.36, forceVariant: 'Frost Cratered' },
  'CALLISTO':     { type: 'cratered',     atmosphere: 'none',  size: 0.34, forceVariant: 'Iron Cratered' },
  'TITAN':        { type: 'terrestrial',  atmosphere: 'dense', size: 0.42, forceVariant: 'Methane Amber' },
  'ENCELADUS':    { type: 'ice',          atmosphere: 'none',  size: 0.22, forceVariant: 'Pristine Ice' },
  'TRITON':       { type: 'ice',          atmosphere: 'thin',  size: 0.30, forceVariant: 'Tholin Ice' },
  'PLUTO':        { type: 'dwarf_planet', atmosphere: 'none',  size: 0.26, forceVariant: 'Plutoid' },
  'CERES':        { type: 'dwarf_planet', atmosphere: 'none',  size: 0.22, forceVariant: 'Carbonaceous' },
  'ERIS':         { type: 'dwarf_planet', atmosphere: 'none',  size: 0.25, forceVariant: 'Methane Frost' },
  'MAKEMAKE':     { type: 'dwarf_planet', atmosphere: 'none',  size: 0.24, forceVariant: 'Tholin' },
  'HAUMEA':       { type: 'dwarf_planet', atmosphere: 'none',  size: 0.24, forceVariant: 'Plutoid' },
  'SEDNA':        { type: 'dwarf_planet', atmosphere: 'none',  size: 0.23, forceVariant: 'Tholin' },
  'PHOBOS':       { type: 'asteroid',     atmosphere: 'none',  size: 0.16, forceVariant: 'C-Type / Carbonaceous' },
  'DEIMOS':       { type: 'asteroid',     atmosphere: 'none',  size: 0.14, forceVariant: 'C-Type / Carbonaceous' },
  'VESTA':        { type: 'asteroid',     atmosphere: 'none',  size: 0.20, forceVariant: 'S-Type / Silicaceous' },
  'PSYCHE':       { type: 'asteroid',     atmosphere: 'none',  size: 0.22, forceVariant: 'M-Type / Metallic' },

  // ===== Star Trek =====
  'VULCAN':       { type: 'desert',       atmosphere: 'thin',  size: 0.55, forceVariant: 'Vulcan' },
  "QO'NOS":       { type: 'volcanic',     atmosphere: 'thick', size: 0.60, forceVariant: 'Klingon' },
  'QONOS':        { type: 'volcanic',     atmosphere: 'thick', size: 0.60, forceVariant: 'Klingon' },
  'KRONOS':       { type: 'volcanic',     atmosphere: 'thick', size: 0.60, forceVariant: 'Klingon' },
  'ROMULUS':      { type: 'terrestrial',  atmosphere: 'thick', size: 0.55, forceVariant: 'Romulan' },
  'REMUS':        { type: 'volcanic',     atmosphere: 'thick', size: 0.50, forceVariant: 'Klingon' },
  'BAJOR':        { type: 'terrestrial',  atmosphere: 'thick', size: 0.50, forceVariant: 'Bajoran' },
  'CARDASSIA':    { type: 'desert',       atmosphere: 'thin',  size: 0.55, forceVariant: 'Cardassian' },
  'ANDORIA':      { type: 'ice',          atmosphere: 'thin',  size: 0.45, forceVariant: 'Andorian' },
  'RISA':         { type: 'terrestrial',  atmosphere: 'thick', size: 0.50, forceVariant: 'Risan' },
  'TRILL':        { type: 'terrestrial',  atmosphere: 'thick', size: 0.50, forceVariant: 'Trill' },
  'BETAZED':      { type: 'terrestrial',  atmosphere: 'thick', size: 0.50, forceVariant: 'Betazed' },
  'GENESIS':      { type: 'terrestrial',  atmosphere: 'thick', size: 0.50, forceVariant: 'Genesis' },
  'FERENGINAR':   { type: 'ocean',        atmosphere: 'dense', size: 0.50, forceVariant: 'Algal Sea' },
  'NIBIRU':       { type: 'terrestrial',  atmosphere: 'thick', size: 0.50, forceVariant: 'Nibiran' },
  'DELTA-VEGA':   { type: 'ice',          atmosphere: 'thin',  size: 0.45, forceVariant: 'Pristine Ice' },

  // ===== Star Wars =====
  'TATOOINE':     { type: 'desert',       atmosphere: 'thin',  size: 0.45, forceVariant: 'Tatooine' },
  'JAKKU':        { type: 'desert',       atmosphere: 'thin',  size: 0.45, forceVariant: 'Tatooine' },
  'GEONOSIS':     { type: 'desert',       atmosphere: 'thin',  size: 0.50, forceVariant: 'Geonosian' },
  'HOTH':         { type: 'ice',          atmosphere: 'thin',  size: 0.45, forceVariant: 'Hoth' },
  'MUSTAFAR':     { type: 'volcanic',     atmosphere: 'thick', size: 0.50, forceVariant: 'Mustafar' },
  'DAGOBAH':      { type: 'terrestrial',  atmosphere: 'thick', size: 0.45, forceVariant: 'Dagobah' },
  'NABOO':        { type: 'terrestrial',  atmosphere: 'thick', size: 0.50, forceVariant: 'Risan' },
  'KAMINO':       { type: 'ocean',        atmosphere: 'dense', size: 0.50, forceVariant: 'Kaminoan' },
  'ENDOR':        { type: 'terrestrial',  atmosphere: 'thick', size: 0.40, forceVariant: 'Verdant' },
  'BESPIN':       { type: 'gas_giant',    atmosphere: 'dense', size: 0.80, forceVariant: 'Bespin' },
  'YAVIN':        { type: 'gas_giant',    atmosphere: 'dense', size: 0.85, forceVariant: 'Jovian' },
  'CRAIT':        { type: 'desert',       atmosphere: 'thin',  size: 0.40, forceVariant: 'Salt Flats' },

  // ===== Dune =====
  'ARRAKIS':      { type: 'desert',       atmosphere: 'thin',  size: 0.50, forceVariant: 'Arrakis' },
  'DUNE':         { type: 'desert',       atmosphere: 'thin',  size: 0.50, forceVariant: 'Arrakis' },
  'CALADAN':      { type: 'ocean',        atmosphere: 'thick', size: 0.50, forceVariant: 'Tropical Sea' },
  'GIEDI-PRIME':  { type: 'volcanic',     atmosphere: 'thick', size: 0.55, forceVariant: 'Obsidian' },

  // ===== Other sci-fi & fantasy =====
  'PANDORA':      { type: 'terrestrial',  atmosphere: 'thick', size: 0.55, forceVariant: 'Pandora' },
  'GALLIFREY':    { type: 'terrestrial',  atmosphere: 'thick', size: 0.55, forceVariant: 'Gallifrey' },
  'SKARO':        { type: 'desert',       atmosphere: 'thin',  size: 0.50, forceVariant: 'Volcanic Ash' },
  'MAGRATHEA':    { type: 'cratered',     atmosphere: 'none',  size: 0.40, forceVariant: 'Lunar' },
  'MORDOR':       { type: 'volcanic',     atmosphere: 'thick', size: 0.50, forceVariant: 'Mordor' },
  'SOLARIA':      { type: 'ocean',        atmosphere: 'thick', size: 0.55, forceVariant: 'Tropical Sea' },
};

export { EASTER_EGGS };
