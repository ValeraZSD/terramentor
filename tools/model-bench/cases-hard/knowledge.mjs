/**
 * Orderings that need exact knowledge of the long tail, not a trend: eight
 * items each, events a few years apart, sizes within a few per cent, asked
 * in English, Dutch, Russian and Ukrainian. One wrong pair fails the case.
 * Keys, checked against Wikipedia lists and infoboxes (24 Nov 2026):
 *   moon radius, km: Titania 788, Rhea 764, Iapetus 734, Charon 606,
 *     Umbriel 584, Ariel 579, Dione 561, Tethys 531;
 *   planet density, g/cm³: Earth 5.51, Mercury 5.43, Venus 5.24, Mars 3.93,
 *     Neptune 1.64, Jupiter 1.33, Uranus 1.27, Saturn 0.69;
 *   apparent magnitude: Sirius −1.46, Canopus −0.74, Arcturus −0.05,
 *     Vega 0.03, Capella 0.08, Procyon 0.34, Achernar 0.46, Altair 0.76;
 *   Roman accessions: Philip 244, Decius 249, Gallus 251, Aemilian 253,
 *     Claudius II 268, Aurelian 270, Tacitus 275, Probus 276;
 *   Byzantine accessions: Heraclius 610, Leo III 717, Basil I 867,
 *     Nikephoros II 963, John I 969, Constantine IX 1042, Romanos IV 1068,
 *     Alexios I 1081;
 *   Byzantine accessions, 641-715: Constans II 641, Constantine IV 668,
 *     Justinian II 685, Leontios 695, Tiberios III 698, Philippikos 711,
 *     Anastasios II 713, Theodosios III 715;
 *   British prime ministers, first term: Canning Apr 1827, Goderich Aug 1827,
 *     Wellington 1828, Grey 1830, Melbourne Jul 1834, Peel Dec 1834,
 *     Russell 1846, Derby 1852;
 *   Dutch prime ministers: Drees 1948, De Quay 1959, Marijnen 1963, Cals 1965,
 *     Zijlstra 1966, De Jong 1967, Biesheuvel 1971, Den Uyl 1973;
 *   Russian rulers: Peter I 1682, Catherine I 1725, Peter II 1727, Anna 1730,
 *     Ivan VI 1740, Elizabeth 1741, Peter III Jan 1762, Catherine II Jul 1762;
 *   hetmans, first election: B. Khmelnytsky 1648, Vyhovsky 1657,
 *     Briukhovetsky 1663, Doroshenko 1665, Samoilovych 1672, Mazepa 1687,
 *     Skoropadsky 1708, Apostol 1727 (Yurii Khmelnytsky is left out: his
 *     first term, 1657, came weeks before Vyhovsky's);
 *   composers' births: Vivaldi Mar 1678, Telemann Mar 1681, Rameau Sep 1683,
 *     Handel Feb 1685, Bach Mar 1685, D. Scarlatti Oct 1685, Pergolesi 1710,
 *     Gluck 1714;
 *   discoveries: X-rays 1895, radioactivity 1896, electron 1897, nucleus 1911,
 *     neutron Feb 1932, positron Aug 1932, muon 1936-37, fission Dec 1938;
 *   Russian novels: 1836, 1840, 1842, 1846, Oblomov 1859, On the Eve 1860,
 *     Fathers and Sons 1862, What Is to Be Done? 1863;
 *   area, km²: Chile 756 102, Zambia 752 612, Myanmar 676 578,
 *     Afghanistan 652 864, Somalia 637 657, CAR 622 984, Ukraine 603 550,
 *     Madagascar 587 041;
 *   lake area, km²: Tanganyika 32 900, Baikal 31 722, Great Bear 31 153,
 *     Malawi 29 600, Great Slave 27 200, Erie 25 667, Winnipeg 24 514,
 *     Ontario 19 011;
 *   island area, km²: Baffin 507 451, Sumatra 443 066, Honshu 227 960,
 *     Great Britain 209 331, Ellesmere 196 236, Sulawesi 180 681,
 *     South Island 150 683, Java 138 794;
 *   Dutch Nobel prizes: Van 't Hoff 1901, Lorentz 1902, Van der Waals 1910,
 *     Asser 1911, Kamerlingh Onnes 1913, Einthoven 1924, Eijkman 1929,
 *     Debye 1936;
 *   height, m: K2 8611, Kangchenjunga 8586, Lhotse 8516, Makalu 8485,
 *     Cho Oyu 8188, Dhaulagiri I 8167, Manaslu 8163, Nanga Parbat 8126;
 *   latitude of the centre: Edinburgh 55.95, Glasgow 55.86, Moscow 55.76,
 *     Copenhagen 55.68, Vilnius 54.69, Hamburg 53.55, Dublin 53.35,
 *     Berlin 52.52.
 */
import { ask, family } from './common.mjs';


export default family('knowledge', 'Exact knowledge, put in order', [
    ask('know-moon-radii', 'Moons of the outer Solar System',
        'Order these moons by mean radius, largest first.',
        ['Titania', 'Rhea', 'Iapetus', 'Charon', 'Umbriel', 'Ariel', 'Dione', 'Tethys'], 4),
    ask('know-planet-densities', 'The planets',
        'Order the planets by mean density, highest first.',
        ['Earth', 'Mercury', 'Venus', 'Mars', 'Neptune', 'Jupiter', 'Uranus', 'Saturn'], 0),
    ask('know-bright-stars', 'The night sky',
        'Order these stars by apparent visual magnitude as seen from Earth, brightest first.',
        ['Sirius', 'Canopus', 'Arcturus', 'Vega', 'Capella', 'Procyon', 'Achernar', 'Altair'], 3),
    ask('know-roman-emperors', 'The crisis of the third century',
        'Order these Roman emperors by the year they came to power, earliest first.',
        ['Philip the Arab', 'Decius', 'Trebonianus Gallus', 'Aemilian', 'Claudius Gothicus', 'Aurelian', 'Tacitus', 'Probus'], 6),
    ask('know-byzantine-emperors', 'The Byzantine Empire',
        'Order these Byzantine emperors by the year they came to power, earliest first.',
        ['Heraclius', 'Leo III the Isaurian', 'Basil I', 'Nikephoros II Phokas', 'John I Tzimiskes', 'Constantine IX Monomachos', 'Romanos IV Diogenes', 'Alexios I Komnenos'], 3),
    ask('know-byzantine-anarchy', 'The Byzantine Empire',
        'Order these Byzantine emperors by the year each first came to power, earliest first.',
        ['Constans II', 'Constantine IV', 'Justinian II', 'Leontios', 'Tiberios III', 'Philippikos', 'Anastasios II', 'Theodosios III'], 3),
    ask('know-british-prime-ministers', 'British history',
        'Order these British prime ministers by the date each FIRST became prime minister, earliest first.',
        ['George Canning', 'Viscount Goderich', 'the Duke of Wellington', 'Earl Grey', 'Viscount Melbourne', 'Sir Robert Peel', 'Lord John Russell', 'the Earl of Derby'], 4),
    ask('know-nl-prime-ministers', 'Nederlandse politiek',
        'Zet deze minister-presidenten van Nederland in de volgorde waarin hun eerste kabinet aantrad, de vroegste eerst.',
        ['Willem Drees', 'Jan de Quay', 'Victor Marijnen', 'Jo Cals', 'Jelle Zijlstra', 'Piet de Jong', 'Barend Biesheuvel', 'Joop den Uyl'], 3),
    ask('know-ru-rulers', 'Эпоха дворцовых переворотов',
        'Расположите правителей России в порядке их восшествия на престол, начиная с самого раннего.',
        ['Пётр I', 'Екатерина I', 'Пётр II', 'Анна Иоанновна', 'Иван VI', 'Елизавета Петровна', 'Пётр III', 'Екатерина II'], 1),
    ask('know-uk-hetmans', 'Гетьманщина',
        'Розташуйте гетьманів у порядку, в якому кожен із них уперше став гетьманом, від найранішого.',
        ['Богдан Хмельницький', 'Іван Виговський', 'Іван Брюховецький', 'Петро Дорошенко', 'Іван Самойлович', 'Іван Мазепа', 'Іван Скоропадський', 'Данило Апостол'], 2),
    ask('know-baroque-composers', 'Baroque music',
        'Order these composers by date of birth, earliest first.',
        ['Antonio Vivaldi', 'Georg Philipp Telemann', 'Jean-Philippe Rameau', 'George Frideric Handel', 'Johann Sebastian Bach', 'Domenico Scarlatti', 'Giovanni Battista Pergolesi', 'Christoph Willibald Gluck'], 3),
    ask('know-physics-discoveries', 'Modern physics',
        'Order these discoveries by when they were made, earliest first.',
        ['X-rays (Röntgen)', 'radioactivity (Becquerel)', 'the electron (J. J. Thomson)', 'the atomic nucleus (Rutherford)', 'the neutron (Chadwick)', 'the positron (Anderson)', 'the muon (Anderson and Neddermeyer)', 'nuclear fission (Hahn and Strassmann)'], 4),
    ask('know-ru-novels', 'Русская литература XIX века',
        'Расположите произведения в порядке их первой публикации, начиная с самого раннего.',
        ['«Капитанская дочка» Пушкина', '«Герой нашего времени» Лермонтова', '«Мёртвые души» Гоголя', '«Бедные люди» Достоевского', '«Обломов» Гончарова', '«Накануне» Тургенева', '«Отцы и дети» Тургенева', '«Что делать?» Чернышевского'], 4),
    ask('know-country-areas', 'Countries of the world',
        'Order these countries by total area, largest first.',
        ['Chile', 'Zambia', 'Myanmar', 'Afghanistan', 'Somalia', 'Central African Republic', 'Ukraine', 'Madagascar'], 0),
    ask('know-lake-areas', 'Lakes of the world',
        'Order these lakes by surface area, largest first.',
        ['Lake Tanganyika', 'Lake Baikal', 'Great Bear Lake', 'Lake Malawi', 'Great Slave Lake', 'Lake Erie', 'Lake Winnipeg', 'Lake Ontario'], 1),
    ask('know-island-areas', 'Islands of the world',
        'Order these islands by area, largest first.',
        ['Baffin Island', 'Sumatra', 'Honshu', 'Great Britain', 'Ellesmere Island', 'Sulawesi', 'the South Island of New Zealand', 'Java'], 2),
    ask('know-nl-nobel-laureates', 'Nederlandse Nobelprijswinnaars',
        'Zet deze Nederlandse Nobelprijswinnaars in de volgorde van het jaar waarin zij de prijs kregen, de vroegste eerst.',
        ["Jacobus van 't Hoff", 'Hendrik Lorentz', 'Johannes Diderik van der Waals', 'Tobias Asser', 'Heike Kamerlingh Onnes', 'Willem Einthoven', 'Christiaan Eijkman', 'Peter Debye'], 2),
    ask('know-eight-thousanders', 'Mountains',
        'Order these mountains by height above sea level, highest first.',
        ['K2', 'Kangchenjunga', 'Lhotse', 'Makalu', 'Cho Oyu', 'Dhaulagiri I', 'Manaslu', 'Nanga Parbat'], 5),
    ask('know-city-latitudes', 'Geography of Europe',
        'Order these cities by the latitude of their centre, northernmost first.',
        ['Edinburgh', 'Glasgow', 'Moscow', 'Copenhagen', 'Vilnius', 'Hamburg', 'Dublin', 'Berlin'], 2),
]);
