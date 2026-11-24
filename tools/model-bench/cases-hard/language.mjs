/**
 * Grammar, spelling and stress in the languages the app teaches, solved cold,
 * six options each with exactly one right under the current standard
 * (Woordenlijst Nederlandse Taal, the Russian orthoepic list of the ФИПИ).
 * Every distractor is the error a fluent speaker actually makes: "Word je
 * broer" by the jij-rule when "je" is a possessive, "geskyped" by 't
 * kofschip, "по приезду" by analogy with "по прибытию".
 *
 * Eight cases ask for an English loan verb's form. Each key is the only form
 * the Woordenlijst gives (woordenlijst.org, 24 Nov 2026), and no distractor
 * is a form of the verb it lists: gedeletet, geskypet, geüpgraded, gestyled,
 * outsourcete, gechild, gecrasht, gebarbecued. The rule is 't kofschip on the sound of the English
 * stem, not its spelling, so "skype" ends in [p] (geskypet) and "upgrade"
 * in [d] (geüpgraded).
 *
 * One case counts letters: the sentence has 27 r's, upper and lower case.
 */
import { mc, solve, family } from './common.mjs';

const loan = (id, sentence, options, key, lure) => solve(id, 'Leenwoorden vervoegen',
    mc(`Vul de vorm in die de Woordenlijst Nederlandse Taal geeft: "${sentence}"`, options, key), lure);
const SENTENCE = "Strawberry rhubarb pie, raspberry sorbet and a barrel of cranberry cordial arrived for Rory's retirement party on a rare rainy Thursday.";

export default family('language', 'Grammar and spelling, solved cold', [
    solve('lang-nl-wordt-je-broer', 'Werkwoordspelling: d of t',
        mc('Welke zin is helemaal correct gespeld?',
            ['Wordt je broer morgen ook opgehaald?', 'Word je broer morgen ook opgehaald?', 'Wordt jij morgen ook opgehaald?', 'Hij heeft het pakket gisteren verzendt.', 'Je gedraagd je als een kind.', 'Het gebeurd niet vaak dat hij te laat komt.'],
            'Wordt je broer morgen ook opgehaald?'), 'Word je broer morgen ook opgehaald?'),
    loan('lang-nl-gedeletet', 'Ik heb het bestand per ongeluk ___.',
        ['gedeletet', 'gedeleted', 'gedeleet', 'gedelete', 'gedeletd', 'gedeleteet'], 'gedeletet', 'gedeleted'),
    loan('lang-nl-geskypet', 'Ik heb gisteren een uur met mijn oma ___.',
        ['geskypet', 'geskyped', 'geskypt', 'geskypd', 'geskypete', 'geskypeed'], 'geskypet', 'geskyped'),
    loan('lang-nl-geupgraded', 'We hebben de software naar de nieuwste versie ___.',
        ['geüpgraded', 'geüpgradet', 'upgegraded', 'geüpgrade', 'upgegradet', 'geüpgradeed'], 'geüpgraded', 'geüpgradet'),
    loan('lang-nl-gestyled', 'Voor de fotoshoot werd haar haar door een kapper ___.',
        ['gestyled', 'gestylet', 'gestyld', 'gestijld', 'gestylde', 'gestyleed'], 'gestyled', 'gestylet'),
    loan('lang-nl-outsourcete', 'Het bedrijf ___ vorig jaar zijn hele administratie.',
        ['outsourcete', 'outsourcede', 'outsourcte', 'outsourcde', 'outsourcdete', 'outsourcette'], 'outsourcete', 'outsourcede'),
    loan('lang-nl-gechild', 'We hebben het hele weekend op het strand ___.',
        ['gechild', 'gechilld', 'gechillt', 'gechilt', 'gechillde', 'gechilled'], 'gechild', 'gechilld'),
    loan('lang-nl-gecrasht', 'Mijn laptop is vannacht twee keer ___.',
        ['gecrasht', 'gecrashed', 'gecrashd', 'gecrashet', 'gecrasjt', 'gecrashte'], 'gecrasht', 'gecrashed'),
    loan('lang-nl-gebarbecued', 'We hebben gisteren met de buren in de tuin ___.',
        ['gebarbecued', 'gebarbecuet', 'gebarbecueëd', 'gebarbequed', 'gebarbecuëd', 'gebarbecuete'], 'gebarbecued', 'gebarbecuet'),
    solve('lang-nl-tussen-n', 'Tussenklanken in samenstellingen',
        mc('Welk woord is gespeld volgens de Woordenlijst Nederlandse Taal?',
            ['ruggengraat', 'pannekoek', 'paardebloem', 'zonnenschijn', 'kippesoep', 'hondehok'], 'ruggengraat'), 'paardebloem'),
    solve('lang-ru-po-priezde', 'Предлоги и падежи',
        mc('Какое предложение соответствует нормам русского литературного языка?',
            ['По приезде в Москву он сразу позвонил матери.', 'По приезду в Москву он сразу позвонил матери.', 'Согласно приказа директора занятия отменили.', 'Оплатите за проезд, пожалуйста.', 'Он одел пальто и вышел на улицу.', 'Ложи книгу на стол и садись.'],
            'По приезде в Москву он сразу позвонил матери.'), 'По приезду в Москву он сразу позвонил матери.'),
    solve('lang-ru-stress-krasivee', 'Орфоэпические нормы',
        mc('В каком слове ударение (заглавная буква) поставлено по литературной норме?',
            ['красИвее', 'звОнит', 'тортЫ', 'катАлог', 'щАвель', 'дОговор'], 'красИвее'), 'дОговор'),
    solve('lang-en-neither-nor', 'Agreement',
        mc('Which sentence is correct in formal written English?',
            ['Neither the manager nor the employees were aware of the change.', 'Neither the manager nor the employees was aware of the change.', 'Each of the students have their own locker.', 'Between you and I, the plan was a failure.', 'Less people came to the meeting than we expected.', 'Whom should I say is calling?'],
            'Neither the manager nor the employees were aware of the change.'), 'Neither the manager nor the employees was aware of the change.'),
    solve('lang-en-letter-count', 'Counting letters',
        mc(`How many times does the letter r (upper or lower case) occur in this sentence?\n\n${SENTENCE}`, ['27', '26', '28', '25', '29', '24'], '27'), '26'),
]);
