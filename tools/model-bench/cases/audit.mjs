/**
 * Auditing lessons: the fact-and-arithmetic check on a written lesson segment
 * (server/feedQuality.js auditLesson, one model request, called from feedGen.js:1262).
 *
 * Three segments are sound and must come back ok with a real verdict; three carry ONE planted
 * error that nothing else in the pipeline would catch (an addition that is off by one, a fact
 * stated backwards, a minutes-to-hours conversion done wrong) and must come back not ok.
 * The planted segments are internally tidy: the wrong number is carried through the rest of
 * the worked example, so only recomputing it exposes the fault.
 *
 * `available` matters as much as `ok`: an auditor that returns nothing usable reads as ok
 * with available=false (the app fails open), and that is a miss here, not a pass.
 *
 * Proxy: the score reads the verdict only. It does not check that the quoted sentence is the
 * planted one, because a model may quote the line before or after it.
 */
const sound = (r) => (r.ok === true && r.available === true
    ? { pass: true, why: 'sound segment passed' }
    : { pass: false, why: r.available ? `sound segment stopped: ${r.reason}` : `no verdict: ${r.reason}` });
const planted = (r) => (r.ok === false && r.available === true
    ? { pass: true, why: `error caught: ${String(r.reason).slice(0, 80)}` }
    : { pass: false, why: r.available ? 'planted error let through' : `no verdict: ${r.reason}` });

const j = (x) => JSON.stringify(x);
const OK = j({ verdict: 'ok', quote: '', reason: '' });
const broken = (quote, reason) => j({ verdict: 'broken', quote, reason });

const T_KINETIC = `The kinetic energy of a moving object depends on its mass and, much more strongly, on its speed. The formula is $E_k = \\frac{1}{2}mv^2$, with the mass in kilograms and the speed in metres per second, which gives the energy in joules.

Take a car of mass 1200 kg travelling at 54 km/h. The formula needs metres per second, so convert first: divide by 3.6, and 54 / 3.6 = 15 m/s.

Now substitute: $E_k = \\frac{1}{2} \\times 1200 \\times 15^2 = 600 \\times 225 = 135\\,000\\ \\text{J}$, which is 135 kJ.

Because the speed is squared, doubling the speed multiplies the energy by four, not by two. At 30 m/s the same car has $E_k = 600 \\times 900 = 540\\,000\\ \\text{J}$, which is 4 × 135 000. This is why the braking distance of a car grows so quickly with speed: the brakes must remove four times as much energy.

A last check on the units: $\\text{kg} \\times (\\text{m/s})^2 = \\text{kg}\\,\\text{m}^2/\\text{s}^2$, and one joule is exactly that.`;

const T_ATP = `Cells need a steady supply of usable energy, and the molecule that delivers it is ATP, adenosine triphosphate. When the last phosphate group of ATP is split off, energy is released for work such as muscle contraction or moving substances across a membrane, and the ATP becomes ADP.

Most ATP in animal cells is made in mitochondria. These organelles have a smooth outer membrane and a folded inner membrane; the folds are called cristae, and they greatly increase the surface on which the last stage of respiration takes place. Inside the inner membrane is the matrix, where the Krebs cycle runs.

Respiration starts earlier, in the cytoplasm, where glycolysis splits one glucose molecule into two pyruvate molecules without needing oxygen. Pyruvate then enters the mitochondrion. With oxygen available, the complete breakdown of one glucose molecule yields around 30 molecules of ATP, depending on the estimate used, compared with a net gain of only 2 from glycolysis alone.

The cell stores very little ATP. A muscle cell holds only enough for a few seconds of intense work, so ATP is constantly rebuilt from ADP and phosphate. Cells that use a lot of energy, such as heart muscle cells, contain many more mitochondria than cells that use little.`;

const T_SEASONS_NL = `De seizoenen op aarde ontstaan niet doordat de aarde dichter bij of verder van de zon staat, maar doordat de aardas scheef staat. De aardas maakt een hoek van ongeveer 23,5 graden met de loodlijn op het vlak waarin de aarde om de zon draait.

Omdat de aardas steeds naar dezelfde kant wijst, is het noordelijk halfrond op een deel van de baan naar de zon toe gekanteld en op een ander deel van de zon af. Is het noordelijk halfrond naar de zon toe gekanteld, dan vallen de zonnestralen steiler in en zijn de dagen langer. Dat geeft zomer. Tegelijk is het op het zuidelijk halfrond winter.

Een omloop van de aarde om de zon duurt ongeveer 365,25 dagen. Daarom heeft een gewoon jaar 365 dagen en wordt ongeveer elke vier jaar een schrikkeldag toegevoegd: $4 \\times 0{,}25 = 1$ dag.

Begin januari staat de aarde juist iets dichter bij de zon dan begin juli, en toch is het dan winter op het noordelijk halfrond. Dat laat zien dat de afstand niet de oorzaak is van de seizoenen.`;

const T_SERIES = `When resistors are connected in series, the same current flows through each one, and the total resistance is the sum of the individual resistances: $R_{total} = R_1 + R_2 + R_3$.

Consider three resistors of 12 Ω, 8 Ω and 5 Ω in series, connected to a 48 V battery. The total resistance is $R = 12 + 8 + 5 = 24\\ \\Omega$.

The current is then $I = V/R = 48/24 = 2\\ \\text{A}$, and the same 2 A flows through every resistor.

The voltage across each resistor follows from $V = IR$. For the 12 Ω resistor, $V = 2 \\times 12 = 24\\ \\text{V}$. For the 8 Ω resistor, $V = 2 \\times 8 = 16\\ \\text{V}$. For the 5 Ω resistor, $V = 2 \\times 5 = 10\\ \\text{V}$.

The largest resistor takes the largest share of the voltage, and the shares always add up to the supply voltage. That is why series resistors are used as voltage dividers: choosing the ratio of the resistances chooses the ratio of the voltages.`;

const T_BOILING = `Water does not always boil at 100 °C. The boiling point is the temperature at which the vapour pressure of the liquid equals the pressure of the air above it, so it depends on that air pressure.

At sea level the air pressure is about 101 kPa and water boils at 100 °C. Climbing a mountain, the air thins and the pressure falls. Because less pressure holds the water down, it boils at a higher temperature the higher you climb, so a pot of pasta cooks faster in the mountains than at the coast.

A pressure cooker works on the same principle in the opposite direction. The lid seals the pot, the steam cannot escape, and the pressure inside rises above atmospheric pressure. At that higher pressure the water boils at around 120 °C, hotter than an open pot can ever be, and the food cooks faster.

So the boiling point is not a fixed property of water alone. It is a property of water at a given pressure, and it moves up and down with it.`;

const T_SPEED = `Speed is distance divided by time, $v = d/t$, and the unit you get depends on the units you put in. Kilometres and hours give km/h; metres and seconds give m/s. Mixing them is the most common source of wrong answers, so convert before you divide.

A cyclist rides 18 km in 45 minutes. First convert the time to hours: 45 minutes is 0.45 hours. Then $v = 18 / 0.45 = 40\\ \\text{km/h}$.

To express this in metres per second, divide by 3.6, because 1 km/h = 1000 m / 3600 s. So $40 / 3.6 \\approx 11.1\\ \\text{m/s}$.

The same method works in reverse. To go from m/s back to km/h, multiply by 3.6: $11.1 \\times 3.6 \\approx 40\\ \\text{km/h}$. Keeping the conversion factor 3.6 in mind saves you from converting the distance and the time separately every time.`;

const soundCase = (id, title, part, md, noise) => ({
    id, run: (fx, app) => app.server('feedQuality.js').then(m => m.auditLesson(title, part, md)),
    score: sound,
    golden: OK,
    mutants: [
        { name: 'invents a fault in a sound segment', reply: broken(noise.quote, noise.reason) },
        { name: 'no JSON at all', reply: 'The segment looks accurate to me and I could not find any mistakes.' },
        { name: 'verdict is not a word', reply: j({ verdict: true, quote: '', reason: '' }) },
    ],
});

const plantedCase = (id, title, part, md, fault) => ({
    id, run: (fx, app) => app.server('feedQuality.js').then(m => m.auditLesson(title, part, md)),
    score: planted,
    golden: broken(fault.quote, fault.reason),
    mutants: [
        { name: 'rubber-stamps the segment', reply: OK },
        { name: 'no JSON at all', reply: 'The segment is clear and the steps are well explained.' },
        { name: 'echoes the template', reply: j({ verdict: 'ok | broken', quote: '...', reason: '...' }) },
        { name: 'unsure', reply: j({ verdict: 'unsure', quote: '', reason: 'Could not decide.' }) },
    ],
});

export default {
    category: 'audit',
    label: 'Auditing lessons',
    cases: [
        soundCase('audit-ok-kinetic-energy', 'Kinetic energy', 'Calculating kinetic energy', T_KINETIC,
            { quote: '54 / 3.6 = 15 m/s', reason: 'The conversion is wrong.' }),
        soundCase('audit-ok-mitochondria-atp', 'Mitochondria and ATP', 'Where the cell makes ATP', T_ATP,
            { quote: 'around 30 molecules of ATP', reason: 'Glucose yields 38 ATP, not 30.' }),
        soundCase('audit-ok-nl-seasons', 'De seizoenen', 'Waarom er seizoenen zijn', T_SEASONS_NL,
            { quote: 'ongeveer 365,25 dagen', reason: 'Een jaar heeft 365 dagen, niet 365,25.' }),
        plantedCase('audit-broken-series-sum', 'Resistors in series', 'Total resistance and current', T_SERIES,
            { quote: 'R = 12 + 8 + 5 = 24 Ω', reason: '12 + 8 + 5 is 25 Ω, not 24 Ω, so the current is 1.92 A, not 2 A.' }),
        plantedCase('audit-broken-boiling-reversed', 'Boiling point and pressure', 'Why water boils at different temperatures', T_BOILING,
            { quote: 'it boils at a higher temperature the higher you climb', reason: 'Lower pressure lowers the boiling point, so food cooks slower at altitude, not faster.' }),
        plantedCase('audit-broken-minutes-to-hours', 'Speed and unit conversion', 'Converting units before dividing', T_SPEED,
            { quote: '45 minutes is 0.45 hours', reason: '45 minutes is 0.75 hours, so the speed is 24 km/h, not 40 km/h.' }),
    ],
};
