// Title-level coarse screen: lists only titles that are clearly irrelevant to low-dimensional/2D materials.
// Everything not matched passes on to abstract reading. Read-only; no model, network or catalog writes.
// Usage: node title-screen.mjs <input.json> [--out screened.json]
//   input: JSON array (or {papers|records:[...]}) of {id,title,...}. --out writes [{id,group,match}].
// Validated on 57,856 labeled titles (2026-10-21 rebuild): screens 11.1% of papers read, lost 1/7501 includes.
// Energy/catalysis words are deliberately NOT here: 2D materials are common platforms for them (15 includes carried such words).
import fs from 'node:fs';
export const groups={
 particle_cosmo:/\b(neutrinos?|higgs boson|quarks?|gluons?|hadrons?|collider|black holes?|gravitational waves?|cosmolog\w*|supernovae?|galaxies|neutron stars?|baryons?|leptons?|nucleons?|heavy[- ]ion collisions?|QCD|standard model|quantum gravity|string theory|big bang|pulsars?|exoplanets?|dark matter (halos?|search\w*|candidates?)|nuclear (reactions?|fusion|fission))\b/i,
 plasma_fluid:/\b(tokamaks?|turbulen\w*|navier[- ]stokes|combustion|aerodynamic\w*|shock waves?|boundary layers?|reynolds number|geophysic\w*|earthquakes?|ocean\w*|atmospheric (flow|dynamics|chemistry)|climate|weather|laser[- ]produced plasmas?|plasma (physics|instabilit\w+|turbulence))\b/i,
 biomed:/\b(cancers?|tumou?rs?|antibod(y|ies)|bacteria(l)?|viruses|viral infection|in vivo|drug delivery|gene (therapy|editing)|CRISPR|stem cells?|vaccines?|cytotoxic\w*|photothermal therapy|photodynamic therapy|theranostic\w*|antibacterial|antimicrobial|wound healing|tissue engineering|biofilms?|living cells|mammalian|clinical|patients?|pathogens?|immunotherap\w*|microbiome)\b/i,
 coldatom_qinfo:/\b(ultracold|trapped[- ]ions?|ion traps?|optical lattices? (clock|experiment)|optical tweezers? arrays?|cold atoms?|atom interferomet\w+|atomic clocks?|laser cooling of (atoms|ions)|quantum error correction|surface code|quantum key distribution|quantum teleportation|boson sampling|quantum annealing)\b/i,
 stat_social:/\b(epidemic\w*|opinion dynamics|financial markets?|stock market|traffic flow|social networks?|evolutionary game\w*|population dynamics|large language models?)\b/i,
 non_research:/\b(erratum|corrigendum|publisher.?s note|addendum|retraction|expression of concern)\b/i,
};
export function screen(title){for(const [group,re] of Object.entries(groups)){const m=re.exec(title||'');if(m)return {group,match:m[0]};}return null;}
if(process.argv[1]&&process.argv[1].endsWith('title-screen.mjs')){
 const file=process.argv[2];if(!file)throw Error('Usage: title-screen.mjs <input.json> [--out screened.json]');
 const data=JSON.parse(fs.readFileSync(file,'utf8'));const rows=Array.isArray(data)?data:(data.papers||data.records||[]);
 const hits=rows.map(r=>({id:r.id,...screen(r.title)})).filter(h=>h.group);
 const by={};for(const h of hits)by[h.group]=(by[h.group]||0)+1;
 console.log(JSON.stringify({total:rows.length,screened:hits.length,pass_to_abstract_reading:rows.length-hits.length,by_group:by}));
 const o=process.argv.indexOf('--out');if(o>0)fs.writeFileSync(process.argv[o+1],JSON.stringify(hits,null,1)+'\n');
}
