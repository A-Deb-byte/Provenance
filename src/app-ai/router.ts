import crypto from 'node:crypto';
import express from 'express';
import type {
  JsonSchema,
  ProviderExecution,
  ProviderRequest,
  ProviderRoutingPolicy,
} from '../providers/types';
import { assertValidStructuredOutput } from '../providers/schema';
import { ProviderError } from '../providers/errors';

export type ApplicationAiChannel = 'chat' | 'extract' | 'mutate' | 'skill_draft';

export interface ApplicationAiExecution {
  execution: ProviderExecution;
  evidenceEventId: string;
}

export interface ApplicationAiExecutor {
  execute(
    channel: ApplicationAiChannel,
    request: ProviderRequest,
    policy: ProviderRoutingPolicy,
  ): Promise<ApplicationAiExecution>;
}

export interface ApplicationAiRouterOptions {
  executor: ApplicationAiExecutor;
  routingPolicy: ProviderRoutingPolicy;
  maxAttempts?: number;
}

const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: string[],
): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

const stringArraySchema: JsonSchema = { type: 'array', items: { type: 'string' } };

const schemas = {
  chat: objectSchema({
    responseContent: { type: 'string' },
    retrievedMemoryIds: stringArraySchema,
  }, ['responseContent', 'retrievedMemoryIds']),
  extract: objectSchema({
    newMemories: {
      type: 'array',
      items: objectSchema({
        content: { type: 'string' },
        category: { type: 'string', enum: ['personal', 'technical', 'work', 'preferences', 'general'] },
        importance: { type: 'integer' },
        sourceSnippet: { type: 'string' },
      }, ['content', 'category', 'importance', 'sourceSnippet']),
    },
    deletedMemoryIds: stringArraySchema,
    updatedBio: { type: 'string' },
  }, ['newMemories', 'deletedMemoryIds', 'updatedBio']),
  mutate: objectSchema({
    title: { type: 'string' },
    novelInsight: { type: 'string' },
    mathematicalBounds: { type: 'string' },
    suggestedActionItems: stringArraySchema,
  }, ['title', 'novelInsight', 'mathematicalBounds', 'suggestedActionItems']),
  skillDraft: objectSchema({
    deficitIdentified: { type: 'string' },
    synthesizedSkillName: { type: 'string' },
    synthesizedSkillDescription: { type: 'string' },
    proposedOperations: {
      type: 'array',
      items: { type: 'string', enum: ['trim', 'collapse_whitespace', 'lowercase', 'uppercase', 'sort_lines'] },
    },
    deterministicCases: {
      type: 'array',
      items: objectSchema({
        input: { type: 'string' },
        expectedOutput: { type: 'string' },
      }, ['input', 'expectedOutput']),
    },
    draftNotes: stringArraySchema,
  }, [
    'deficitIdentified',
    'synthesizedSkillName',
    'synthesizedSkillDescription',
    'proposedOperations',
    'deterministicCases',
    'draftNotes',
  ]),
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const stringValue = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Provider response field ${field} is invalid.`);
  return value;
};

const stringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Provider response field ${field} is invalid.`);
  }
  return value;
};

const structuredResult = (execution: ProviderExecution): Record<string, unknown> => {
  const result = execution.results[0];
  if (!result) throw new Error('Provider execution returned no result.');
  const value = result.structured ?? (() => {
    try {
      return JSON.parse(result.text) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (!isRecord(value)) throw new Error('Provider response did not match the required structured schema.');
  return value;
};

const providerMetadata = (result: ApplicationAiExecution) => {
  const first = result.execution.results[0];
  return {
    servedBy: first?.provider ?? 'unknown',
    model: first?.model ?? 'unknown',
    evidenceEventId: result.evidenceEventId,
    route: result.execution.plan,
  };
};

const executeStructured = async (
  options: ApplicationAiRouterOptions,
  channel: ApplicationAiChannel,
  messages: ProviderRequest['messages'],
  schemaName: string,
  schema: JsonSchema,
  maxOutputTokens: number,
): Promise<{ value: Record<string, unknown>; result: ApplicationAiExecution }> => {
  const maxAttempts = Number.isSafeInteger(options.maxAttempts)
    ? Math.max(1, Math.min(options.maxAttempts!, 3))
    : 2;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const request: ProviderRequest = {
      id: `app_ai_${channel}_${crypto.randomUUID()}`,
      messages: [{
        role: 'system',
        content: [
          `Return only one JSON object matching this schema (${schemaName}): ${JSON.stringify(schema)}`,
          attempt > 1 ? 'A prior model failed the JSON contract. Do not use prose or markdown fences.' : '',
        ].filter(Boolean).join('\n'),
      }, ...messages],
      requiredCapabilities: ['text', 'json_object'],
      responseFormat: { type: 'json_object' },
      maxOutputTokens,
      temperature: 0,
      metadata: { channel, attempt: String(attempt) },
    };
    try {
      const result = await options.executor.execute(channel, request, options.routingPolicy);
      const value = structuredResult(result.execution);
      assertValidStructuredOutput(
        value,
        schema,
        result.execution.results[0]?.provider ?? 'openrouter',
      );
      return { value, result };
    } catch (error) {
      lastError = error;
      const retryableContractFailure = error instanceof ProviderError && (
        error.code === 'invalid_response' || error.code === 'rate_limited' ||
        error.code === 'timeout' || error.code === 'unavailable' || error.code === 'transport'
      );
      if (!retryableContractFailure) break;
    }
  }
  throw lastError;
};

const frameworkInstruction = (framework: unknown): string => {
  if (framework === 'prover') return 'Explain conclusions step by step using explicit evidence, without exposing hidden chain-of-thought.';
  if (framework === 'archivist') return 'Prioritize definitions, source-grounded synthesis, counterpoints, and concise structure.';
  if (framework === 'sentinel') return 'Stress-test assumptions and provide concrete counterexamples or edge cases.';
  return 'Map connections structurally with clear categories, graphs, trees, or other useful formal representations.';
};

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Application AI request failed.'
);

export const createApplicationAiRouter = (options: ApplicationAiRouterOptions) => {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    const messages = req.body?.messages as unknown;
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'A non-empty messages array is required.' });
      return;
    }
    const safeMessages = messages.flatMap((message): Array<{ role: 'user' | 'assistant'; content: string }> => (
      isRecord(message) && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string'
        ? [{ role: message.role, content: message.content }]
        : []
    ));
    if (safeMessages.length !== messages.length) {
      res.status(400).json({ error: 'Chat messages are invalid.' });
      return;
    }
    const memories = Array.isArray(req.body?.memories) ? req.body.memories : [];
    const formattedMemories = memories.flatMap((memory): string[] => (
      isRecord(memory) && typeof memory.id === 'string' && typeof memory.content === 'string'
        ? [`- [${memory.id}]: ${memory.content}`]
        : []
    )).join('\n') || 'No promoted memories are available.';
    const bio = isRecord(req.body?.userProfile) && typeof req.body.userProfile.bio === 'string'
      ? req.body.userProfile.bio : '';
    try {
      const { value, result } = await executeStructured(options, 'chat', [{
        role: 'system',
        content: [
          'You are the conversational interface of a local-first agent control plane.',
          'Use only the supplied promoted memory as durable user knowledge.',
          'Return the requested JSON object. retrievedMemoryIds may contain only ids supplied below.',
          frameworkInstruction(req.body?.agentFramework),
          `User profile: ${bio || 'Not provided.'}`,
          `Promoted memory:\n${formattedMemories}`,
        ].join('\n\n'),
      }, ...safeMessages], 'application_chat_response', schemas.chat, 4096);
      res.json({
        responseContent: stringValue(value.responseContent, 'responseContent'),
        retrievedMemoryIds: stringArray(value.retrievedMemoryIds, 'retrievedMemoryIds'),
        ...providerMetadata(result),
      });
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  router.post('/extract', async (req, res) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (messages.length === 0) {
      res.status(400).json({ error: 'A non-empty messages array is required.' });
      return;
    }
    const history = messages.slice(-8).flatMap((message): string[] => (
      isRecord(message) && typeof message.content === 'string'
        ? [`[${message.role === 'assistant' ? 'Assistant' : 'User'}] ${message.content}`]
        : []
    )).join('\n');
    const currentMemories = Array.isArray(req.body?.currentMemories) ? req.body.currentMemories : [];
    const current = currentMemories.flatMap((memory): string[] => (
      isRecord(memory) && typeof memory.id === 'string' && typeof memory.content === 'string'
        ? [`- [${memory.id}]: ${memory.content}`]
        : []
    )).join('\n') || 'None.';
    const currentBio = isRecord(req.body?.userProfile) && typeof req.body.userProfile.bio === 'string'
      ? req.body.userProfile.bio : '';
    try {
      const { value, result } = await executeStructured(options, 'extract', [{
        role: 'system',
        content: [
          'Extract only explicit, durable facts stated by the user. Never infer sensitive attributes.',
          'Every new memory must include an exact sourceSnippet from a user message.',
          'deletedMemoryIds may contain only ids from the supplied current memory list.',
          'Return the requested JSON object.',
          `Current bio: ${currentBio || 'None.'}`,
          `Current promoted memory:\n${current}`,
        ].join('\n\n'),
      }, { role: 'user', content: history }], 'application_memory_extraction', schemas.extract, 4096);
      const rawMemories = Array.isArray(value.newMemories) ? value.newMemories : [];
      const newMemories = rawMemories.map((memory, index) => {
        if (!isRecord(memory)) throw new Error(`Provider response memory ${index} is invalid.`);
        const importance = Number(memory.importance);
        if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
          throw new Error(`Provider response memory ${index} importance is invalid.`);
        }
        const category = stringValue(memory.category, `newMemories[${index}].category`);
        if (!['personal', 'technical', 'work', 'preferences', 'general'].includes(category)) {
          throw new Error(`Provider response memory ${index} category is invalid.`);
        }
        return {
          content: stringValue(memory.content, `newMemories[${index}].content`),
          category,
          importance,
          sourceSnippet: stringValue(memory.sourceSnippet, `newMemories[${index}].sourceSnippet`),
        };
      });
      res.json({
        newMemories,
        deletedMemoryIds: stringArray(value.deletedMemoryIds, 'deletedMemoryIds'),
        updatedBio: stringValue(value.updatedBio, 'updatedBio'),
        ...providerMetadata(result),
      });
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  router.post('/mutate', async (req, res) => {
    if (typeof req.body?.idea !== 'string' || !req.body.idea.trim()) {
      res.status(400).json({ error: 'A non-empty idea is required.' });
      return;
    }
    const operators: Record<string, string> = {
      heuristic_leap: 'Transfer a precise abstraction from another technical field and state the mapping limits.',
      axiomatic_friction: 'Challenge one foundational assumption and derive the resulting formal regime.',
      combinatorial: 'Construct a defensible intersection with another mathematical framework.',
      priority_shock: 'Change a binding resource or physical constraint and derive the highest-value experiment.',
    };
    const instruction = operators[String(req.body?.operator)] ?? operators.priority_shock;
    try {
      const { value, result } = await executeStructured(options, 'mutate', [{
        role: 'system',
        content: `You are a mathematical research critic. ${instruction} Distinguish established facts from conjecture and return the requested JSON object.`,
      }, { role: 'user', content: req.body.idea.trim() }], 'application_research_mutation', schemas.mutate, 4096);
      res.json({
        title: stringValue(value.title, 'title'),
        novelInsight: stringValue(value.novelInsight, 'novelInsight'),
        mathematicalBounds: stringValue(value.mathematicalBounds, 'mathematicalBounds'),
        suggestedActionItems: stringArray(value.suggestedActionItems, 'suggestedActionItems'),
        ...providerMetadata(result),
      });
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  router.post('/self-improve', async (req, res) => {
    if (typeof req.body?.taskTitle !== 'string' || !req.body.taskTitle.trim()) {
      res.status(400).json({ error: 'A non-empty target task is required.' });
      return;
    }
    try {
      const { value, result } = await executeStructured(options, 'skill_draft', [{
        role: 'system',
        content: [
          'Draft only a candidate for the bounded pure-transform-v1 Skill Foundry.',
          'Allowed operations are trim, collapse_whitespace, lowercase, uppercase, and sort_lines.',
          'Never emit JavaScript, shell commands, dependency instructions, or claims of installation.',
          'Supply deterministic input/output cases that the kernel can independently evaluate.',
        ].join('\n'),
      }, { role: 'user', content: req.body.taskTitle.trim() }], 'application_skill_draft', schemas.skillDraft, 3072);
      const proposedOperations = stringArray(value.proposedOperations, 'proposedOperations');
      if (!proposedOperations.every((operation) => ['trim', 'collapse_whitespace', 'lowercase', 'uppercase', 'sort_lines'].includes(operation))) {
        throw new Error('Provider proposed an operation outside the bounded Skill Foundry.');
      }
      res.json({
        deficitIdentified: stringValue(value.deficitIdentified, 'deficitIdentified'),
        synthesizedSkillName: stringValue(value.synthesizedSkillName, 'synthesizedSkillName'),
        synthesizedSkillDescription: stringValue(value.synthesizedSkillDescription, 'synthesizedSkillDescription'),
        proposedOperations,
        deterministicCases: Array.isArray(value.deterministicCases) ? value.deterministicCases : [],
        draftNotes: stringArray(value.draftNotes, 'draftNotes'),
        ...providerMetadata(result),
      });
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  return router;
};
