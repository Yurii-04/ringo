/**
 * Provider-agnostic voice-agent port. The ElevenLabs+Twilio adapter is the
 * only implementation today; a SIP-trunk or another vendor can be plugged in
 * by implementing this interface and its webhook controller.
 */
export const VOICE_PROVIDER = Symbol('VOICE_PROVIDER');

/** Values the agent's system prompt references as {{variables}}. */
export interface AgentVariables {
  call_id: string;
  customer_name: string;
  scenario_title: string;
  scenario: string;
}

export interface StartCallParams {
  callId: string;
  /** E.164, e.g. +380671234567 */
  toNumber: string;
  variables: AgentVariables;
  maxDurationSec: number;
}

export interface StartCallResult {
  providerCallId: string;
}

export type CallOutcome = 'completed' | 'no_answer' | 'voicemail' | 'failed';

export interface TranscriptTurn {
  role: 'agent' | 'user';
  text: string;
  timeSec: number;
}

/** Normalized final result of a call. */
export interface CallResult {
  /** Our Call.id when the provider echoes it back (dynamic variables). */
  callId?: string;
  providerCallId: string;
  outcome: CallOutcome;
  durationSec: number;
  transcript: TranscriptTurn[];
  summary?: string;
  /** The callee asked not to be called again. */
  optOut: boolean;
  terminationReason?: string;
}

/** Normalized async event coming from the provider's webhooks. */
export type VoiceEvent =
  | { kind: 'result'; result: CallResult }
  | { kind: 'machine_detection'; providerCallId: string; callId?: string; isMachine: boolean }
  | { kind: 'ignored'; reason: string };

export class VoiceProviderError extends Error {
  constructor(
    message: string,
    /** True when it is safe to retry: the provider surely did not place the call. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VoiceProviderError';
  }
}

export interface VoiceProvider {
  startCall(params: StartCallParams): Promise<StartCallResult>;
  /** Final result if the call is over, null while it is still in progress. */
  fetchResult(providerCallId: string): Promise<CallResult | null>;
  /** Call recording (mp3) or null if not available (yet). */
  fetchRecording(providerCallId: string): Promise<Buffer | null>;
}
