# Local RAG: ferrovec + Vercel AI SDK

A chat-with-your-notes page where retrieval and generation both run on your
machine:

- **ferrovec** embeds and stores the notes inside the browser (transformers.js
  on a Web Worker, HNSW index persisted to OPFS). Notes survive reloads.
- **The Vercel AI SDK** (`ai` v7, `@ai-sdk/openai-compatible`) talks to a local
  OpenAI-compatible model server, Ollama by default. The model gets one tool,
  `searchNotes`, which calls `db.query()` in the page.

Under each answer the page lists the notes the model retrieved, with their ids
and similarity scores.

When the base URL points at `localhost`, nothing leaves the machine: the notes,
their vectors and the chat all stay between the browser tab and your local model
server. The one network fetch is the first-open download of the embedding model
(`Xenova/all-MiniLM-L6-v2`, about 23 MB) from the Hugging Face Hub; it is cached
after that.

## Run it

1. Install [Ollama](https://ollama.com) and pull a model that supports tool
   calling:

   ```sh
   ollama pull llama3.2
   ```

   Ollama serves an OpenAI-compatible API at `http://localhost:11434/v1` and
   accepts browser requests from `localhost` origins by default. To serve the
   page from another origin, set `OLLAMA_ORIGINS` (for example
   `OLLAMA_ORIGINS=http://my-host:5173 ollama serve`).

2. Build the ferrovec package once (this example links it from `../../js`):

   ```sh
   cd ../../js && npm ci && npm run build && cd -
   ```

3. Start the example:

   ```sh
   npm i && npm run dev
   ```

   Open the printed `http://localhost:5173` URL, add a few notes (or click
   **Add sample notes**), then ask a question.

Any other OpenAI-compatible server works too (LM Studio, llama.cpp
`llama-server`, vLLM): change the base URL and model in the settings row. The
server must allow CORS from the page's origin. The optional API key is sent as
`Authorization: Bearer <key>`; it is held in the input field only, never written
to storage, and is gone on reload.

## How it fits together

```ts
const db = await Ferrovec.open('ai-sdk-local-rag');
await db.insert(text, { metadata: { source: 'note', addedAt } });

const local = createOpenAICompatible({ name: 'local', baseURL, apiKey });
const result = streamText({
  model: local('llama3.2'),
  instructions: 'Always call searchNotes before answering…',
  messages,
  tools: {
    searchNotes: tool({
      description: "Semantic search over the user's notes.",
      inputSchema: z.object({ query: z.string(), k: z.number().int().optional() }),
      execute: ({ query, k }) => db.query(query, k ?? 4),
    }),
  },
  stopWhen: stepCountIs(3),
});
for await (const part of result.stream) { /* text-delta, tool-result, … */ }
```

The whole page is `src/main.ts`. `vite.config.ts` sets `worker.format: 'es'`
(ferrovec's worker code-splits) and excludes `ferrovec` from dependency
pre-bundling so its worker and wasm URLs resolve to the real files.

Notes:

- Small local models do not always call the tool. When the model answers
  without searching, the page says so under the answer.
- Per-document `metadata` needs ferrovec 0.5. With 0.4 the notes are stored and
  searched the same way, the metadata is just not kept.
- `npm run build` writes a static site to `dist/`. Serve it over `http://localhost`
  or HTTPS: OPFS persistence needs a secure context.
