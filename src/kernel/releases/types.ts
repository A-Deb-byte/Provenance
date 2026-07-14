import type { ReleaseProposal } from '../types';

export interface StagedReleaseFile {
  path: string;
  contentBase64: string;
  contentHash: string;
}

export interface StagedReleasePackage {
  schemaVersion: 1;
  targetVersion: string;
  entrypoint: string;
  files: StagedReleaseFile[];
}

export interface ReleaseArtifact {
  content: string;
  contentHash: string;
}

export type ReleaseArtifactResolver = (artifactId: string) => Promise<ReleaseArtifact | undefined>;
export type EvaluationReferenceVerifier = (eventId: string) => Promise<boolean>;

export interface ActiveReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  artifactId: string;
  targetVersion: string;
  contentHash: string;
  releaseDirectory: string;
  entrypoint: string;
  activatedAt: string;
  previousReleaseId?: string;
}

export interface ReleaseProcessCandidate {
  manifest: ActiveReleaseManifest;
  releaseDir: string;
}

/** Opaque handle for a live candidate that has passed the readiness probe. */
export interface PreparedReleaseProcess {
  readonly id: string;
  readonly releaseId: string;
}

export interface ReleaseProcessStatus {
  activeReleaseId?: string;
  activePid?: number;
  pendingReleaseIds: string[];
}

/**
 * Trusted process boundary for signed Node releases. `commit` must not reject
 * after it has stopped the previous active child.
 */
export interface ReleaseProcessSupervisor {
  prepare(candidate: ReleaseProcessCandidate): Promise<PreparedReleaseProcess>;
  commit(prepared: PreparedReleaseProcess): Promise<void>;
  abort(prepared: PreparedReleaseProcess): Promise<void>;
  getStatus(): ReleaseProcessStatus;
  shutdown(): Promise<void>;
}

export interface ReleaseHealthCheckInput {
  proposal: ReleaseProposal;
  manifest: ActiveReleaseManifest;
  releaseDir: string;
}

export interface ReleaseHealthCheckResult {
  ok: boolean;
  reason: string;
}

export type ReleaseHealthCheck = (
  input: ReleaseHealthCheckInput,
) => Promise<ReleaseHealthCheckResult>;

export type StagedActivationReasonCode =
  | 'activated'
  | 'proposal_state_invalid'
  | 'signature_missing'
  | 'signature_invalid'
  | 'evaluation_missing'
  | 'evaluation_unverified'
  | 'artifact_missing'
  | 'artifact_hash_mismatch'
  | 'package_invalid'
  | 'release_already_installed'
  | 'install_failed'
  | 'active_manifest_missing'
  | 'active_manifest_invalid'
  | 'active_manifest_mismatch'
  | 'installed_release_invalid'
  | 'process_restore_failed'
  | 'health_check_failed'
  | 'rollback_failed';

export interface StagedReleaseActivationResult {
  status: 'activated' | 'blocked' | 'rolled_back' | 'rollback_failed';
  reasonCode: StagedActivationReasonCode;
  reason: string;
  manifest?: ActiveReleaseManifest;
  previousManifest?: ActiveReleaseManifest;
}

export interface ReleaseLifecycleOptions {
  releasesDir: string;
  publicKey: string;
  resolveArtifact: ReleaseArtifactResolver;
  verifyEvaluationReference: EvaluationReferenceVerifier;
  healthCheck: ReleaseHealthCheck;
  supervisor: ReleaseProcessSupervisor;
  now?: () => string;
}
