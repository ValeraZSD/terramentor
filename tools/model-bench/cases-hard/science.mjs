/**
 * Physics, chemistry and biology solved cold: twelve orderings of eight
 * tabulated quantities, several pairs within one or two per cent of each
 * other, so a trend or a half-remembered table puts some pair the wrong way
 * round. Values (NIST, CRC Handbook and PDG figures as listed on Wikipedia):
 *   first ionization energy, kJ/mol: Xe 1170.4, Cl 1251.2, H 1312.0,
 *     O 1313.9, Kr 1350.8, N 1402.3, Ar 1520.6, F 1681.0;
 *   half-life: Co-60 5.27 y, Kr-85 10.76 y, H-3 12.32 y, Sr-90 28.8 y,
 *     Cs-137 30.1 y, Pu-238 87.7 y, Am-241 432.2 y, Ra-226 1600 y;
 *   density, g/cm³: Ag 10.49, Pb 11.34, Pd 12.02, Rh 12.41, Hg 13.53,
 *     Ta 16.69, Re 21.02, Pt 21.45;
 *   standard reduction potential, V: Li −3.04, K −2.93, Ca −2.87, Na −2.71,
 *     Mg −2.37, Ni −0.257, Sn −0.138, Pb −0.126;
 *   surface escape velocity, km/s: Europa 2.025, Moon 2.38, Callisto 2.440,
 *     Io 2.558, Titan 2.639, Ganymede 2.741, Mercury 4.25, Mars 5.03;
 *   diploid chromosome number: mouse 40, rat 42, rabbit 44, human 46,
 *     chimpanzee 48, sheep 54, donkey 62, horse 64;
 *   mass, MeV/c²: muon 105.66, π⁰ 134.98, π± 139.57, K± 493.68, K⁰ 497.61,
 *     η 547.86, proton 938.27, neutron 939.57;
 *   pH of 0.10 mol/L solutions at 25 °C, computed from pKa 2.15, 7.20, 4.76,
 *     9.25, 6.35/10.33: H3PO4 1.63, CH3COOH 2.88, NaH2PO4 4.68, NH4Cl 5.13,
 *     NaHCO3 8.34, CH3COONa 8.88, NH3 11.12, Na2CO3 11.66;
 *   specific heat at 25 °C, J/(g·K): Pb 0.129, Hg 0.140, Ag 0.235,
 *     Cu 0.385, Fe 0.449, Al 0.897, ethanol 2.44, water 4.18;
 *   wavelength, nm: H-γ 434.0, Hg 435.8, H-β 486.1, Ar⁺ laser 488.0,
 *     doubled Nd:YAG 532, Hg 546.1, Na D 589, He-Ne 632.8;
 *   boiling point, °C: diethyl ether 34.6, acetone 56.1, chloroform 61.2,
 *     methanol 64.7, n-hexane 68.7, ethanol 78.4, benzene 80.1, 2-propanol 82.5;
 *   melting point, °C: Hg −38.8, Cs 28.4, Ga 29.8, Rb 39.3, K 63.5,
 *     Na 97.8, In 156.6, Li 180.5.
 */
import { order, family } from './common.mjs';

export default family('science', 'Science, solved cold', [
    order('sci-ionization-energy', 'Periodic trends',
        'Order these elements by first ionization energy, lowest first.',
        ['O', 'Ar', 'Kr', 'H', 'F', 'Xe', 'N', 'Cl'],
        ['Xe', 'Cl', 'H', 'O', 'Kr', 'N', 'Ar', 'F'], 2),
    order('sci-half-lives', 'Radioactive decay',
        'Order these isotopes by half-life, shortest first.',
        ['caesium-137', 'tritium (hydrogen-3)', 'radium-226', 'cobalt-60', 'americium-241', 'strontium-90', 'plutonium-238', 'krypton-85'],
        ['cobalt-60', 'krypton-85', 'tritium (hydrogen-3)', 'strontium-90', 'caesium-137', 'plutonium-238', 'americium-241', 'radium-226'], 3),
    order('sci-metal-densities', 'Density',
        'Order these metals by density at room temperature, lowest first.',
        ['platinum', 'mercury', 'palladium', 'silver', 'rhenium', 'lead', 'tantalum', 'rhodium'],
        ['silver', 'lead', 'palladium', 'rhodium', 'mercury', 'tantalum', 'rhenium', 'platinum'], 2),
    order('sci-electrode-potentials', 'Electrochemistry',
        'Order these metals by the standard reduction potential of their usual ion (Li⁺, K⁺, Ca²⁺, Na⁺, Mg²⁺, Ni²⁺, Sn²⁺, Pb²⁺), most negative first.',
        ['sodium', 'tin', 'calcium', 'lithium', 'nickel', 'potassium', 'lead', 'magnesium'],
        ['lithium', 'potassium', 'calcium', 'sodium', 'magnesium', 'nickel', 'tin', 'lead'], 0),
    order('sci-escape-velocities', 'Gravitation',
        'Order these bodies by escape velocity from their surface, lowest first.',
        ['Titan', 'Mercury', 'Io', 'the Moon', 'Ganymede', 'Europa', 'Mars', 'Callisto'],
        ['Europa', 'the Moon', 'Callisto', 'Io', 'Titan', 'Ganymede', 'Mercury', 'Mars'], 1),
    order('sci-chromosome-numbers', 'Genetics',
        'Order these species by the number of chromosomes in a normal body cell (the diploid number), lowest first.',
        ['horse', 'human', 'brown rat', 'sheep', 'house mouse', 'chimpanzee', 'donkey', 'rabbit'],
        ['house mouse', 'brown rat', 'rabbit', 'human', 'chimpanzee', 'sheep', 'donkey', 'horse'], 1),
    order('sci-particle-masses', 'Particle physics',
        'Order these particles by rest mass, lightest first.',
        ['eta meson', 'neutron', 'charged pion', 'muon', 'neutral kaon', 'proton', 'neutral pion', 'charged kaon'],
        ['muon', 'neutral pion', 'charged pion', 'charged kaon', 'neutral kaon', 'eta meson', 'proton', 'neutron'], 1),
    order('sci-ph-of-solutions', 'Acids, bases and salts',
        'Each solution is 0.10 mol/L in water at 25 °C. Order them by pH, lowest first.',
        ['sodium hydrogencarbonate', 'ammonium chloride', 'phosphoric acid', 'sodium carbonate', 'acetic acid', 'ammonia', 'sodium dihydrogenphosphate', 'sodium acetate'],
        ['phosphoric acid', 'acetic acid', 'sodium dihydrogenphosphate', 'ammonium chloride', 'sodium hydrogencarbonate', 'sodium acetate', 'ammonia', 'sodium carbonate'], 4),
    order('sci-specific-heats', 'Heat capacity',
        'Order these substances by specific heat capacity (per gram) at 25 °C, lowest first.',
        ['iron', 'water', 'mercury', 'aluminium', 'lead', 'ethanol', 'copper', 'silver'],
        ['lead', 'mercury', 'silver', 'copper', 'iron', 'aluminium', 'ethanol', 'water'], 0),
    order('sci-wavelengths', 'Spectra and lasers',
        'Order these spectral lines and laser lines by wavelength, shortest first.',
        ['the sodium D lines', 'the hydrogen H-beta line', 'the green line of a frequency-doubled Nd:YAG laser', 'the red line of a helium-neon laser', 'the bright green mercury line', 'the hydrogen H-gamma line', 'the strongest blue line of an argon-ion laser', 'the blue mercury line'],
        ['the hydrogen H-gamma line', 'the blue mercury line', 'the hydrogen H-beta line', 'the strongest blue line of an argon-ion laser', 'the green line of a frequency-doubled Nd:YAG laser', 'the bright green mercury line', 'the sodium D lines', 'the red line of a helium-neon laser'], 2),
    order('sci-solvent-boiling-points', 'Intermolecular forces',
        'Order these liquids by boiling point at standard pressure, lowest first.',
        ['benzene', 'methanol', 'diethyl ether', 'propan-2-ol', 'chloroform', 'n-hexane', 'acetone', 'ethanol'],
        ['diethyl ether', 'acetone', 'chloroform', 'methanol', 'n-hexane', 'ethanol', 'benzene', 'propan-2-ol'], 5),
    order('sci-metal-melting-points', 'Metallic bonding',
        'Order these metals by melting point, lowest first.',
        ['lithium', 'gallium', 'sodium', 'mercury', 'indium', 'rubidium', 'caesium', 'potassium'],
        ['mercury', 'caesium', 'gallium', 'rubidium', 'potassium', 'sodium', 'indium', 'lithium'], 1),
]);
