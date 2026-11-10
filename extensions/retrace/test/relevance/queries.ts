/**
 * Query sets for the real-content measurement.
 *
 * TUNING was written before any score was seen, from what a reader would
 * remember about each page, deliberately loose and in their own words.
 * HELD_OUT was written after the strong/weak rule was chosen and is only used
 * to report its precision and recall.
 *
 * `evidence`: words that a passage of the target page must all contain for
 * the answer to be in the index at all (case-insensitive). It separates "the
 * page's indexed passages never covered this" (only the first 12 passages of
 * a page are indexed) from "covered, but not retrieved".
 */

export interface Query {
  query: string;
  /** Page id from pages.ts, or null when no page is about this. */
  target: string | null;
  evidence?: string[];
  set: 'tuning' | 'held-out' | 'held-out-2';
}

const t = (query: string, target: string, evidence: string[]): Query => ({ query, target, evidence, set: 'tuning' });
const none = (query: string): Query => ({ query, target: null, set: 'tuning' });

export const TUNING: Query[] = [
  // Rust book (three related chapters)
  t('why did my variable become invalid after I passed it to a function', 'rust-ownership', ['function', 'valid']),
  t('what happens to memory when a value goes out of scope', 'rust-ownership', ['scope', 'drop']),
  t('difference between stack and heap for strings', 'rust-ownership', ['stack', 'heap']),
  t('can I have two mutable references to the same data at once', 'rust-borrowing', ['mutable', 'reference']),
  t('dangling pointer prevented by the compiler', 'rust-borrowing', ['dangling']),
  t('annotating how long references live in a function signature', 'rust-lifetimes', ['lifetime', 'annotation']),
  t('the longest of two string slices example', 'rust-lifetimes', ['longest']),
  // Databases (four related articles)
  t('log changes before applying them so a crash does not corrupt the database', 'write-ahead-logging', ['log']),
  t('balanced tree with many keys per node used by file systems and databases', 'b-tree', ['node', 'keys']),
  t('atomicity consistency isolation durability', 'acid', ['atomicity']),
  t('embedded database engine that is just a library and a single file', 'sqlite', ['library']),
  t('who wrote sqlite and when', 'sqlite', ['hipp']),
  // Browser storage (MDN, three related pages)
  t('private storage for a website that the user cannot see as files', 'mdn-opfs', ['origin private file system']),
  t('fast synchronous file access from a worker thread', 'mdn-opfs', ['createsyncaccesshandle']),
  t('opening a client side database with a version and object stores', 'mdn-indexeddb', ['version', 'object store']),
  t('running a script in a background thread so the page stays responsive', 'mdn-web-workers', ['worker', 'thread']),
  t('sending messages between the main page and a background script', 'mdn-web-workers', ['postmessage']),
  // Coral / reef
  t('why do corals go white in hot water', 'coral-bleaching', ['bleach', 'temperature']),
  t('largest reef system off the coast of australia', 'great-barrier-reef', ['reef', 'queensland']),
  // Bread / yeast
  t('keeping a starter culture of wild yeast and lactobacilli for bread', 'sourdough', ['starter']),
  t('the fungus species used to make bread rise commercially', 'bakers-yeast', ['saccharomyces']),
  // Coffee
  t('forcing hot water through finely ground beans under pressure', 'espresso', ['pressure']),
  t('where the coffee plant was first cultivated', 'coffee', ['ethiopia']),
  // Unrelated topics
  t('how the romans carried water into cities over long distances', 'roman-aqueduct', ['water']),
  t('region of spacetime where gravity is so strong light cannot get out', 'black-hole', ['light', 'escape']),
  t('how plants turn sunlight into sugar', 'photosynthesis', ['light', 'energy']),
  t('dark sunken spots on the bottom of tomatoes', 'blossom-end-rot', ['calcium']),
  t('making up a solo on the spot over chord changes', 'jazz-improvisation', ['improvis']),
  t('rollers pins and plates that transfer power from pedals', 'bicycle-chain', ['roller']),
  t('the legend of the greek messenger running to athens', 'marathon', ['pheidippides']),
  t('gutenberg movable type and the spread of books in europe', 'printing-press', ['gutenberg']),
  t('magma erupting through the earth crust', 'volcano', ['magma']),
  t('insect that makes honey and lives in colonies with a queen', 'honey-bee', ['queen']),
  t('how bees tell each other where flowers are', 'honeybee-dance', ['dance']),
  t('the first few moves of a chess game and their names', 'chess-opening', ['moves']),
  t('oldest of the seven wonders built for a pharaoh', 'great-pyramid', ['khufu']),
  t('training the immune system to recognise a disease', 'vaccine', ['immune']),
  t('japanese art of folding paper', 'origami', ['paper', 'fold']),
  t('continents drifting on moving plates', 'plate-tectonics', ['plates']),
  t('first people to reach the highest summit in the world', 'mount-everest', ['hillary']),
  t('antibiotic discovered by fleming from mould', 'penicillin', ['fleming']),
  t('drink made by steeping dried leaves in hot water', 'tea', ['leaves']),
  // No page is about these
  none('how to change a flat tyre on a car'),
  none('best exercises for lower back pain'),
  none('history of the roman senate and the republic'),
  none('how do solar panels generate electricity'),
  none('recipe for chocolate chip cookies'),
  none('rules of cricket explained for beginners'),
  none('how to learn a foreign language quickly'),
  none('migration patterns of monarch butterflies'),
  none('how does a mortgage interest rate work'),
  none('python list comprehension syntax'),
  none('symptoms of the common cold versus flu'),
  none('how to train a puppy to sit'),
  none('postgres vacuum and table bloat'),
  none('javascript promises and async await'),
  none('history of the olympic games in ancient greece'),
];

const h = (query: string, target: string, evidence: string[]): Query => ({ query, target, evidence, set: 'held-out' });
const hNone = (query: string): Query => ({ query, target: null, set: 'held-out' });

/**
 * Written after the rule in src/lib/group.ts (STRENGTH_RULE) was chosen on
 * TUNING, before any of these was run; used only to report the rule's
 * precision and recall.
 */
export const HELD_OUT: Query[] = [
  h('who owns the data after I assign one string to another variable', 'rust-ownership', ['move']),
  h("why can't I borrow something as mutable while it is also borrowed immutably", 'rust-borrowing', ['immutable']),
  h('the apostrophe a syntax in rust function signatures', 'rust-lifetimes', ["'a"]),
  h('why databases write to a journal first', 'write-ahead-logging', ['log']),
  h('tree that keeps data sorted and allows searches in logarithmic time on disk', 'b-tree', ['logarithmic']),
  h('guarantee that a transaction either fully happens or not at all', 'acid', ['transaction']),
  h('most widely deployed database engine in phones and browsers', 'sqlite', ['deployed']),
  h('storage only my site can access that is optimised for performance', 'mdn-opfs', ['performance']),
  h('storing lots of structured data in the browser with indexes and transactions', 'mdn-indexeddb', ['transaction']),
  h('terminating a worker and handling errors in it', 'mdn-web-workers', ['terminate']),
  h('mass bleaching events caused by el nino', 'coral-bleaching', ['el niño']),
  h('world heritage site made of thousands of individual reefs', 'great-barrier-reef', ['reefs']),
  h('bread leavened by naturally occurring lactic acid bacteria', 'sourdough', ['lactic']),
  h('single celled organism that turns sugar into carbon dioxide and alcohol', 'bakers-yeast', ['carbon dioxide']),
  h('crema on top of a strong italian coffee shot', 'espresso', ['crema']),
  h('aqueduct arches and siphons in ancient rome', 'roman-aqueduct', ['siphon']),
  h('event horizon and hawking radiation', 'black-hole', ['hawking']),
  h('chlorophyll and the light dependent reactions', 'photosynthesis', ['chlorophyll']),
  h('calcium deficiency in tomato and pepper fruit', 'blossom-end-rot', ['calcium']),
  h('the 26 mile race at the olympics', 'marathon', ['olympic']),
  h('mid ocean ridges and subduction zones', 'plate-tectonics', ['subduction']),
  h('the death zone and sherpas on the climb', 'mount-everest', ['sherpa']),
  h('how herd immunity works', 'vaccine', ['herd']),
  h('history of drinking tea in china', 'tea', ['china']),
  hNone('how to fix a leaking kitchen tap'),
  hNone('best hiking boots for wet weather'),
  hNone('how does a nuclear reactor control the chain reaction'),
  hNone('difference between a crocodile and an alligator'),
  hNone('rust async runtime tokio and futures'),
  hNone('mongodb document database sharding'),
  hNone('service worker caching strategies for offline web apps'),
  hNone('how coffee shops price their drinks'),
  hNone('the history of the roman colosseum'),
];

const h2 = (query: string, target: string, evidence: string[]): Query => ({ query, target, evidence, set: 'held-out-2' });
const h2None = (query: string): Query => ({ query, target: null, set: 'held-out-2' });

/**
 * HELD_OUT showed the first rule let near-topic queries through (no-target
 * clean 56%), so the rule was re-chosen on TUNING + HELD_OUT together. This
 * second set was written after that, before any of it was run, and is the
 * one the final precision/recall is reported on.
 */
export const HELD_OUT_2: Query[] = [
  h2('a value can only have one owner at a time', 'rust-ownership', ['owner']),
  h2('references that are guaranteed not to point at freed memory', 'rust-borrowing', ['dangling']),
  h2('generic lifetime parameters and the borrow checker', 'rust-lifetimes', ['borrow checker']),
  h2('redo and undo information recorded before modifying pages', 'write-ahead-logging', ['undo']),
  h2('nodes that split when they get too full', 'b-tree', ['split']),
  h2('concurrent transactions not seeing each other half done', 'acid', ['isolation']),
  h2('serverless sql database that needs no configuration', 'sqlite', ['serverless']),
  h2('reading and writing files in a sandboxed browser file system', 'mdn-opfs', ['file']),
  h2('upgrading the schema of an in browser database', 'mdn-indexeddb', ['upgrade']),
  h2('shared workers used by several pages at once', 'mdn-web-workers', ['shared']),
  h2('corals losing their symbiotic algae', 'coral-bleaching', ['algae']),
  h2('tourism and threats to the reef in queensland', 'great-barrier-reef', ['tourism']),
  h2('the sour taste of bread made with a starter', 'sourdough', ['sour']),
  h2('instant yeast versus active dry yeast', 'bakers-yeast', ['dry']),
  h2('history of the first coffee houses', 'coffee', ['coffeehouse']),
  h2('the chain link that connects the ends together', 'bicycle-chain', ['link']),
  h2('johannes gutenberg in mainz', 'printing-press', ['mainz']),
  h2('pyroclastic flows and lava domes', 'volcano', ['pyroclastic']),
  h2('worker bees and drones in the hive', 'honey-bee', ['drone']),
  h2('the sicilian defence and other replies to e4', 'chess-opening', ['sicilian']),
  h2('folding a crane from a single square sheet', 'origami', ['crane']),
  h2('how penicillin kills bacteria by attacking the cell wall', 'penicillin', ['cell wall']),
  h2None('how do noise cancelling headphones work'),
  h2None('the french revolution and the storming of the bastille'),
  h2None('how to grow basil on a windowsill'),
  h2None('go programming language goroutines and channels'),
  h2None('redis as an in memory cache'),
  h2None('react hooks and component state'),
  h2None('the deepest point in the ocean'),
  h2None('how wine is fermented from grapes'),
  h2None('the history of the egyptian sphinx'),
  h2None('training for a triathlon'),
];

export const ALL_QUERIES: Query[] = [...TUNING, ...HELD_OUT, ...HELD_OUT_2];
