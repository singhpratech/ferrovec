/**
 * The real-content corpus for the relevance measurement: long-form pages on
 * clearly different topics, plus deliberately related groups (three Rust book
 * chapters, four database articles, three browser-storage MDN pages,
 * coral/reef, sourdough/yeast, espresso/coffee).
 *
 * Pages are fetched once by fetch.ts into a gitignored cache and served to the
 * extension over the harness proxy under `<site>.test` hosts (a real host over
 * plain http would be upgraded to https by HSTS and refused by the proxy).
 */

export interface RealPage {
  /** Short id used by the query sets. */
  id: string;
  /** The page on the web. */
  url: string;
}

const wiki = (id: string, title: string): RealPage => ({ id, url: `https://en.wikipedia.org/wiki/${title}` });
const rust = (id: string, path: string): RealPage => ({ id, url: `https://doc.rust-lang.org/book/${path}` });
const mdn = (id: string, path: string): RealPage => ({ id, url: `https://developer.mozilla.org/en-US/docs/Web/API/${path}` });

export const PAGES: RealPage[] = [
  // Unrelated topics
  wiki('coral-bleaching', 'Coral_bleaching'),
  wiki('sourdough', 'Sourdough'),
  wiki('roman-aqueduct', 'Roman_aqueduct'),
  wiki('black-hole', 'Black_hole'),
  wiki('photosynthesis', 'Photosynthesis'),
  wiki('blossom-end-rot', 'Blossom-end_rot'),
  wiki('jazz-improvisation', 'Jazz_improvisation'),
  wiki('bicycle-chain', 'Bicycle_chain'),
  wiki('marathon', 'Marathon'),
  wiki('printing-press', 'Printing_press'),
  wiki('espresso', 'Espresso'),
  wiki('volcano', 'Volcano'),
  wiki('honey-bee', 'Western_honey_bee'),
  wiki('chess-opening', 'Chess_opening'),
  wiki('great-pyramid', 'Great_Pyramid_of_Giza'),
  wiki('vaccine', 'Vaccine'),
  wiki('origami', 'Origami'),
  wiki('plate-tectonics', 'Plate_tectonics'),
  wiki('mount-everest', 'Mount_Everest'),
  wiki('penicillin', 'Penicillin'),
  // Related to unrelated-topic pages above
  wiki('great-barrier-reef', 'Great_Barrier_Reef'),
  wiki('bakers-yeast', "Baker's_yeast"),
  wiki('coffee', 'Coffee'),
  // Databases
  wiki('write-ahead-logging', 'Write-ahead_logging'),
  wiki('b-tree', 'B-tree'),
  wiki('acid', 'ACID'),
  wiki('sqlite', 'SQLite'),
  // The Rust book
  rust('rust-ownership', 'ch04-01-what-is-ownership.html'),
  rust('rust-borrowing', 'ch04-02-references-and-borrowing.html'),
  rust('rust-lifetimes', 'ch10-03-lifetime-syntax.html'),
  // Browser storage (MDN)
  mdn('mdn-opfs', 'File_System_API/Origin_private_file_system'),
  mdn('mdn-indexeddb', 'IndexedDB_API/Using_IndexedDB'),
  mdn('mdn-web-workers', 'Web_Workers_API/Using_web_workers'),
  // Two more unrelated
  wiki('honeybee-dance', 'Waggle_dance'),
  wiki('tea', 'Tea'),
];

/** The URL the extension sees: same path, on a `.test` host the proxy serves. */
export function servedUrl(page: RealPage): string {
  const u = new URL(page.url);
  const site = u.hostname.includes('wikipedia')
    ? 'wikipedia'
    : u.hostname.includes('rust-lang')
      ? 'rustbook'
      : u.hostname.includes('mozilla')
        ? 'mdn'
        : u.hostname.replace(/\./g, '-');
  return `http://${site}.test${u.pathname}`;
}
