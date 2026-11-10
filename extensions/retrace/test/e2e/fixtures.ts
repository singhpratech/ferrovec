/**
 * Fixture pages for the end-to-end run: eight articles on distinct topics,
 * each on its own host, plus a bank page (blocked by the default blocklist)
 * and a sign-in page (has a password field). Hosts use the reserved `.test`
 * TLD and are served by the harness proxy, never resolved.
 */

export interface Fixture {
  host: string;
  path: string;
  title: string;
  paragraphs: string[];
  /** A paraphrased query that should rank this page first (no shared key phrases). */
  query?: string;
  /** Extra markup appended to the article (e.g. a password form). */
  extra?: string;
}

export const ARTICLES: Fixture[] = [
  {
    host: 'astro.test',
    path: '/black-holes',
    title: 'Event horizons and the slow evaporation of black holes',
    query: 'what happens to light near a collapsed star that nothing can escape from',
    paragraphs: [
      'A black hole forms when a massive star exhausts its nuclear fuel and its core collapses under its own gravity. The collapse continues until the matter is compressed into a region so dense that the escape velocity exceeds the speed of light. The boundary of that region is called the event horizon.',
      'Nothing that crosses the event horizon can return. Light emitted just outside it is stretched to longer and longer wavelengths as it climbs out of the gravitational well, an effect called gravitational redshift. To a distant observer, a clock falling toward the horizon appears to tick ever more slowly and its light fades to red and then to nothing.',
      'The size of the horizon depends only on the mass. For an object with the mass of the Sun the Schwarzschild radius is about three kilometres; for the supermassive black hole at the centre of our galaxy, four million times heavier, it is roughly the size of the orbit of Mercury.',
      'In 1974 Stephen Hawking showed that quantum effects near the horizon cause black holes to emit a faint thermal glow. This Hawking radiation carries energy away, so an isolated black hole slowly loses mass and eventually evaporates. For stellar black holes the process is absurdly slow, far longer than the present age of the universe, but it raises a deep puzzle about whether information that fell in is ever recovered.',
      'Astronomers detect black holes indirectly: by the orbits of stars around an unseen mass, by the X-rays from gas heated in an accretion disk, and since 2015 by the gravitational waves emitted when two of them spiral together and merge. In 2019 the Event Horizon Telescope produced the first image of the shadow of a black hole, a dark disk outlined by a ring of bent light.',
    ],
  },
  {
    host: 'bread.test',
    path: '/sourdough-starter',
    title: 'Keeping a sourdough starter healthy',
    query: 'how often should I feed the wild yeast culture I bake with',
    paragraphs: [
      'A sourdough starter is a living culture of wild yeast and lactic acid bacteria that you keep in a jar of flour and water. Every loaf you bake borrows a spoonful of it to leaven the dough, and every time you use it you must replenish what you took.',
      'Feeding means discarding most of the starter and mixing what remains with fresh flour and water. A common ratio is one part starter to one part flour and one part water by weight. At room temperature a vigorous starter needs feeding once or twice a day; it should roughly double in volume within four to eight hours and smell pleasantly sour, a little like yogurt or ripe apples.',
      'If you bake only on weekends, keep the jar in the refrigerator, where the cold slows fermentation. Feed it once a week, and take it out a day before baking to give it two feedings at room temperature so it is lively again.',
      'A layer of grey liquid on top, called hooch, means the culture is hungry. Pour it off or stir it in and feed. Pink or orange streaks, on the other hand, are a sign of contamination and the batch should be thrown away.',
      'Whole grain rye or wheat flour gives the microbes more nutrients than white flour and makes a sluggish starter more active. Chlorinated tap water can slow it down; letting the water stand overnight or using filtered water helps.',
    ],
  },
  {
    host: 'garden.test',
    path: '/tomato-problems',
    title: 'Blossom end rot and other tomato troubles',
    query: 'why do the bottoms of my vegetable plant fruits go black and leathery',
    paragraphs: [
      'Few things are as disappointing in a summer vegetable bed as a tomato that looks perfect from above but has a sunken, dark, leathery patch on its underside. This is blossom end rot, and despite its name it is not a disease caused by a fungus or bacterium.',
      'Blossom end rot is a calcium deficiency in the developing fruit. Usually the soil holds enough calcium; the problem is that the plant cannot move it into the fruit fast enough because uneven watering interrupts the flow of water through the plant. A dry spell followed by a heavy soaking is the classic trigger.',
      'The cure is consistent moisture. Water deeply and regularly rather than in occasional floods, and spread a thick mulch of straw or shredded leaves around the stems to keep the soil from drying out between waterings. Avoid heavy doses of nitrogen fertilizer, which push leafy growth at the expense of fruit.',
      'Cracked skins are another watering problem: when a fruit that has been short of water suddenly swells after rain, the skin splits. Yellow lower leaves with brown spots usually point to early blight, a fungal disease best kept in check by removing affected leaves and watering at soil level instead of over the foliage.',
      'Affected fruit can be picked off and composted; the plant will go on to set healthy tomatoes once its water supply is steady.',
    ],
  },
  {
    host: 'history.test',
    path: '/roman-aqueducts',
    title: 'How the Romans brought water to their cities',
    query: 'how ancient engineers carried water into the city using only a gentle downhill slope',
    paragraphs: [
      'At its height the city of Rome was supplied by eleven aqueducts that together delivered hundreds of thousands of cubic metres of water every day. They fed public fountains, baths, latrines and the houses of the wealthy, and the overflow flushed the sewers.',
      'Roman aqueducts worked entirely by gravity. Surveyors laid out a channel that descended steadily from a spring in the hills to a distribution tank in the city, often with a gradient of only a few tens of centimetres per kilometre. Keeping such a gentle and constant slope over dozens of kilometres of uneven country was the central engineering challenge.',
      'Most of the length of an aqueduct actually ran underground in a covered conduit, which protected the water from contamination and evaporation. The famous arcades of stone arches were built only where the channel had to cross a valley while holding its level. Where a valley was too deep for arches, engineers used inverted siphons: sealed lead pipes that carried the water down one side and up the other under pressure.',
      'Surveyors used instruments such as the chorobates, a long wooden table with a water channel on top used as a level, and the groma for laying out straight lines. Maintenance crews regularly cleared the conduits of the limestone deposits that built up inside them.',
      'The writer Frontinus, appointed water commissioner in 97 AD, left a detailed account of the system, complaining about illegal taps by farmers and householders who diverted the public supply.',
    ],
  },
  {
    host: 'cycling.test',
    path: '/chain-care',
    title: 'Cleaning and lubricating your bike chain',
    query: 'keeping the drivetrain on my bicycle clean and running smoothly',
    paragraphs: [
      'A clean, lubricated chain shifts crisply, runs quietly and lasts thousands of kilometres longer than a neglected one. Dirt mixed with old oil forms a grinding paste that wears the chain, the cassette cogs and the chainrings together.',
      'To clean the chain, shift onto a middle cog, hold a rag soaked in a degreaser around the lower run of the chain and turn the pedals backwards for a minute. For a deeper clean use a chain-cleaning box with rotating brushes, or remove the chain via its quick link and soak it. Scrub the cassette and the jockey wheels of the rear derailleur with a stiff brush.',
      'Let the chain dry completely, then apply one drop of lubricant to each roller on the inside of the chain while turning the cranks. Wait a few minutes and wipe off the excess from the outside: lubricant is needed inside the rollers, while oil on the outer plates only attracts grime.',
      'Wet lubricants resist rain and suit winter riding but collect dirt; dry and wax-based lubricants stay cleaner in dusty summer conditions but need reapplying more often.',
      'Chains stretch as their pins and rollers wear. Check with a chain wear gauge every few months and replace the chain when it reaches 0.5 percent elongation; replacing it in time avoids having to replace the far more expensive cassette as well.',
    ],
  },
  {
    host: 'ocean.test',
    path: '/coral-bleaching',
    title: 'Why coral reefs bleach',
    query: 'why warmer seas make reefs turn white and die',
    paragraphs: [
      'Reef-building corals live in partnership with microscopic algae called zooxanthellae that live inside their tissues. The algae photosynthesise and pass most of the sugars they make to the coral, which in return gives them shelter and nutrients. The algae also give corals most of their colour.',
      'When the water stays even one or two degrees Celsius above the usual summer maximum for several weeks, this partnership breaks down. The stressed algae start producing harmful reactive oxygen, and the coral expels them. Without its algae the coral tissue is transparent, and the white limestone skeleton shows through: the reef has bleached.',
      'Bleached coral is not dead, but it is starving. If temperatures fall quickly the algae can recolonise and the coral recovers; if the heat lasts, the corals die and the reef is overgrown by seaweed. Mass bleaching events, driven by marine heatwaves, have struck the Great Barrier Reef repeatedly since 1998.',
      'Pollution, sediment runoff and overfishing make reefs less able to recover. Scientists are experimenting with breeding heat-tolerant corals and with shading reefs, but the decisive factor remains the warming of the oceans.',
    ],
  },
  {
    host: 'music.test',
    path: '/jazz-improvisation',
    title: 'First steps in jazz improvisation',
    query: 'how do I make up a solo that fits over the chords of a tune',
    paragraphs: [
      'Improvising in jazz means inventing melodies on the spot over the harmonic structure of a tune, called its changes. Beginners often think of it as pure inspiration, but most great soloists built their vocabulary by learning patterns that fit common chord progressions.',
      'The most common progression in jazz is the two-five-one: a minor seventh chord built on the second degree of the key, a dominant seventh on the fifth, and a major seventh on the tonic. In C major that is D minor seven, G seven, C major seven. Practising lines that connect these three chords smoothly, in every key, is the backbone of jazz practice.',
      'A useful exercise is to target chord tones: land on the third or seventh of each new chord on a strong beat. Those notes define the sound of the harmony, so a line that moves between them by small steps outlines the changes even without a piano underneath.',
      'Transcribing solos by ear, slowing down recordings of players like Charlie Parker, Sonny Rollins or Bill Evans and learning their phrases note for note, teaches rhythm and phrasing as much as notes. Swing feel, the long-short lilt of eighth notes, matters more than any scale.',
      'Finally, leave space. A solo is a conversation with the rhythm section; short phrases with rests between them often say more than a constant stream of notes.',
    ],
  },
  {
    host: 'code.test',
    path: '/rust-ownership',
    title: 'Ownership and borrowing in Rust',
    query: 'the compiler rule that every value has exactly one owner and references must not outlive it',
    paragraphs: [
      'Rust manages memory without a garbage collector through a set of rules the compiler checks at build time, known as ownership. Each value in Rust has a single owner, a variable, and when the owner goes out of scope the value is dropped and its memory freed.',
      'Assigning a heap-allocated value such as a String to another variable moves it: the original variable can no longer be used. This prevents two owners from freeing the same memory twice. Types that are cheap to copy, like integers, implement the Copy trait and are duplicated instead of moved.',
      'Instead of transferring ownership, code can borrow a value through a reference. You may have any number of shared references, written with an ampersand, or exactly one mutable reference at a time, but not both at once. The borrow checker enforces these rules, ruling out data races and iterator invalidation at compile time.',
      'References must never outlive the data they point to. Lifetimes are the compiler’s way of tracking how long each reference is valid; most of the time they are inferred, but function signatures that return references sometimes need explicit lifetime annotations to tell the compiler how inputs and outputs are related.',
      'Fighting the borrow checker is a rite of passage for new Rust programmers. The usual fixes are to clone data when sharing is cheap, to restructure code so borrows end sooner, or to use smart pointers such as Rc and RefCell when shared ownership is genuinely needed.',
    ],
  },
];

/** On the default blocklist (`*bank*`): must never be indexed. */
export const BLOCKED: Fixture = {
  host: 'mybank.test',
  path: '/statement',
  title: 'Your account statement',
  paragraphs: Array.from({ length: 6 }, (_, i) =>
    `Statement period ${i + 1}. Your current account balance is available below together with every card transaction, standing order and transfer posted during the period. Overdraft interest is charged monthly and an arranged overdraft limit applies to this account. Contact us if you do not recognise a payment.`,
  ),
};

/** Has a password field: must never be indexed even though its host is not blocked. */
export const LOGIN: Fixture = {
  host: 'forum.test',
  path: '/login',
  title: 'Sign in to the gardening forum',
  paragraphs: Array.from({ length: 6 }, (_, i) =>
    `Welcome back, gardener ${i + 1}. Sign in to post questions about compost, pruning fruit trees and propagating cuttings. Members share seed swaps every spring and organise allotment visits; read the community guidelines before posting your first thread about raised beds or companion planting.`,
  ),
  extra:
    '<form><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button>Sign in</button></form>',
};

export const ALL_FIXTURES = [...ARTICLES, BLOCKED, LOGIN];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderFixture(f: Fixture): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(f.title)}</title></head>
<body>
<header><nav><a href="/">Home</a> · <a href="/about">About</a></nav></header>
<main><article>
<h1>${escapeHtml(f.title)}</h1>
${f.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${f.extra ?? ''}
</article></main>
<footer><p>Fixture page served by the Retrace end-to-end harness.</p></footer>
</body></html>`;
}

export function fixtureUrl(f: Fixture): string {
  return `http://${f.host}${f.path}`;
}
