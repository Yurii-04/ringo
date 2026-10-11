import { CallOutcome, CallResult, TranscriptTurn, VoiceEvent } from '../voice-provider.interface';
import { detectOptOut } from '../opt-out';

/* Loose shapes of ElevenLabs payloads; only the fields we use. */
interface ElTranscriptItem {
  role?: string;
  message?: string | null;
  time_in_call_secs?: number;
  tool_calls?: Array<{ tool_name?: string; name?: string }> | null;
}

interface ElConversation {
  conversation_id?: string;
  status?: string;
  transcript?: ElTranscriptItem[];
  metadata?: {
    call_duration_secs?: number;
    termination_reason?: string | null;
    error?: unknown;
  };
  analysis?: {
    transcript_summary?: string | null;
    data_collection_results?: Record<string, { value?: unknown } | undefined>;
  } | null;
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, unknown>;
  } | null;
}

const NO_ANSWER_FAILURES = new Set(['busy', 'no-answer', 'no_answer', 'canceled']);
const MACHINE_VERDICTS = /^(machine|fax)/i;

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function callIdFrom(data: ElConversation): string | undefined {
  return asString(data.conversation_initiation_client_data?.dynamic_variables?.call_id);
}

function transcriptOf(data: ElConversation): TranscriptTurn[] {
  return (data.transcript ?? [])
    .filter((t) => (t.role === 'agent' || t.role === 'user') && typeof t.message === 'string' && t.message.trim())
    .map((t) => ({ role: t.role as 'agent' | 'user', text: t.message!.trim(), timeSec: t.time_in_call_secs ?? 0 }));
}

function usedVoicemailTool(data: ElConversation): boolean {
  return (data.transcript ?? []).some((t) =>
    (t.tool_calls ?? []).some((c) => /voicemail/i.test(c.tool_name ?? c.name ?? '')),
  );
}

/** Maps a finished ElevenLabs conversation (webhook `data` or GET /conversations/{id}) to CallResult. */
export function parseConversation(data: ElConversation): CallResult {
  const transcript = transcriptOf(data);
  const userTurns = transcript.filter((t) => t.role === 'user').map((t) => t.text);
  const terminationReason = data.metadata?.termination_reason ?? undefined;
  const dc = data.analysis?.data_collection_results ?? {};

  let outcome: CallOutcome;
  if (/voicemail|answering.?machine/i.test(terminationReason ?? '') || usedVoicemailTool(data) || dc.voicemail?.value === true) {
    outcome = 'voicemail';
  } else if (data.status === 'failed' && userTurns.length === 0) {
    outcome = 'failed';
  } else if (userTurns.length === 0) {
    outcome = 'no_answer';
  } else {
    outcome = 'completed';
  }

  return {
    callId: callIdFrom(data),
    providerCallId: data.conversation_id ?? '',
    outcome,
    durationSec: Math.round(data.metadata?.call_duration_secs ?? 0),
    transcript,
    summary: asString(data.analysis?.transcript_summary),
    optOut: outcome === 'completed' && (dc.opt_out?.value === true || detectOptOut(userTurns)),
    terminationReason,
  };
}

/** Normalizes a verified ElevenLabs webhook payload. */
export function parseElevenLabsWebhook(payload: unknown): VoiceEvent {
  const body = payload as { type?: string; data?: Record<string, unknown> };
  const data = (body?.data ?? {}) as Record<string, unknown>;
  const providerCallId = asString(data.conversation_id);

  switch (body?.type) {
    case 'post_call_transcription': {
      if (!providerCallId) return { kind: 'ignored', reason: 'missing conversation_id' };
      return { kind: 'result', result: parseConversation(data as ElConversation) };
    }
    case 'call_initiation_failure': {
      if (!providerCallId) return { kind: 'ignored', reason: 'missing conversation_id' };
      const failure = String(data.failure_reason ?? 'unknown').toLowerCase();
      return {
        kind: 'result',
        result: {
          callId: callIdFrom(data as ElConversation),
          providerCallId,
          outcome: NO_ANSWER_FAILURES.has(failure) ? 'no_answer' : 'failed',
          durationSec: 0,
          transcript: [],
          optOut: false,
          terminationReason: `initiation_failure:${failure}`,
        },
      };
    }
    case 'answering_machine_detection': {
      if (!providerCallId) return { kind: 'ignored', reason: 'missing conversation_id' };
      // Twilio AnsweredBy values: human | machine_start | machine_end_beep | machine_end_silence |
      // machine_end_other | fax | unknown. The field name is read defensively.
      const verdict =
        asString(data.answered_by) ??
        asString(data.AnsweredBy) ??
        asString(data.result) ??
        asString((data.metadata as Record<string, unknown> | undefined)?.answered_by) ??
        'unknown';
      return {
        kind: 'machine_detection',
        providerCallId,
        callId: callIdFrom(data as ElConversation),
        isMachine: MACHINE_VERDICTS.test(verdict),
      };
    }
    default:
      // post_call_audio and future types: we fetch audio via API instead.
      return { kind: 'ignored', reason: `unsupported type ${body?.type}` };
  }
}
