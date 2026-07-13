import type {
  CoreModelGenerateOptions,
  CoreModelTransport,
} from './types';

/**
 * Minimal structural types for the slice of node-llama-cpp this transport
 * uses, mirroring how the Gemini SDK is wrapped in src/providers/runtime.ts.
 */
interface LlamaGrammarLike {
  parse(text: string): unknown;
}

interface LlamaContextSequenceLike {
  readonly disposed?: boolean;
}

interface LlamaContextLike {
  getSequence(): LlamaContextSequenceLike;
  dispose(): Promise<void>;
}

interface LlamaModelLike {
  createContext(options?: { contextSize?: number }): Promise<LlamaContextLike>;
}

interface LlamaLike {
  loadModel(options: { modelPath: string }): Promise<LlamaModelLike>;
  createGrammarForJsonSchema(schema: Record<string, unknown>): Promise<LlamaGrammarLike>;
}

interface LlamaChatSessionLike {
  prompt(text: string, options?: {
    grammar?: LlamaGrammarLike;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
}

interface NodeLlamaCppModule {
  getLlama(): Promise<LlamaLike>;
  LlamaChatSession: new (options: {
    contextSequence: LlamaContextSequenceLike;
    systemPrompt?: string;
  }) => LlamaChatSessionLike;
}

// node-llama-cpp is ESM-only. The indirect import keeps esbuild's CJS server
// bundle from rewriting this into a require() call that cannot load it.
const importNodeLlamaCpp = new Function(
  'return import("node-llama-cpp")',
) as () => Promise<NodeLlamaCppModule>;

const CONTEXT_SIZE = 4096;

/**
 * In-process llama.cpp transport. Calls are serialized because each request
 * allocates one bounded context on the shared model.
 */
export const createLlamaTransport = async (modelPath: string): Promise<CoreModelTransport> => {
  const { getLlama, LlamaChatSession } = await importNodeLlamaCpp();
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  let queue: Promise<unknown> = Promise.resolve();

  const generateJson = (options: CoreModelGenerateOptions): Promise<unknown> => {
    const run = queue.then(async () => {
      const grammar = await llama.createGrammarForJsonSchema(
        options.schema as unknown as Record<string, unknown>,
      );
      const context = await model.createContext({ contextSize: CONTEXT_SIZE });
      try {
        const session = new LlamaChatSession({
          contextSequence: context.getSequence(),
          systemPrompt: options.systemInstruction,
        });
        const answer = await session.prompt(options.prompt, {
          grammar,
          maxTokens: options.maxTokens,
          temperature: 0,
        });
        return JSON.parse(answer) as unknown;
      } finally {
        await context.dispose();
      }
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return { generateJson };
};
