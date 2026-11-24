/**
 * Questions the answer-key checker must refuse. Each looks like an ordinary
 * question with a plausible key, and the fault only shows to a model that
 * actually works it: the right value is missing from the options, two
 * options are right, the premise contradicts itself, or one item does not
 * belong to the sequence. Only the verdict "broken" passes (common.mjs
 * refused): picking some other option is a guess, not a refusal.
 * The facts: 720 = 2⁴ · 3² · 5 has 30 divisors; 48 271 × 97 613 × 3 359 =
 * 15 827 195 256 157, and every option differs from it in two digits;
 * ∫₀¹ x^(−x) dx = Σ 1/nⁿ ≈ 1.29129; a 0.10 mol/L acid cannot give pH 0.5
 * ([H⁺] 0.32 mol/L); three random points on a circle form an obtuse triangle
 * with probability 3/4, not 1/4; Saint Petersburg was founded in 1703 and
 * Poltava was fought in 1709; sister chromatids part in anaphase II, not in
 * meiosis I; тОрты and шАрфы are both stressed on the first syllable.
 */
import { mc, seq, unsound, family } from './common.mjs';

export default family('unsound', 'Refusing unsound questions', [
    unsound('unsound-divisors-720', 'Divisors',
        mc('How many positive divisors does 720 have?', ['28', '32', '24', '36', '40', '27'], '32'),
        '32', '720 = 2⁴ · 3² · 5 has 5 · 3 · 2 = 30 divisors, which is not among the options.'),
    unsound('unsound-product-three', 'Long multiplication',
        mc('What is 48 271 × 97 613 × 3 359?', ['15827195265157', '15827915256157', '15827195256517', '15872195256157', '15827159256157', '15827195256751'], '15827195265157'),
        '15827195265157', '48 271 × 97 613 × 3 359 = 15 827 195 256 157, which is not among the options.'),
    unsound('unsound-sophomore-dream', 'Definite integrals',
        mc('What is the value of the integral of x^(−x) over x from 0 to 1?', ['Σ 1/nⁿ for n = 1, 2, 3, …', '1.291', 'e − 1', 'π²/8', 'Σ 1/n! for n = 1, 2, 3, …', '1.234'], '1.291'),
        '1.291', 'The integral equals Σ 1/nⁿ ≈ 1.2913, so two options are right.'),
    unsound('unsound-impossible-ph', 'Weak acids',
        mc('A 0.10 mol/L solution of a weak monoprotic acid HA in water at 25 °C has a pH of 0.50. What is the acid dissociation constant Ka of HA?', ['1.0', '0.32', '0.15', '0.46', '0.032', '0.046'], '0.46'),
        '0.46', 'A pH of 0.50 means [H⁺] ≈ 0.32 mol/L, more than the 0.10 mol/L of acid present, so the premise is impossible.'),
    unsound('unsound-obtuse-premise', 'Geometric probability',
        mc('Three points are chosen independently and uniformly at random on a circle. The probability that they form an obtuse triangle is 1/4. What is the probability that they form an acute triangle?', ['3/4', '1/4', '1/2', '2/3', '1/3', '5/8'], '3/4'),
        '3/4', 'The premise is false: the triangle is obtuse with probability 3/4 and acute with probability 1/4.'),
    unsound('unsound-poltava-petersburg', 'Russia under Peter the Great',
        mc('In which year did Peter the Great found Saint Petersburg, after his victory over the Swedes at Poltava?', ['1703', '1709', '1712', '1700', '1721', '1697'], '1703'),
        '1703', 'Saint Petersburg was founded in 1703, six years before Poltava (1709), so the premise is false.'),
    unsound('unsound-meiosis-one', 'Cell division',
        seq('Put these events of meiosis I in order.',
            ['Homologous chromosomes line up at the equator', 'Sister chromatids separate', 'Crossing over between homologous chromosomes', 'Two daughter cells form', 'Homologous chromosomes move to opposite poles'],
            ['Crossing over between homologous chromosomes', 'Homologous chromosomes line up at the equator', 'Homologous chromosomes move to opposite poles', 'Sister chromatids separate', 'Two daughter cells form']),
        ['Crossing over between homologous chromosomes', 'Homologous chromosomes line up at the equator', 'Homologous chromosomes move to opposite poles', 'Sister chromatids separate', 'Two daughter cells form'],
        'Sister chromatids separate in anaphase II, not in meiosis I.'),
    unsound('unsound-ru-two-stresses', 'Орфоэпические нормы',
        mc('В каком слове по литературной норме ударение падает на первый слог?', ['торты', 'шарфы', 'досуг', 'жалюзи', 'щавель', 'каталог'], 'торты'),
        'торты', 'По норме и тОрты, и шАрфы ударны на первый слог: верных ответов два.'),
]);
