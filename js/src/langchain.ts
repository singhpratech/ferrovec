/**
 * LangChain.js adapter: `ferrovec/langchain`.
 *
 * {@link FerrovecVectorStore} is a LangChain `VectorStore` over a ferrovec
 * store. ferrovec embeds inside its worker, so the adapter hands LangChain
 * text, not vectors: `addDocuments` inserts each document's `pageContent` with
 * its `metadata`, and `similaritySearch` sends the query text. The
 * vector-level entry points (`addVectors`, `similaritySearchVectorWithScore`)
 * throw, and the default `embeddings` is a stub that throws if LangChain ever
 * asks it to embed.
 *
 * This module is a separate entry point so `@langchain/core` (an optional
 * peer dependency) is only loaded by apps that import `ferrovec/langchain`;
 * the main `ferrovec` entry never imports it.
 *
 * ```ts
 * import { FerrovecVectorStore } from 'ferrovec/langchain';
 *
 * const store = await FerrovecVectorStore.open('notes');
 * await store.addDocuments([{ pageContent: 'the cat sat on the mat', metadata: { source: 'a' } }]);
 * const docs = await store.asRetriever(4).invoke('where did the cat sit?');
 * ```
 */

import { Document, type DocumentInterface } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { VectorStore } from '@langchain/core/vectorstores';

import type { FerrovecOptions, InsertOptions } from './ferrovec.ts';
import type { Metadata } from './metadata.ts';
import type { ListOptions, QueryResult, StoredDocument } from './types.ts';

/**
 * The part of a `Ferrovec` instance the adapter uses. Structural, so any
 * object with these methods works (tests pass an `Engine`-backed shim).
 */
export interface FerrovecLike {
  insert(text: string, options?: InsertOptions): Promise<string>;
  query(text: string, k?: number): Promise<QueryResult[]>;
  remove(id: string): Promise<boolean>;
  list(options?: ListOptions): Promise<StoredDocument[]>;
}

/** Metadata filter: every key must be present on a document's metadata with an equal JSON value. */
export type FerrovecFilter = Record<string, unknown>;

/** Options for the {@link FerrovecVectorStore} constructor. */
export interface FerrovecVectorStoreOptions {
  /**
   * Reported as the store's `embeddings`. ferrovec never calls it; defaults to
   * {@link FerrovecEmbeddings}, which throws if anything else does.
   */
  embeddings?: EmbeddingsInterface;
}

const EMBEDS_INTERNALLY = 'ferrovec embeds inside its worker; use addDocuments/similaritySearch';

/**
 * Placeholder `EmbeddingsInterface` for a {@link FerrovecVectorStore}. The
 * embedding model runs inside ferrovec's worker (chosen with `Ferrovec.open`'s
 * `model` option), so there is nothing to embed on this side: both methods
 * throw.
 */
export class FerrovecEmbeddings implements EmbeddingsInterface {
  async embedDocuments(_documents: string[]): Promise<number[][]> {
    throw new Error(EMBEDS_INTERNALLY);
  }

  async embedQuery(_document: string): Promise<number[]> {
    throw new Error(EMBEDS_INTERNALLY);
  }
}

/** Structural equality over JSON values (what metadata holds after a round trip). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => Object.hasOwn(b, k) && jsonEqual((a as Metadata)[k], (b as Metadata)[k]))
  );
}

function matches(metadata: Metadata | undefined, filter: FerrovecFilter): boolean {
  return Object.entries(filter).every(
    ([key, value]) => metadata !== undefined && Object.hasOwn(metadata, key) && jsonEqual(metadata[key], value),
  );
}

/**
 * A LangChain `VectorStore` backed by a ferrovec store.
 *
 * - `addDocuments(docs, { ids })` inserts each `pageContent` with its
 *   `metadata` (an empty metadata object is stored as none). Ids come from
 *   `ids`, else each document's `id`, else ferrovec assigns one; the ids used
 *   are returned. An existing id is replaced, metadata included.
 * - `similaritySearch(query, k, filter)` / `similaritySearchWithScore` return
 *   `Document`s with `id`, `pageContent` (the stored text) and `metadata`, and
 *   ferrovec's score (cosine similarity, higher is closer).
 * - `filter` is exact match on top-level metadata keys: a document matches
 *   when every key in the filter is present with an equal value (arrays and
 *   objects compared by value). It is applied to the nearest
 *   `min(k * 4, k + 50)` hits, so a filter that matches few documents can
 *   return fewer than `k` even when more matches exist further away.
 * - `delete({ ids })` removes those ids.
 * - `asRetriever()` works as for any `VectorStore`.
 */
export class FerrovecVectorStore extends VectorStore {
  declare FilterType: FerrovecFilter;

  /** The ferrovec store this adapter reads and writes. */
  readonly db: FerrovecLike;

  constructor(db: FerrovecLike, options: FerrovecVectorStoreOptions = {}) {
    super(options.embeddings ?? new FerrovecEmbeddings(), {});
    this.db = db;
  }

  _vectorstoreType(): string {
    return 'ferrovec';
  }

  /** Open (or create) the ferrovec store `name` in a worker and wrap it. Browser only, like `Ferrovec.open`. */
  static async open(
    name: string,
    ferrovecOptions: FerrovecOptions = {},
    options: FerrovecVectorStoreOptions = {},
  ): Promise<FerrovecVectorStore> {
    const { Ferrovec } = await import('./ferrovec.ts');
    return new FerrovecVectorStore(await Ferrovec.open(name, ferrovecOptions), options);
  }

  /** Wrap `db` and add `docs` to it. `embeddings` is only reported, never called. */
  static async fromDocuments(
    docs: DocumentInterface[],
    embeddings: EmbeddingsInterface | undefined,
    dbConfig: { db: FerrovecLike },
  ): Promise<FerrovecVectorStore> {
    const store = new FerrovecVectorStore(dbConfig.db, embeddings ? { embeddings } : {});
    await store.addDocuments(docs);
    return store;
  }

  /** Wrap `db` and add `texts`, with `metadatas[i]` (or one shared object) as each one's metadata. */
  static async fromTexts(
    texts: string[],
    metadatas: object[] | object,
    embeddings: EmbeddingsInterface | undefined,
    dbConfig: { db: FerrovecLike },
  ): Promise<FerrovecVectorStore> {
    const docs = texts.map(
      (pageContent, i) =>
        new Document({
          pageContent,
          metadata: (Array.isArray(metadatas) ? metadatas[i] : metadatas) as Metadata | undefined,
        }),
    );
    return FerrovecVectorStore.fromDocuments(docs, embeddings, dbConfig);
  }

  /** Insert each document's text and metadata; resolves with the ids used, in order. */
  async addDocuments(documents: DocumentInterface[], options: { ids?: string[] } = {}): Promise<string[]> {
    const { ids } = options;
    if (ids !== undefined && ids.length !== documents.length) {
      throw new Error(`[ferrovec] addDocuments: got ${ids.length} ids for ${documents.length} documents`);
    }
    const out: string[] = [];
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i]!;
      const id = ids?.[i] ?? doc.id;
      const metadata = doc.metadata as Metadata | undefined;
      const hasMetadata = metadata !== undefined && metadata !== null && Object.keys(metadata).length > 0;
      out.push(
        await this.db.insert(doc.pageContent, {
          ...(id !== undefined ? { id } : {}),
          ...(hasMetadata ? { metadata } : {}),
        }),
      );
    }
    return out;
  }

  /** Not supported: ferrovec embeds text itself and has no raw-vector insert. Use {@link addDocuments}. */
  async addVectors(_vectors: number[][], _documents: DocumentInterface[], _options?: object): Promise<string[]> {
    throw new Error('[ferrovec] addVectors is not supported: ferrovec embeds text itself; use addDocuments');
  }

  /** Not supported: ferrovec has no raw-vector query. Use {@link similaritySearchWithScore}. */
  async similaritySearchVectorWithScore(
    _query: number[],
    _k: number,
    _filter?: FerrovecFilter,
  ): Promise<[DocumentInterface, number][]> {
    throw new Error(
      '[ferrovec] similaritySearchVectorWithScore is not supported: ferrovec embeds the query itself; use similaritySearchWithScore',
    );
  }

  /** The `k` nearest documents to `query` (optionally filtered), each with its score. */
  async similaritySearchWithScore(
    query: string,
    k = 4,
    filter?: FerrovecFilter,
    _callbacks?: unknown,
  ): Promise<[DocumentInterface, number][]> {
    const filtered = filter !== undefined && filter !== null && Object.keys(filter).length > 0;
    const fetchK = filtered ? Math.min(k * 4, k + 50) : k;
    let hits = await this.db.query(query, fetchK);
    if (filtered) hits = hits.filter((hit) => matches(hit.metadata, filter)).slice(0, k);
    return hits.map((hit) => [
      new Document({ pageContent: hit.text ?? '', metadata: hit.metadata ?? {}, id: hit.id }),
      hit.score,
    ]);
  }

  /** The `k` nearest documents to `query` (optionally filtered). */
  async similaritySearch(
    query: string,
    k = 4,
    filter?: FerrovecFilter,
    _callbacks?: unknown,
  ): Promise<DocumentInterface[]> {
    return (await this.similaritySearchWithScore(query, k, filter)).map(([doc]) => doc);
  }

  /** Remove the documents stored under `ids`. Ids that are not stored are ignored. */
  async delete(params: { ids?: string[] } = {}): Promise<void> {
    if (params.ids === undefined) throw new Error('[ferrovec] delete needs { ids }');
    for (const id of params.ids) await this.db.remove(id);
  }
}
