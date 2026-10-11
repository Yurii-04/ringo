/**
 * Creates or updates the ElevenLabs agent from the prompt files in /agent.
 *
 *   npm run agent:sync               # create (no ELEVENLABS_AGENT_ID) or update
 *   npm run agent:sync -- --dry-run  # print the payload only
 *
 * Env: ELEVENLABS_API_KEY, optional ELEVENLABS_AGENT_ID, ELEVENLABS_VOICE_ID,
 *      ELEVENLABS_LLM, MAX_CALL_DURATION_SEC, PUBLIC_BASE_URL.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (file: string) => readFileSync(join(root, 'agent', file), 'utf8').trim();

export function buildAgentConfig(env: NodeJS.ProcessEnv = process.env) {
  const maxDuration = Math.min(Number(env.MAX_CALL_DURATION_SEC ?? 180), 180);
  return {
    name: 'Ringo — AI-розіграші (uk)',
    conversation_config: {
      agent: {
        language: 'uk',
        first_message: read('first-message.uk.txt'),
        max_conversation_duration_message:
          'Ой, мій час вичерпано! Це був жартівливий дзвінок-розіграш від {{customer_name}}. Гарного дня!',
        dynamic_variables: {
          dynamic_variable_placeholders: {
            call_id: 'test',
            customer_name: 'Олена',
            scenario_title: 'Тестовий сценарій',
            scenario: 'Ти — кур’єр піцерії, який привіз піцу, якої ніхто не замовляв.',
          },
        },
        prompt: {
          prompt: read('system-prompt.uk.md'),
          llm: env.ELEVENLABS_LLM ?? 'claude-opus-5-5',
          temperature: 0.7,
          built_in_tools: {
            end_call: {},
            // Ends the call (no message) if the LLM hears a voicemail greeting.
            voicemail_detection: {},
          },
        },
      },
      tts: {
        model_id: 'eleven_v4_turbo',
        ...(env.ELEVENLABS_VOICE_ID ? { voice_id: env.ELEVENLABS_VOICE_ID } : {}),
      },
      turn: { turn_eagerness: 'normal', silence_end_call_timeout: 20 },
      conversation: { max_duration_seconds: maxDuration },
    },
    platform_settings: {
      summary_language: 'uk',
      data_collection: {
        opt_out: {
          type: 'boolean',
          description:
            'true, якщо співрозмовник будь-яким чином попросив більше не дзвонити, видалити його номер ' +
            'або внести в чорний список; інакше false.',
        },
        voicemail: {
          type: 'boolean',
          description: 'true, якщо дзвінок потрапив на автовідповідач / голосову пошту, а не до живої людини.',
        },
      },
    },
  };
}

async function main() {
  const config = buildAgentConfig();
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required');
  const base = process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io';
  const agentId = process.env.ELEVENLABS_AGENT_ID;

  const res = await fetch(agentId ? `${base}/v1/convai/agents/${agentId}` : `${base}/v1/convai/agents/create`, {
    method: agentId ? 'PATCH' : 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ElevenLabs API error ${res.status}: ${text}`);
  const json = JSON.parse(text) as { agent_id?: string };

  if (agentId) {
    console.log(`✅ Agent ${agentId} updated`);
  } else {
    console.log(`✅ Agent created: ${json.agent_id}\n   Put it into .env as ELEVENLABS_AGENT_ID=${json.agent_id}`);
  }
  console.log(
    '\nReminder: in ElevenLabs → Agents → Settings → Webhooks, enable post-call webhooks ' +
      '(transcription + call initiation failure + answering machine detection) pointing to ' +
      `${process.env.PUBLIC_BASE_URL ?? '<PUBLIC_BASE_URL>'}/webhooks/elevenlabs`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
