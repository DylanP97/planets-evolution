// ====== 24. Random names ======
// Hand-curated cosmic word bank (mythology + astronomy + Greek letters).
export let systemName = 'Sol';
// Raw binding setter — the user-facing rename flow is setSystemName in ui/naming.js.
export function setSystemNameValue(v) { systemName = v; }

// Roman numerals for default planet names ("Planet I", "Planet II", …).
export const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];

export const COSMIC_WORDS = {
  greek: ['Alpha','Beta','Gamma','Delta','Epsilon','Zeta','Eta','Theta','Iota','Kappa','Lambda','Mu','Nu','Xi','Omicron','Pi','Rho','Sigma','Tau','Upsilon','Phi','Chi','Psi','Omega'],
  mythos: ['Aether','Apollo','Athena','Cronus','Helios','Hyperion','Selene','Eos','Hekate','Nyx','Erebus','Hades','Poseidon','Ares','Hermes','Triton','Nereus','Thalassa','Gaia','Hestia','Hephaestus','Aurora','Bellona','Ceres','Diana','Faunus','Flora','Freya','Loki','Thor','Odin','Frigg','Tyr','Heimdall','Vali','Vidar','Ymir','Skadi','Bragi','Idun','Mimir','Forseti','Sif'],
  stars: ['Kepler','Hubble','Cassini','Galileo','Webb','Voyager','Pioneer','Sirius','Vega','Rigel','Altair','Procyon','Polaris','Antares','Arcturus','Deneb','Spica','Aldebaran','Capella','Lyra','Cygnus','Orion','Hydra','Draco','Phoenix','Pegasus','Andromeda','Carina','Nebula','Quasar','Pulsar','Cosmos','Nova','Halo','Eon','Helix','Tycho','Brahe'],
  moonish: ['Phobos','Deimos','Charon','Hydra','Nix','Kerberos','Styx','Triton','Nereid','Proteus','Naiad','Despina','Galatea','Larissa','Bianca','Cressida','Desdemona','Juliet','Portia','Rosalind','Belinda','Puck','Miranda','Ariel','Umbriel','Titania','Oberon','Calypso','Telesto','Tethys','Dione','Rhea','Iapetus','Phoebe','Hyperion','Mimas','Enceladus','Pan','Atlas','Prometheus','Pandora','Janus','Epimetheus','Helene','Polydeuces','Methone','Anthe','Pallene','Tarvos','Erriapus','Jarnsaxa','Bebhionn','Skathi','Albiorix','Paaliaq','Siarnaq','Suttungr','Thrymr','Mundilfari','Kari','Fenrir','Aegaeon'],
  designators: ['Prime','Major','Minor','II','III','IV','V','VI','VII','IX','XII','XV','XX'],
};

function _pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

export function generateCosmic(kind) {
  const r = Math.random();
  if (kind === 'moon') {
    if (r < 0.6) return _pick(COSMIC_WORDS.moonish);
    if (r < 0.85) return _pick(COSMIC_WORDS.mythos);
    return _pick(COSMIC_WORDS.greek) + ' ' + _pick(COSMIC_WORDS.moonish);
  }
  if (kind === 'system') {
    if (r < 0.4) return _pick(COSMIC_WORDS.stars);
    if (r < 0.7) return _pick(COSMIC_WORDS.greek) + ' ' + _pick(COSMIC_WORDS.stars);
    if (r < 0.9) return _pick(COSMIC_WORDS.mythos) + "'s Reach";
    return _pick(COSMIC_WORDS.stars) + '-' + (100 + ((Math.random() * 900) | 0));
  }
  // planet
  if (r < 0.3) return _pick(COSMIC_WORDS.mythos);
  if (r < 0.55) return _pick(COSMIC_WORDS.stars) + ' ' + _pick(COSMIC_WORDS.designators);
  if (r < 0.75) return _pick(COSMIC_WORDS.greek) + ' ' + _pick(COSMIC_WORDS.mythos);
  if (r < 0.9) return _pick(COSMIC_WORDS.stars) + '-' + (10 + ((Math.random() * 990) | 0));
  return _pick(COSMIC_WORDS.mythos) + ' ' + _pick(COSMIC_WORDS.designators);
}

export function generateName(kind) {
  return generateCosmic(kind);
}

