import type { PromptInjectionAssessment } from '../capabilities/injection';

export type CoreModelAvailability = 'available' | 'unavailable';

export interface CoreModelStatus {
  status: CoreModelAvailability;
  reason: string;
  modelPath: string;
  fileBytes?: number;
}

/**
 * Minimal JSON-schema subset forwarded to the grammar-constrained sampler.
 * Mirrors the provider JsonSchema shape so prompts stay model-agnostic.
 */
export interface CoreModelJsonSchema {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  readonly properties?: Readonly<Record<string, CoreModelJsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: CoreModelJsonSchema;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface CoreModelGenerateOptions {
  systemInstruction: string;
  prompt: string;
  schema: CoreModelJsonSchema;
  maxTokens: number;
}

/**
 * One in-process inference boundary. The real transport wraps node-llama-cpp;
 * tests substitute a deterministic fake.
 */
export interface CoreModelTransport {
  generateJson(options: CoreModelGenerateOptions): Promise<unknown>;
}

export type CoreModelTransportFactory = (modelPath: string) => Promise<CoreModelTransport>;

export interface CoreModelExtractionInput {
  recentHistory: string;
  currentMemories: string;
  currentBio: string;
}

export interface CoreModelExtractedMemory {
  content: string;
  category: 'personal' | 'technical' | 'work' | 'preferences' | 'general';
  importance: number;
  sourceSnippet: string;
}

export interface CoreModelExtraction {
  newMemories: CoreModelExtractedMemory[];
  deletedMemoryIds: string[];
  updatedBio: string;
}

export interface CoreModelObservationAssessment extends PromptInjectionAssessment {
  /** 'heuristic_only' when the model was unavailable or failed; the regex floor always applies. */
  assessedBy: 'heuristic_only' | 'heuristic_and_core_model';
}

export interface CoreModelChatInput {
  recentHistory: string;
  memories: string;
  bio: string;
}

export interface CoreModelChatResult {
  responseContent: string;
  retrievedMemoryIds: string[];
}
