/**
 * Auditing lessons in pairs (feedQuality.js auditLesson). Each case audits the
 * same lesson segment twice: once as written, where every fact and number is
 * right, and once with ONE planted error, made by swapping a sentence or two
 * (`swaps`). The planted error is carried through where the text goes on, so
 * nothing but knowing the subject or redoing the arithmetic exposes it: an
 * effective rate recomputed, a binary sum, a stress in Russian, a Dutch past
 * tense, a Ukrainian vocative. A case passes only when the sound segment is
 * let through AND the planted one is stopped, so an auditor that stops
 * everything scores nothing.
 *
 * Every figure was recomputed: 17.3 × 2.04 ≈ 35.3 and 400/9.8 ≈ 40.8;
 * (1 + 0.05/12)^12 ≈ 1.0512 and e^0.05 ≈ 1.0513; 1.05/1.03 ≈ 1.0194 and
 * 1.5/1.4 ≈ 1.071; 230²/100 = 529 and 115 × 0.217 ≈ 25; 11111011 is −5 in
 * eight bits.
 *
 * As in the app, any verdict but "broken" counts as audited, and a reply with
 * no verdict counts as unaudited (`available: false`), a miss either way.
 */
const j = (x) => JSON.stringify(x);
const OK = j({ verdict: 'ok', quote: '', reason: '' });
const broken = (quote, reason) => j({ verdict: 'broken', quote, reason });

/** The planted twin: each `from` must occur exactly once in the sound text. */
function plant(id, text, swaps) {
    let out = text;
    for (const [from, to] of swaps) {
        if (out.split(from).length !== 2) throw new Error(`${id}: swap source must occur exactly once: ${from.slice(0, 50)}`);
        out = out.replace(from, () => to);
    }
    return out;
}

function pair(id, title, part, text, swaps, fault) {
    const planted = plant(id, text, swaps);
    const audit = (md) => (fx, app) => app.server('feedQuality.js').then(m => m.auditLesson(title, part, md));
    return {
        id,
        run: async (fx, app) => ({ sound: await audit(text)(fx, app), planted: await audit(planted)(fx, app) }),
        score: ({ sound, planted: p }) => {
            if (!sound?.available || !p?.available) return { pass: false, why: `no verdict: ${(sound?.available ? p : sound)?.reason}` };
            if (!sound.ok) return { pass: false, why: `sound segment stopped: ${String(sound.reason).slice(0, 90)}` };
            if (p.ok) return { pass: false, why: 'planted error let through' };
            return { pass: true, why: `error caught: ${String(p.reason).slice(0, 90)}` };
        },
        golden: [OK, broken(fault.quote, fault.reason)],
        mutants: [
            { name: 'rubber-stamps both', reply: [OK, OK] },
            { name: 'stops both', reply: [broken(fault.quote, 'Looks wrong.'), broken(fault.quote, fault.reason)] },
            { name: 'swapped verdicts', reply: [broken(fault.quote, 'Wrong.'), OK] },
            { name: 'unsure about the planted one', reply: [OK, j({ verdict: 'unsure', quote: '', reason: 'Could not decide.' })] },
            { name: 'no JSON at all', reply: ['The segment is accurate.', 'The segment has a mistake.'] },
        ],
    };
}

const PROJECTILE = String.raw`A ball kicked from level ground follows a parabola, and the cleanest way to handle it is to split the launch velocity into a horizontal and a vertical part. Air resistance is ignored throughout, and we take $g = 9.8\ \text{m/s}^2$.

Take a kick at 20 m/s, 30° above the horizontal. The horizontal component is $20 \cos 30° \approx 17.3$ m/s and the vertical component is $20 \sin 30° = 10$ m/s.

The ball rises until its vertical velocity is zero and then falls for the same time, so it is in the air for $t = 2 v_y / g = 20 / 9.8 \approx 2.04$ s. During that time the horizontal velocity does not change, so the range is $17.3 \times 2.04 \approx 35.3$ m.

On level ground the range is $R = v^2 \sin(2\theta) / g$. Because $\sin 60° = \sin 120°$, a kick at 60° with the same speed lands at the same distance, and the longest range comes at 45°: $R = 400 / 9.8 \approx 40.8$ m.`;

const COMPOUNDING = String.raw`Interest that is compounded is paid on the interest already earned, so the balance grows by a fixed factor each period rather than by a fixed amount.

Put €1,000 in an account at 5 % a year, compounded once a year. After three years the balance is $1000 \times 1.05^3 = 1000 \times 1.157625 \approx 1157.63$ euros. Simple interest at the same rate would give €1,150, so compounding earns €7.63 more.

Banks often quote a yearly rate but compound monthly, paying one twelfth of the rate each month. At 5 % compounded monthly, one year multiplies the balance by $(1 + 0.05/12)^{12} \approx 1.0512$, an effective annual rate of about 5.12 %.

The more often interest is compounded, the higher the effective rate, but the gain shrinks quickly: even compounding continuously only gives $e^{0.05} - 1 \approx 5.13$ %.`;

const KOFSCHIP = String.raw`Voor de verleden tijd van zwakke werkwoorden kijk je naar de laatste letter van de stam (op de uitzonderingen hieronder na). Is dat een van de medeklinkers uit 't kofschip (t, k, f, s, ch, p), dan krijgt de verleden tijd -te of -ten en het voltooid deelwoord een t. Anders wordt het -de of -den en een d.

Zo wordt werken: werkte, gewerkt; fietsen: fietste, gefietst; missen: miste, gemist. Bij horen is de stam hoor, en dat geeft hoorde, gehoord.

Let op bij werkwoorden met een v of z in het hele werkwoord. In de stam schrijf je f of s, maar voor de regel telt de medeklinker uit het hele werkwoord: leven geeft leefde, verhuizen geeft verhuisde en reizen geeft reisde.

Leenwoorden volgen dezelfde regel, op de klank van de stam: faxen geeft faxte, want de x klinkt als ks.`;

const RU_STRESS = String.raw`Ударение в русском языке подвижное и на письме не обозначается, поэтому в словах, где часто ошибаются, его нужно запоминать.

В глаголе «звонить» в личных формах ударение падает на окончание: звонИт, звонЯт, звонИшь. Так же ведут себя «включИт» и «вручИт».

В существительных ударение часто остаётся на одном и том же слоге во всех формах: тОрт — тОрты — тОртов, бАнт — бАнты. В словах «каталОг», «договОр» и «щавЕль» ударение падает на последний слог.`;

const UK_VOCATIVE = String.raw`Кличний відмінок уживаємо, коли до когось звертаємося. У більшості чоловічих імен твердої групи закінчення -е: Іван — Іване, Петро — Петре. У жіночих іменах на -а закінчення -о: Ольга — Ольго, Олена — Олено, а в іменах на -ія закінчення -є: Марія — Маріє, Наталія — Наталіє.

Звертаючись до людини на ім'я та по батькові, ставимо в кличний відмінок обидва слова: Іване Петровичу, Олено Іванівно. Так само змінюється й слово «пан»: пане Іване. Слово «пані» не змінюється: пані Олено.`;

const TWOS_COMPLEMENT = String.raw`Computers store signed integers in two's complement. In an n-bit number the highest bit has the weight $-2^{n-1}$ instead of $+2^{n-1}$, and all the other bits keep their usual positive weights.

For 8 bits that means the values run from −128 to 127. The pattern 01111111 is 127, 10000000 is −128, and 11111111 is −1, because $-128 + 127 = -1$.

To negate a number, invert every bit and add 1: 5 is 00000101, inverting gives 11111010, and adding 1 gives 11111011, which is −5. Adding 127 + 1 in 8 bits overflows and gives −128, which is why a counter that runs past its maximum suddenly jumps to a large negative number.`;

const REAL_RATE = String.raw`The interest rate a bank quotes is the nominal rate: it says how many more euros you will have, not how much more you will be able to buy. The real rate corrects for inflation.

The quick rule is real ≈ nominal − inflation. With 5 % nominal interest and 3 % inflation, the real rate is about 2 %.

The exact relation is $1 + r = (1 + i)/(1 + \pi)$. Here that gives $1.05 / 1.03 \approx 1.0194$, so the real rate is about 1.94 %, a little below the quick estimate. The quick rule is good when both rates are small; at 50 % interest and 40 % inflation it says 10 %, while the exact real rate is $1.5 / 1.4 - 1 \approx 7.1$ %.`;

const LAMPS = String.raw`A lamp's power rating holds only at its rated voltage. Connected any other way, its resistance (taken here as fixed, which a real filament only roughly is) decides what it draws.

A 100 W lamp rated for 230 V has a resistance of $R = V^2/P = 230^2/100 = 529\ \Omega$. Put two of them in series across 230 V: the total resistance is 1058 Ω and the current is $230/1058 \approx 0.217$ A.

Each lamp now has 115 V across it, half the supply, and dissipates $P = V I = 115 \times 0.217 \approx 25$ W, a quarter of its rating, so the pair together draw about 50 W. Halving the voltage across a fixed resistance halves the current too, which is why the power falls to a quarter and not to a half.`;

export default {
    category: 'audit',
    label: 'Auditing pairs: one planted error',
    cases: [
        pair('audit-projectile-flight-time', 'Projectile motion', 'Range of a kicked ball', PROJECTILE, [
            ['The ball rises until its vertical velocity is zero and then falls for the same time, so it is in the air for $t = 2 v_y / g = 20 / 9.8 \\approx 2.04$ s.',
                'The ball is in the air until its vertical velocity has dropped to zero, which takes $t = v_y / g = 10 / 9.8 \\approx 1.02$ s.'],
            ['$17.3 \\times 2.04 \\approx 35.3$ m', '$17.3 \\times 1.02 \\approx 17.7$ m'],
        ], { quote: 't = v_y / g = 10 / 9.8 ≈ 1.02 s', reason: 'That is only the time to the top; the flight lasts twice as long, 2.04 s, so the range is 35.3 m.' }),
        pair('audit-monthly-compounding', 'Compound interest', 'Effective annual rate', COMPOUNDING, [
            ['$(1 + 0.05/12)^{12} \\approx 1.0512$, an effective annual rate of about 5.12 %', '$(1 + 0.05/12)^{12} \\approx 1.0525$, an effective annual rate of about 5.25 %'],
        ], { quote: '(1 + 0.05/12)^12 ≈ 1.0525', reason: '(1 + 0.05/12)^12 is about 1.0512, an effective rate of 5.12 %, not 5.25 %.' }),
        pair('audit-nl-kofschip-z', 'Werkwoordspelling', "'t Kofschip", KOFSCHIP, [
            ['verhuizen geeft verhuisde', 'verhuizen geeft verhuiste'],
        ], { quote: 'verhuizen geeft verhuiste', reason: 'De z uit verhuizen zit niet in \'t kofschip, dus het is verhuisde.' }),
        pair('audit-ru-katalog-stress', 'Орфоэпия', 'Ударение в трудных словах', RU_STRESS, [
            ['В словах «каталОг», «договОр» и «щавЕль» ударение падает на последний слог.', 'В словах «договОр» и «щавЕль» ударение падает на последний слог, а в слове «катАлог» — на второй.'],
        ], { quote: 'в слове «катАлог» — на второй', reason: 'По норме каталОг: ударение на последнем слоге.' }),
        pair('audit-uk-vocative-ya', 'Кличний відмінок', 'Звертання', UK_VOCATIVE, [
            ['а в іменах на -ія закінчення -є: Марія — Маріє, Наталія — Наталіє', 'а в іменах на -ія закінчення -ю: Марія — Марію, Наталія — Наталію'],
        ], { quote: 'Марія — Марію, Наталія — Наталію', reason: 'Марію — це знахідний відмінок; кличний — Маріє, Наталіє.' }),
        pair('audit-twos-complement-negate', "Two's complement", 'Negative numbers in binary', TWOS_COMPLEMENT, [
            ['adding 1 gives 11111011, which is −5', 'adding 1 gives 11111100, which is −5'],
        ], { quote: 'adding 1 gives 11111100, which is −5', reason: '11111010 + 1 is 11111011; 11111100 is −4.' }),
        pair('audit-real-interest-exact', 'Inflation and interest', 'Real interest rates', REAL_RATE, [
            ['Here that gives $1.05 / 1.03 \\approx 1.0194$, so the real rate is about 1.94 %, a little below the quick estimate.',
                'Here that gives $1.05 / 1.03 \\approx 1.0206$, so the real rate is about 2.06 %, a little above the quick estimate.'],
        ], { quote: '1.05 / 1.03 ≈ 1.0206', reason: '1.05 / 1.03 is about 1.0194, a real rate of 1.94 %.' }),
        pair('audit-lamps-in-series', 'Electric power', 'Lamps in series', LAMPS, [
            ['$P = V I = 115 \\times 0.217 \\approx 25$ W, a quarter of its rating, so the pair together draw about 50 W. Halving the voltage across a fixed resistance halves the current too, which is why the power falls to a quarter and not to a half.',
                '$P = V I = 115 \\times 0.217 \\approx 50$ W, half of its rating, so the pair together draw about 100 W. Halving the voltage halves the power, as it does for any fixed resistance.'],
        ], { quote: 'P = V I = 115 × 0.217 ≈ 50 W', reason: '115 × 0.217 is about 25 W, a quarter of the rating: halving the voltage also halves the current.' }),
    ],
};
