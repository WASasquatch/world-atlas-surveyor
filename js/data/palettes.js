// Base color palettes per planet type.

import { hexToRgb } from '../core/color.js';

// Palette per planet type — base, mid, high, peak, water-deep, water-shallow
const PALETTES = {
  terrestrial: {
    deepWater: hexToRgb('#0a2840'),
    water:     hexToRgb('#1d5d82'),
    shore:     hexToRgb('#5fa9c8'),
    beach:     hexToRgb('#c9b888'),
    lowland:   hexToRgb('#3a6e3a'),
    plains:    hexToRgb('#5d8a4a'),
    forest:    hexToRgb('#2e5a30'),
    arid:      hexToRgb('#8a7a4a'),
    hills:     hexToRgb('#75614a'),
    mountain:  hexToRgb('#5d5048'),
    peak:      hexToRgb('#c8c8d0'),
    cloudCol:  hexToRgb('#f0f4f8'),
    atmCol:    hexToRgb('#5a9adf'),
    polarIce:  hexToRgb('#e8f0f8'),
    auroraCol: hexToRgb('#40e890'),
  },
  primordial: {
    // Young-Earth: dark green algal seas, sparse vegetation on land,
    // basalt scarred by lava-flow provinces, ash-stained skies.
    deepWater: hexToRgb('#082818'),  // very dark algal-green abyss
    water:     hexToRgb('#0e4828'),  // chlorophyll-loaded sea
    shore:     hexToRgb('#3a8848'),  // bright reedy shore
    beach:     hexToRgb('#605838'),  // muddy shoreline (no white sand yet)
    lowland:   hexToRgb('#2a4820'),  // sparse moss/lichen
    plains:    hexToRgb('#4a5828'),  // proto-grass with bare patches
    forest:    hexToRgb('#1a3818'),  // primitive ferny growth
    arid:      hexToRgb('#806840'),  // ash-dusted basalt plains
    hills:     hexToRgb('#503830'),  // weathered basalt
    mountain:  hexToRgb('#382820'),  // unweathered basalt cliffs
    peak:      hexToRgb('#1a1410'),  // dark volcanic spires
    // Lava palette — flood basalts, hot rivers
    lava:      hexToRgb('#d83018'),
    lavaHot:   hexToRgb('#ff8030'),
    basalt:    hexToRgb('#181010'),  // freshly cooled flow
    // Atmosphere & clouds
    cloudCol:  hexToRgb('#d8c8a0'),  // dirty-cream baseline cloud
    ashCloud:  hexToRgb('#3a2818'),  // dark ash near volcanic provinces
    atmCol:    hexToRgb('#c87838'),  // CO2-orange greenhouse haze
    polarIce:  hexToRgb('#d8d0a8'),  // dirty/glacial polar (rare)
    auroraCol: hexToRgb('#ff8060'),
  },
  ocean: {
    deepWater: hexToRgb('#08182a'),
    water:     hexToRgb('#16486e'),
    shore:     hexToRgb('#4a96b6'),
    beach:     hexToRgb('#a89c70'),
    lowland:   hexToRgb('#5a7848'),
    plains:    hexToRgb('#6a8855'),
    forest:    hexToRgb('#3d5e38'),
    arid:      hexToRgb('#80724a'),
    hills:     hexToRgb('#6e5a44'),
    mountain:  hexToRgb('#564a40'),
    peak:      hexToRgb('#d4d4dc'),
    cloudCol:  hexToRgb('#e8eef4'),
    atmCol:    hexToRgb('#3d8ad8'),
    polarIce:  hexToRgb('#dce6f0'),
    auroraCol: hexToRgb('#50d8b0'),
  },
  desert: {
    lowland:   hexToRgb('#c47840'),
    plains:    hexToRgb('#d68a4a'),
    forest:    hexToRgb('#a05a2c'),
    arid:      hexToRgb('#e09c5a'),
    hills:     hexToRgb('#9a5230'),
    mountain:  hexToRgb('#6e3820'),
    peak:      hexToRgb('#4e2814'),
    cloudCol:  hexToRgb('#e8c8a0'),
    atmCol:    hexToRgb('#d49060'),
    polarIce:  hexToRgb('#e8d8b8'),
    auroraCol: hexToRgb('#ff9040'),
  },
  ice: {
    lowland:   hexToRgb('#a8c4dc'),
    plains:    hexToRgb('#c4dceb'),
    forest:    hexToRgb('#90b4d0'),
    arid:      hexToRgb('#dcecf4'),
    hills:     hexToRgb('#6a8aa8'),
    mountain:  hexToRgb('#4a6480'),
    peak:      hexToRgb('#f4f8fc'),
    crevice:   hexToRgb('#1a4068'),
    cloudCol:  hexToRgb('#e0e8f0'),
    atmCol:    hexToRgb('#a0c0e0'),
    polarIce:  hexToRgb('#ffffff'),
    auroraCol: hexToRgb('#7af0ff'),
  },
  volcanic: {
    lava:      hexToRgb('#ff6420'),
    lavaHot:   hexToRgb('#ffc060'),
    crust:     hexToRgb('#1a1010'),
    ash:       hexToRgb('#2a2018'),
    rock:      hexToRgb('#3a2820'),
    sulfur:    hexToRgb('#8a7028'),
    peak:      hexToRgb('#1a0a08'),
    cloudCol:  hexToRgb('#5a4030'),
    atmCol:    hexToRgb('#a04020'),
    polarIce:  hexToRgb('#3a2820'),
    auroraCol: hexToRgb('#ff5040'),
  },
  cratered: {
    lowland:   hexToRgb('#5a5048'),
    plains:    hexToRgb('#6a5e54'),
    forest:    hexToRgb('#4a4038'),
    arid:      hexToRgb('#7a6e64'),
    hills:     hexToRgb('#544840'),
    mountain:  hexToRgb('#3a3028'),
    peak:      hexToRgb('#8a807a'),
    crater:    hexToRgb('#2a2218'),
    rim:       hexToRgb('#9a8e84'),
    cloudCol:  hexToRgb('#7a7068'),
    atmCol:    hexToRgb('#6a5e54'),
    polarIce:  hexToRgb('#a8a098'),
    auroraCol: hexToRgb('#a0a0c0'),
  },
  gas_giant: {
    bands: [
      hexToRgb('#c89860'),
      hexToRgb('#e8b878'),
      hexToRgb('#a06840'),
      hexToRgb('#d8a868'),
      hexToRgb('#8a5828'),
      hexToRgb('#f0d098'),
    ],
    storm:  hexToRgb('#c84028'),
    cloud:  hexToRgb('#f8e8c8'),
    atmCol: hexToRgb('#e8a868'),
    auroraCol: hexToRgb('#80a0ff'),
  },
  ice_giant: {
    bands: [
      hexToRgb('#3a78d0'),
      hexToRgb('#5a98e0'),
      hexToRgb('#2858a8'),
      hexToRgb('#7ab0e8'),
      hexToRgb('#1a4080'),
      hexToRgb('#a0c8f0'),
    ],
    storm:  hexToRgb('#0a2860'),
    cloud:  hexToRgb('#e0f0fc'),
    atmCol: hexToRgb('#5098e8'),
    auroraCol: hexToRgb('#a060ff'),
  },
  // Dwarf planet — small mostly-round icy/rocky bodies (Pluto/Ceres/Eris).
  // Often have bright/dark surface contrasts from tholin deposits and
  // nitrogen/methane ices.
  dwarf_planet: {
    water:     hexToRgb('#4a4a52'),
    deepWater: hexToRgb('#2a2a30'),
    shore:     hexToRgb('#605860'),
    beach:     hexToRgb('#a89888'),
    lowland:   hexToRgb('#7a6c64'),
    plains:    hexToRgb('#8a7a70'),
    arid:      hexToRgb('#a0907c'),
    forest:    hexToRgb('#5a5048'),
    hills:     hexToRgb('#6a6058'),
    mountain:  hexToRgb('#4a4238'),
    peak:      hexToRgb('#988878'),
    crater:    hexToRgb('#3a322a'),
    rim:       hexToRgb('#a89a88'),
    cloudCol:  hexToRgb('#e8e0d8'),
    atmCol:    hexToRgb('#806848'),
    polarIce:  hexToRgb('#e0d8d0'),
    auroraCol: null,  // dwarf planets lack the magnetic fields for auroras
  },
  // Asteroid — irregular rocky bodies, no atmosphere, heavy cratering.
  // Mineralogical variations (S-type silicaceous, C-type carbonaceous,
  // M-type metallic) — variants will override the base.
  asteroid: {
    water:     hexToRgb('#383028'),
    deepWater: hexToRgb('#1a1612'),
    shore:     hexToRgb('#4a4038'),
    beach:     hexToRgb('#787068'),
    lowland:   hexToRgb('#6a5e54'),
    plains:    hexToRgb('#786c60'),
    arid:      hexToRgb('#8a7c6c'),
    forest:    hexToRgb('#4c4238'),
    hills:     hexToRgb('#5e5448'),
    mountain:  hexToRgb('#403830'),
    peak:      hexToRgb('#9a8c7c'),
    crater:    hexToRgb('#28201a'),
    rim:       hexToRgb('#a89a88'),
    cloudCol:  hexToRgb('#000000'),  // no atmosphere
    atmCol:    hexToRgb('#000000'),
    polarIce:  hexToRgb('#a89c8c'),  // no real polar caps, just dust
    auroraCol: null,
  },
  // Brown dwarf — failed star, glows from internal heat. Dark cool clouds
  // overlay above hot incandescent interior. Bands of opaque gas reveal
  // hot lower deck where they are thinner.
  brown_dwarf: {
    bands: [
      hexToRgb('#3a1a18'),  // dark cool top deck
      hexToRgb('#5a2a20'),
      hexToRgb('#1a0a08'),  // very dark cloud band
      hexToRgb('#702820'),
      hexToRgb('#2a1410'),
      hexToRgb('#4a1e18'),
    ],
    // Hot interior glow shown through cloud breaks
    glow:    hexToRgb('#ff8038'),
    glowHot: hexToRgb('#ffd078'),
    storm:   hexToRgb('#1a0608'),  // darker storm regions
    cloud:   hexToRgb('#180a08'),  // dark wispy cloud caps
    atmCol:  hexToRgb('#702820'),
    // No visible auroras — real brown dwarf auroras emit primarily in
    // radio frequencies, not visible light. Bright aurora crescents on a
    // self-emitting body also read as atmosphere artifacts.
    auroraCol: null,
  },
};

export { PALETTES };
