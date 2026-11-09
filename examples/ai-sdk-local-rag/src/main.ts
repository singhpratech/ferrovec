import './style.css';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { Ferrovec, type InsertOptions, type QueryResult, type StoredDocument } from 'ferrovec';
import { z } from 'zod';

// ferrovec 0.5 adds per-document metadata: `insert(text, { id, metadata })`,
// and `metadata` on query hits and list rows. The package linked here may
// still be 0.4, so these local types describe the 0.5 shape.
// TODO(0.5): drop the casts and these types once the linked package is 0.5.
type InsertWithMeta = InsertOptions & { metadata?: Record<string, unknown> };
type WithMeta<T> = T & { metadata?: Record<string, unknown> };

const STORE_NAME = 'ai-sdk-local-rag';
const NOTES_PAGE = 1000;

const SAMPLE_NOTES = [
  'The spare house key is in the blue flower pot by the back door.',
  'Dentist appointment moved to Thursday 14 November at 9:30.',
  'Wi-Fi password for the guest network is on the back of the router.',
  'Mia is allergic to peanuts; Sam does not eat pork.',
  'The car is due for its next service at 60,000 km.',
];

const INSTRUCTIONS = [
  "You answer questions about the user's personal notes.",
  'Always call the searchNotes tool before answering.',
  'Answer only from the notes it returns and cite the note ids you used in square brackets.',
  "If the notes do not contain the answer, say you don't know.",
].join(' ');

// ---- DOM ------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const storeStatus = el<HTMLParagraphElement>('store-status');
const baseUrlInput = el<HTMLInputElement>('base-url');
const modelInput = el<HTMLInputElement>('model');
const apiKeyInput = el<HTMLInputElement>('api-key');
const noteForm = el<HTMLFormElement>('note-form');
const noteText = el<HTMLTextAreaElement>('note-text');
const addNoteBtn = el<HTMLButtonElement>('add-note');
const addSamplesBtn = el<HTMLButtonElement>('add-samples');
const noteList = el<HTMLUListElement>('note-list');
const transcript = el<HTMLOListElement>('transcript');
const chatForm = el<HTMLFormElement>('chat-form');
const questionInput = el<HTMLInputElement>('question');
const sendBtn = el<HTMLButtonElement>('send');
const stopBtn = el<HTMLButtonElement>('stop');

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- Notes (ferrovec) -----------------------------------------------------

let db: Ferrovec | null = null;

async function addNote(text: string): Promise<void> {
  if (!db) return;
  const options: InsertWithMeta = {
    metadata: { source: 'note', addedAt: new Date().toISOString() },
  };
  // TODO(0.5): drop the cast once InsertOptions has `metadata`.
  await db.insert(text, options as InsertOptions);
}

async function renderNotes(): Promise<void> {
  if (!db) return;
  const docs = (await db.list({ limit: NOTES_PAGE })) as WithMeta<StoredDocument>[];
  noteList.replaceChildren();
  if (docs.length === 0) {
    noteList.append(make('li', 'muted', 'No notes yet.'));
    return;
  }
  for (const doc of docs) {
    const item = make('li', 'note');
    const body = make('p', 'note-text', doc.text);
    const meta = make('p', 'note-meta muted');
    const addedAt = doc.metadata?.addedAt;
    meta.textContent = typeof addedAt === 'string' ? `${doc.id} · ${new Date(addedAt).toLocaleString()}` : doc.id;
    const remove = make('button', 'link', 'Delete');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete note ${doc.id}`);
    remove.addEventListener('click', () => {
      void (async () => {
        await db?.remove(doc.id);
        await renderNotes();
      })();
    });
    meta.append(' ', remove);
    item.append(body, meta);
    noteList.append(item);
  }
}

noteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = noteText.value.trim();
  if (!text) return;
  addNoteBtn.disabled = true;
  void (async () => {
    try {
      await addNote(text);
      noteText.value = '';
      await renderNotes();
    } catch (err) {
      storeStatus.textContent = `Could not add the note: ${errorMessage(err)}`;
    } finally {
      addNoteBtn.disabled = false;
    }
  })();
});

addSamplesBtn.addEventListener('click', () => {
  addSamplesBtn.disabled = true;
  void (async () => {
    try {
      for (const text of SAMPLE_NOTES) await addNote(text);
      await renderNotes();
    } catch (err) {
      storeStatus.textContent = `Could not add the sample notes: ${errorMessage(err)}`;
    } finally {
      addSamplesBtn.disabled = false;
    }
  })();
});

// ---- Chat (AI SDK) --------------------------------------------------------

/** Conversation so far, as model messages. Lives in memory only. */
const messages: ModelMessage[] = [];
let inflight: AbortController | null = null;

interface NoteHit {
  id: string;
  score: number;
  text: string;
  addedAt?: string;
}

function toNoteHit(hit: WithMeta<QueryResult>): NoteHit {
  const addedAt = hit.metadata?.addedAt;
  return {
    id: hit.id,
    score: Math.round(hit.score * 1000) / 1000,
    text: hit.text ?? '',
    ...(typeof addedAt === 'string' ? { addedAt } : {}),
  };
}

function buildTools(store: Ferrovec) {
  return {
    searchNotes: tool({
      description:
        "Semantic search over the user's notes. Returns the closest notes with their id, similarity score (higher is closer) and text.",
      inputSchema: z.object({
        query: z.string().describe('What to look for, in plain words.'),
        k: z.number().int().min(1).max(10).optional().describe('How many notes to return (default 4).'),
      }),
      execute: async ({ query, k }): Promise<NoteHit[]> => {
        const hits = (await store.query(query, k ?? 4)) as WithMeta<QueryResult>[];
        return hits.map(toNoteHit);
      },
    }),
  };
}

function appendTurn(role: 'user' | 'assistant', text = ''): { item: HTMLLIElement; body: HTMLParagraphElement } {
  const item = make('li', `turn ${role}`);
  const body = make('p', 'turn-text', text);
  item.append(make('span', 'turn-role muted', role === 'user' ? 'You' : 'Model'), body);
  transcript.append(item);
  item.scrollIntoView({ block: 'end' });
  return { item, body };
}

function renderRetrieved(container: HTMLElement, query: string, hits: NoteHit[]): void {
  const block = make('div', 'retrieved');
  block.append(make('p', 'retrieved-head muted', `searchNotes("${query}") → ${hits.length} note(s)`));
  const list = make('ul');
  for (const hit of hits) {
    const row = make('li');
    row.append(make('code', undefined, hit.id), ` ${hit.score.toFixed(3)} `);
    row.append(make('span', 'muted', hit.text.length > 80 ? `${hit.text.slice(0, 80)}…` : hit.text));
    list.append(row);
  }
  block.append(list);
  container.append(block);
}

async function ask(question: string): Promise<void> {
  if (!db) return;
  appendTurn('user', question);
  const { item, body } = appendTurn('assistant');
  body.classList.add('pending');

  const provider = createOpenAICompatible({
    name: 'local',
    baseURL: baseUrlInput.value.trim(),
    // Read from the input on every request; never written to storage.
    ...(apiKeyInput.value ? { apiKey: apiKeyInput.value } : {}),
  });

  messages.push({ role: 'user', content: question });
  inflight = new AbortController();
  let searched = false;

  try {
    const result = streamText({
      model: provider(modelInput.value.trim()),
      instructions: INSTRUCTIONS,
      messages,
      tools: buildTools(db),
      stopWhen: stepCountIs(3),
      abortSignal: inflight.signal,
    });

    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          body.classList.remove('pending');
          body.textContent += part.text;
          break;
        case 'tool-result':
          if (part.toolName === 'searchNotes' && !part.dynamic) {
            searched = true;
            renderRetrieved(item, part.input.query, part.output);
          }
          break;
        case 'tool-error':
          item.append(make('p', 'error', `Tool ${part.toolName} failed: ${errorMessage(part.error)}`));
          break;
        case 'error':
          throw part.error;
      }
    }

    messages.push(...(await result.responseMessages));
    if (!searched) item.append(make('p', 'retrieved-head muted', 'The model answered without searching the notes.'));
  } catch (err) {
    // Keep the history consistent: drop the user turn that got no answer.
    if (messages.at(-1)?.role === 'user') messages.pop();
    item.append(make('p', 'error', inflight.signal.aborted ? 'Stopped.' : `Request failed: ${errorMessage(err)}`));
  } finally {
    body.classList.remove('pending');
    if (!body.textContent) body.remove();
    inflight = null;
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question || inflight) return;
  questionInput.value = '';
  sendBtn.disabled = true;
  stopBtn.hidden = false;
  void ask(question).finally(() => {
    sendBtn.disabled = false;
    stopBtn.hidden = true;
    questionInput.focus();
  });
});

stopBtn.addEventListener('click', () => inflight?.abort());

// ---- Boot -----------------------------------------------------------------

async function boot(): Promise<void> {
  storeStatus.textContent = 'Opening the store (the first open downloads the embedding model, about 23 MB)…';
  try {
    db = await Ferrovec.open(STORE_NAME);
  } catch (err) {
    storeStatus.textContent = `Could not open the store: ${errorMessage(err)}`;
    return;
  }
  const where = db.persistent ? 'saved in this browser (OPFS)' : 'in memory only (OPFS unavailable here)';
  storeStatus.textContent = `Store "${STORE_NAME}" open, ${where}, role: ${db.role}.`;
  addNoteBtn.disabled = false;
  addSamplesBtn.disabled = false;
  sendBtn.disabled = false;
  await renderNotes();
}

void boot();
