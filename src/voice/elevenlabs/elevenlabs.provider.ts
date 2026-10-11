import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/config';
import {
  CallResult,
  StartCallParams,
  StartCallResult,
  VoiceProvider,
  VoiceProviderError,
} from '../voice-provider.interface';
import { parseConversation } from './elevenlabs.parser';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_NET_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * ElevenLabs ElevenAgents over a Twilio number imported into ElevenLabs.
 * Docs: POST /v1/convai/twilio/outbound-call, GET /v1/convai/conversations/{id}[/audio].
 */
@Injectable()
export class ElevenLabsVoiceProvider implements VoiceProvider {
  private readonly logger = new Logger(ElevenLabsVoiceProvider.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async startCall(params: StartCallParams): Promise<StartCallResult> {
    const body = {
      agent_id: this.config.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: this.config.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: params.toNumber,
      conversation_initiation_client_data: {
        dynamic_variables: { ...params.variables },
      },
      telephony_call_config: {
        ringing_timeout_secs: 30,
        // Twilio answering-machine detection; verdict arrives via the
        // `answering_machine_detection` webhook event.
        twilio_machine_detection: { mode: 'enable' },
      },
    };

    const res = await this.request('/v1/convai/twilio/outbound-call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new VoiceProviderError(
        `ElevenLabs outbound-call failed: HTTP ${res.status} ${text.slice(0, 500)}`,
        RETRYABLE_STATUS.has(res.status),
      );
    }
    const json = JSON.parse(text) as { success?: boolean; message?: string; conversation_id?: string | null };
    if (!json.success || !json.conversation_id) {
      throw new VoiceProviderError(`ElevenLabs refused the call: ${json.message ?? text.slice(0, 500)}`, false);
    }
    return { providerCallId: json.conversation_id };
  }

  async fetchResult(providerCallId: string): Promise<CallResult | null> {
    const res = await this.request(`/v1/convai/conversations/${encodeURIComponent(providerCallId)}`);
    if (!res.ok) throw new VoiceProviderError(`GET conversation failed: HTTP ${res.status}`, true);
    const data = (await res.json()) as { status?: string };
    if (data.status !== 'done' && data.status !== 'failed') return null;
    return parseConversation(data);
  }

  async fetchRecording(providerCallId: string): Promise<Buffer | null> {
    const res = await this.request(`/v1/convai/conversations/${encodeURIComponent(providerCallId)}/audio`);
    if (res.status === 404) return null;
    if (!res.ok) throw new VoiceProviderError(`GET audio failed: HTTP ${res.status}`, true);
    return Buffer.from(await res.arrayBuffer());
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.config.ELEVENLABS_BASE_URL}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), 'xi-api-key': this.config.ELEVENLABS_API_KEY },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code ?? '';
      this.logger.warn(`ElevenLabs request ${path} failed: ${(err as Error).message} ${code}`);
      // Connection never established -> safe to retry; timeouts are ambiguous -> not retryable.
      throw new VoiceProviderError(`ElevenLabs network error: ${(err as Error).message}`, RETRYABLE_NET_ERRORS.has(code));
    }
  }
}
