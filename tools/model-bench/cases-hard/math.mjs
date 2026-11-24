/**
 * Mathematics the answer-key checker has to solve cold. Seven cases order
 * eight quantities whose values sit close together, so feel and memory are not
 * enough: each pair has to be worked out to two to six significant figures.
 * Seven ask for one exact count, residue or probability that is not a famous
 * textbook result. Every value was computed by a script, never recalled:
 *   near 22.5: e^3 + 2 22.0855, √500 22.3607, π^e 22.4592, 7^1.6 22.4987,
 *     22.5, ln(6 × 10^9) 22.5150, 2^(9/2) 22.6274, e^π 23.1407;
 *   roots: 11^(1/7) 1.408544, √2 1.414214, 17^(1/8) 1.424971,
 *     12^(1/7) 1.426162, 50^(1/11) 1.427091, 6^(1/5) 1.430969,
 *     ∛3 1.442250, 13^(1/7) 1.442563;
 *   log10: 60! × 10^76 157.92017, 3^331 157.92714, 100! 157.97000,
 *     10^158 158, 2^525 158.04075, 99^80 159.65082, 50^94 159.70318,
 *     7^189 159.72353;
 *   probabilities: exactly 5 heads in 10 0.24609, a run of 4+ heads in 10
 *     0.24512, a run of 5+ heads in 20 0.24987, an acute triangle 0.25,
 *     a double six in 24 throws 0.49140, a shared birthday among 23 0.50730,
 *     a run of 3+ heads in 10 0.50781, a six in 4 throws 0.51775;
 *   counts: 3 × 10 domino tilings 571, Bell B7 877, labelled trees on 6
 *     vertices 1296, triangulations of a decagon 1430, p(24) 1575, 2 × 16
 *     domino tilings 1597, derangements of 7 1854, 3 × 12 domino tilings 2131;
 *   log10: 5^3673 2567.317, 3^5381 2567.389, 7^3038 2567.408, 1000!
 *     2567.605, 999^856 2567.628, 2^8530 2567.786, 100^1284 2568,
 *     2567^750 2557.069;
 *   areas: regular pentagon of side 1 1.72048, half-disc of radius 1.05
 *     1.73180, equilateral triangle of side 2 1.73205, regular octagon of side
 *     0.6 1.73823, disc of radius 0.75 1.76715, triangle 2, 2, 2.1 1.78732,
 *     square of diagonal 1.9 1.80500, regular hexagon of side 0.85 1.87711;
 *   single answers: 23 Fridays the 13th in 2027-2040, Σ φ(k) for k ≤ 100
 *     is 3044, 2^2026 ends in 864, 1183 domino tilings of 5 × 6, 22560
 *     invertible 4 × 4 0/1 matrices over the reals (20160 over GF(2)),
 *     P(TTHH before HHHT) = 7/12, 20 expected tosses for THTH.
 */
import { mc, seq, solve, order, family } from './common.mjs';

const ASC = 'Put these numbers in increasing order, smallest first.';
/** The order the learner sees: a fixed derangement of the eight-item key. */
const SHOWN = [5, 2, 7, 0, 3, 6, 1, 4];
const ask = (id, title, question, key, i) => order(id, title, question, SHOWN.map(k => key[k]), key, i);

export default family('math', 'Mathematics, solved cold', [
    solve('math-order-near-22-5', 'Comparing real numbers',
        seq(ASC,
            ['2^(9/2)', 'π^e', 'e^3 + 2', '22.5', 'e^π', '7^1.6', '√500', 'ln(6 × 10^9)'],
            ['e^3 + 2', '√500', 'π^e', '7^1.6', '22.5', 'ln(6 × 10^9)', '2^(9/2)', 'e^π']),
        ['e^3 + 2', '√500', 'π^e', '22.5', '7^1.6', 'ln(6 × 10^9)', '2^(9/2)', 'e^π']),
    ask('math-close-roots', 'Comparing roots', ASC,
        ['11^(1/7)', '√2', '17^(1/8)', '12^(1/7)', '50^(1/11)', '6^(1/5)', '∛3', '13^(1/7)'], 6),
    ask('math-close-huge', 'Comparing large numbers', ASC,
        ['60! × 10^76', '3^331', '100!', '10^158', '2^525', '99^80', '50^94', '7^189'], 0),
    solve('math-order-probabilities', 'Probability',
        seq('Coins are fair, dice are fair six-sided dice, birthdays are uniform over 365 days, and points on a circle are independent and uniform. Put these probabilities in increasing order, smallest first.',
            ['a shared birthday among 23 people', 'exactly 5 heads in 10 tosses', 'at least one six in 4 throws of one die', 'a run of at least 5 heads in a row somewhere in 20 tosses', 'three random points on a circle form an acute triangle', 'a run of at least 3 heads in a row somewhere in 10 tosses', 'a run of at least 4 heads in a row somewhere in 10 tosses', 'at least one double six in 24 throws of two dice'],
            ['a run of at least 4 heads in a row somewhere in 10 tosses', 'exactly 5 heads in 10 tosses', 'a run of at least 5 heads in a row somewhere in 20 tosses', 'three random points on a circle form an acute triangle', 'at least one double six in 24 throws of two dice', 'a shared birthday among 23 people', 'a run of at least 3 heads in a row somewhere in 10 tosses', 'at least one six in 4 throws of one die']),
        ['exactly 5 heads in 10 tosses', 'a run of at least 4 heads in a row somewhere in 10 tosses', 'a run of at least 5 heads in a row somewhere in 20 tosses', 'three random points on a circle form an acute triangle', 'at least one double six in 24 throws of two dice', 'a shared birthday among 23 people', 'a run of at least 3 heads in a row somewhere in 10 tosses', 'at least one six in 4 throws of one die']),
    solve('math-order-counts', 'Combinatorics',
        seq('Put these counts in increasing order, smallest first.',
            ['partitions of the integer 24', 'domino tilings of a 3 × 12 rectangle', 'labelled trees on 6 vertices', 'derangements of 7 objects', 'domino tilings of a 3 × 10 rectangle', 'triangulations of a convex decagon', 'domino tilings of a 2 × 16 rectangle', 'set partitions of a 7-element set'],
            ['domino tilings of a 3 × 10 rectangle', 'set partitions of a 7-element set', 'labelled trees on 6 vertices', 'triangulations of a convex decagon', 'partitions of the integer 24', 'domino tilings of a 2 × 16 rectangle', 'derangements of 7 objects', 'domino tilings of a 3 × 12 rectangle']),
        ['domino tilings of a 3 × 10 rectangle', 'set partitions of a 7-element set', 'labelled trees on 6 vertices', 'triangulations of a convex decagon', 'domino tilings of a 2 × 16 rectangle', 'partitions of the integer 24', 'derangements of 7 objects', 'domino tilings of a 3 × 12 rectangle']),
    solve('math-order-huge-numbers', 'Comparing large numbers',
        seq(ASC,
            ['1000!', '2^8530', '5^3673', '2567^750', '7^3038', '100^1284', '3^5381', '999^856'],
            ['2567^750', '5^3673', '3^5381', '7^3038', '1000!', '999^856', '2^8530', '100^1284']),
        ['2567^750', '5^3673', '7^3038', '3^5381', '1000!', '999^856', '2^8530', '100^1284']),
    solve('math-order-areas', 'Areas of plane figures',
        seq('Put these plane figures in increasing order of area, smallest first.',
            ['a disc of radius 0.75', 'a regular pentagon of side 1', 'a square with diagonal 1.9', 'an equilateral triangle of side 2', 'a regular hexagon of side 0.85', 'a half-disc of radius 1.05', 'a triangle with sides 2, 2 and 2.1', 'a regular octagon of side 0.6'],
            ['a regular pentagon of side 1', 'a half-disc of radius 1.05', 'an equilateral triangle of side 2', 'a regular octagon of side 0.6', 'a disc of radius 0.75', 'a triangle with sides 2, 2 and 2.1', 'a square with diagonal 1.9', 'a regular hexagon of side 0.85']),
        ['a regular pentagon of side 1', 'an equilateral triangle of side 2', 'a half-disc of radius 1.05', 'a regular octagon of side 0.6', 'a disc of radius 0.75', 'a triangle with sides 2, 2 and 2.1', 'a square with diagonal 1.9', 'a regular hexagon of side 0.85']),
    solve('math-friday-13-count', 'The calendar',
        mc('How many Fridays fall on the 13th of a month from 1 January 2027 to 31 December 2040 inclusive?',
            ['23', '24', '22', '25', '21', '20'], '23'), '24'),
    solve('math-totient-sum-100', 'Euler\'s totient function',
        mc('Let φ be Euler\'s totient function. What is φ(1) + φ(2) + … + φ(100)?',
            ['3044', '3043', '3045', '3040', '3050', '3039'], '3044'), '3043'),
    solve('math-2-pow-2026-last-digits', 'Modular arithmetic',
        mc('What are the last three digits of 2^2026?',
            ['864', '736', '432', '376', '896', '624'], '864'), '376'),
    solve('math-domino-tilings-5x6', 'Tilings',
        mc('In how many ways can a 5 × 6 rectangle be covered completely by 1 × 2 dominoes (no overlaps, nothing sticking out)?',
            ['1183', '1153', '1131', '1295', '1081', '1255'], '1183'), '1153'),
    solve('math-invertible-binary-4x4', 'Matrices',
        mc('How many 4 × 4 matrices whose sixteen entries are each 0 or 1 are invertible as real matrices?',
            ['22560', '20160', '24960', '21840', '23040', '19200'], '22560'), '20160'),
    solve('math-penney-tthh-hhht', 'Coin-toss patterns',
        mc('A fair coin is tossed until either TTHH or HHHT appears as four consecutive tosses. What is the probability that TTHH appears first?',
            ['7/12', '1/2', '5/12', '2/3', '3/5', '9/16'], '7/12'), '1/2'),
    solve('math-expected-thth', 'Expected values',
        mc('A fair coin is tossed until the pattern THTH appears in four consecutive tosses. What is the expected number of tosses?',
            ['20', '16', '18', '10', '30', '14'], '20'), '16'),
]);
