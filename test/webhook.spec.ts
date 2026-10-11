import { UnauthorizedException } from '@nestjs/common';
import { CallStatus } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { CallResultService } from '../src/calls/call-result.service';
import { JOB_DELIVER_RECORDING } from '../src/calls/calls.constants';
import { ElevenLabsWebhookController } from '../src/voice/elevenlabs/elevenlabs-webhook.controller';
import { parseElevenLabsWebhook } from '../src/voice/elevenlabs/elevenlabs.parser';
import { verifyElevenLabsSignature } from '../src/voice/elevenlabs/elevenlabs.signature';
import { CallResult } from '../src/voice/voice-provider.interface';
import { mockPrisma, PrismaMock, testConfig } from './helpers';

const SECRET = 'whsec_test';
const CALL_ID = '11111111-2222-4333-8444-555555555555';

const sign = (body: string, t: number, secret = SECRET) =>
  `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

const transcriptionPayload = (over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) => ({
  type: 'post_call_transcription',
  event_timestamp: 1760000000,
  data: {
    agent_id: 'agent_1',
    conversation_id: 'conv_1',
    status: 'done',
    transcript: [
      { role: 'agent', message: 'Алло, добрий день! Я з піцерії.', time_in_call_secs: 0 },
      { role: 'user', message: 'Я нічого не замовляв!', time_in_call_secs: 4 },
      { role: 'agent', message: 'Це був розіграш від Олі!', time_in_call_secs: 60, tool_calls: [{ tool_name: 'end_call' }] },
    ],
    metadata: { call_duration_secs: 64.4, termination_reason: 'end_call tool was called.' },
    analysis: { transcript_summary: 'Друг посміявся.', data_collection_results: { opt_out: { value: false } } },
    conversation_initiation_client_data: { dynamic_variables: { call_id: CALL_ID } },
    ...dataOver,
  },
  ...over,
});

describe('verifyElevenLabsSignature', () => {
  const body = JSON.stringify({ hello: 'світ' });
  const now = 1_760_000_000;

  it('accepts a valid signature', () => {
    expect(verifyElevenLabsSignature(Buffer.from(body), sign(body, now), SECRET, now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyElevenLabsSignature(Buffer.from(body + ' '), sign(body, now), SECRET, now)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(verifyElevenLabsSignature(body, sign(body, now, 'other'), SECRET, now)).toBe(false);
  });

  it('rejects stale timestamps (replay protection)', () => {
    expect(verifyElevenLabsSignature(body, sign(body, now - 31 * 60), SECRET, now)).toBe(false);
  });

  it.each([undefined, '', 'garbage', 't=abc,v0=zz', `t=${now}`])('rejects malformed header %p', (header) => {
    expect(verifyElevenLabsSignature(body, header, SECRET, now)).toBe(false);
  });
});

describe('parseElevenLabsWebhook', () => {
  it('parses an answered call', () => {
    const ev = parseElevenLabsWebhook(transcriptionPayload());
    expect(ev).toEqual({
      kind: 'result',
      result: expect.objectContaining({
        callId: CALL_ID,
        providerCallId: 'conv_1',
        outcome: 'completed',
        durationSec: 64,
        optOut: false,
        summary: 'Друг посміявся.',
      }),
    });
    if (ev.kind === 'result') expect(ev.result.transcript).toHaveLength(3);
  });

  it('detects opt-out from the agent data-collection field', () => {
    const ev = parseElevenLabsWebhook(
      transcriptionPayload({}, { analysis: { data_collection_results: { opt_out: { value: true } } } }),
    );
    expect(ev.kind === 'result' && ev.result.optOut).toBe(true);
  });

  it('detects opt-out from the callee phrase as a fallback', () => {
    const ev = parseElevenLabsWebhook(
      transcriptionPayload({}, {
        transcript: [
          { role: 'agent', message: 'Алло!', time_in_call_secs: 0 },
          { role: 'user', message: 'Більше не дзвоніть мені, будь ласка', time_in_call_secs: 3 },
        ],
        analysis: null,
      }),
    );
    expect(ev.kind === 'result' && ev.result.optOut).toBe(true);
  });

  it('treats a call where nobody spoke as no answer', () => {
    const ev = parseElevenLabsWebhook(
      transcriptionPayload({}, { transcript: [{ role: 'agent', message: 'Алло?', time_in_call_secs: 0 }, { role: 'user', message: null }] }),
    );
    expect(ev.kind === 'result' && ev.result.outcome).toBe('no_answer');
  });

  it('detects voicemail by termination reason and by the voicemail tool', () => {
    const byReason = parseElevenLabsWebhook(
      transcriptionPayload({}, { metadata: { call_duration_secs: 9, termination_reason: 'Voicemail detected' } }),
    );
    expect(byReason.kind === 'result' && byReason.result.outcome).toBe('voicemail');

    const byTool = parseElevenLabsWebhook(
      transcriptionPayload({}, {
        transcript: [
          { role: 'user', message: 'Абонент не може відповісти, залиште повідомлення після сигналу', time_in_call_secs: 1 },
          { role: 'agent', message: null, tool_calls: [{ tool_name: 'voicemail_detection' }] },
        ],
      }),
    );
    expect(byTool.kind === 'result' && byTool.result.outcome).toBe('voicemail');
    expect(byTool.kind === 'result' && byTool.result.optOut).toBe(false);
  });

  it.each([
    ['busy', 'no_answer'],
    ['no-answer', 'no_answer'],
    ['unknown', 'failed'],
  ])('maps call_initiation_failure %s -> %s', (reason, outcome) => {
    const ev = parseElevenLabsWebhook({
      type: 'call_initiation_failure',
      data: { agent_id: 'a', conversation_id: 'conv_2', failure_reason: reason, metadata: { type: 'twilio', body: {} } },
    });
    expect(ev).toEqual({ kind: 'result', result: expect.objectContaining({ providerCallId: 'conv_2', outcome }) });
  });

  it.each([
    ['machine_start', true],
    ['machine_end_beep', true],
    ['fax', true],
    ['human', false],
    ['unknown', false],
  ])('parses AMD verdict %s', (answeredBy, isMachine) => {
    expect(
      parseElevenLabsWebhook({ type: 'answering_machine_detection', data: { conversation_id: 'conv_1', answered_by: answeredBy } }),
    ).toEqual({ kind: 'machine_detection', providerCallId: 'conv_1', callId: undefined, isMachine });
  });

  it('ignores audio and unknown events', () => {
    expect(parseElevenLabsWebhook({ type: 'post_call_audio', data: { conversation_id: 'c', full_audio: 'AAA' } }).kind).toBe('ignored');
    expect(parseElevenLabsWebhook({}).kind).toBe('ignored');
  });
});

describe('CallResultService', () => {
  let prisma: PrismaMock;
  let billing: { refundCall: jest.Mock };
  let blocklist: { blockOptOut: jest.Mock };
  let notifications: { sendText: jest.Mock; sendDocument: jest.Mock };
  let queue: { add: jest.Mock };
  let service: CallResultService;

  const baseCall = {
    id: CALL_ID,
    userId: 'u1',
    toNumber: '+380671234567',
    price: 4900,
    status: CallStatus.DIALING,
    providerCallId: 'conv_1',
    machineDetected: false,
    refunded: false,
    optOut: false,
    durationSec: null,
    summary: null,
  };

  const result = (over: Partial<CallResult> = {}): CallResult => ({
    callId: CALL_ID,
    providerCallId: 'conv_1',
    outcome: 'completed',
    durationSec: 60,
    transcript: [
      { role: 'agent', text: 'Алло', timeSec: 0 },
      { role: 'user', text: 'Так?', timeSec: 2 },
    ],
    optOut: false,
    ...over,
  });

  beforeEach(() => {
    prisma = mockPrisma();
    billing = { refundCall: jest.fn().mockResolvedValue(true) };
    blocklist = { blockOptOut: jest.fn() };
    notifications = { sendText: jest.fn(), sendDocument: jest.fn() };
    queue = { add: jest.fn() };
    service = new CallResultService(prisma as never, billing as never, blocklist as never, notifications as never, queue as never);
    prisma.call.findUnique.mockResolvedValue({ ...baseCall });
    prisma.call.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 'u1', telegramId: 42n });
  });

  it('completed call: no refund, sends report + transcript, schedules recording', async () => {
    await service.applyResult(result());
    expect(prisma.call.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, status: { in: [CallStatus.QUEUED, CallStatus.DIALING] } },
      data: expect.objectContaining({ status: CallStatus.COMPLETED, durationSec: 60, optOut: false }),
    });
    expect(billing.refundCall).not.toHaveBeenCalled();
    expect(notifications.sendText).toHaveBeenCalledWith(42n, expect.stringContaining('Дзвінок відбувся'));
    expect(notifications.sendText).toHaveBeenCalledWith(42n, expect.stringContaining('Транскрипт'));
    expect(queue.add).toHaveBeenCalledWith(JOB_DELIVER_RECORDING, { callId: CALL_ID }, expect.objectContaining({ jobId: `rec-${CALL_ID}` }));
  });

  it.each([
    ['no_answer', CallStatus.NO_ANSWER],
    ['voicemail', CallStatus.VOICEMAIL],
    ['failed', CallStatus.FAILED],
  ] as const)('%s: refunds and does not schedule a recording', async (outcome, status) => {
    await service.applyResult(result({ outcome, transcript: [] }));
    expect(prisma.call.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status }) }));
    expect(billing.refundCall).toHaveBeenCalledWith(CALL_ID, `outcome=${outcome}`);
    expect(notifications.sendText).toHaveBeenCalledWith(42n, expect.stringContaining('повернуто'));
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('opt-out: blocks the number permanently and tells the customer', async () => {
    await service.applyResult(result({ optOut: true }));
    expect(blocklist.blockOptOut).toHaveBeenCalledWith('+380671234567', expect.any(String));
    expect(notifications.sendText).toHaveBeenCalledWith(42n, expect.stringContaining('блок-лист'));
  });

  it('ignores duplicate deliveries of the same webhook', async () => {
    prisma.call.updateMany.mockResolvedValue({ count: 0 });
    await service.applyResult(result({ outcome: 'no_answer' }));
    expect(billing.refundCall).not.toHaveBeenCalled();
    expect(notifications.sendText).not.toHaveBeenCalled();
  });

  it('falls back to providerCallId when call_id is missing', async () => {
    prisma.call.findUnique.mockImplementation(async ({ where }) => (where.providerCallId === 'conv_1' ? { ...baseCall } : null));
    await service.applyResult(result({ callId: undefined }));
    expect(prisma.call.findUnique).toHaveBeenCalledWith({ where: { providerCallId: 'conv_1' } });
    expect(prisma.call.updateMany).toHaveBeenCalled();
  });

  it('ignores results for unknown calls', async () => {
    prisma.call.findUnique.mockResolvedValue(null);
    await service.applyResult(result());
    expect(prisma.call.updateMany).not.toHaveBeenCalled();
  });

  it('AMD verdict "machine" turns an answered call into voicemail and refunds', async () => {
    prisma.call.findUnique.mockResolvedValue({ ...baseCall, machineDetected: true });
    await service.applyResult(result());
    expect(prisma.call.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: CallStatus.VOICEMAIL }) }),
    );
    expect(billing.refundCall).toHaveBeenCalled();
  });

  it('late AMD verdict corrects an already completed call and refunds', async () => {
    prisma.call.findUnique.mockResolvedValue({ ...baseCall, status: CallStatus.COMPLETED });
    await service.handleEvent({ kind: 'machine_detection', providerCallId: 'conv_1', isMachine: true });
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: CALL_ID }, data: { machineDetected: true } });
    expect(prisma.call.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, status: CallStatus.COMPLETED },
      data: { status: CallStatus.VOICEMAIL, optOut: false },
    });
    expect(billing.refundCall).toHaveBeenCalled();
  });

  it('AMD verdict "human" changes nothing', async () => {
    await service.handleEvent({ kind: 'machine_detection', providerCallId: 'conv_1', isMachine: false });
    expect(prisma.call.update).not.toHaveBeenCalled();
  });

  it('failBeforeDial refunds only calls the provider never accepted', async () => {
    prisma.call.findUniqueOrThrow.mockResolvedValue({ ...baseCall, status: CallStatus.FAILED, providerCallId: null });
    await service.failBeforeDial(CALL_ID, 'HTTP 400');
    expect(prisma.call.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ providerCallId: null }) }),
    );
    expect(billing.refundCall).toHaveBeenCalled();
  });
});

describe('ElevenLabsWebhookController', () => {
  const callResults = { handleEvent: jest.fn() };
  const controller = new ElevenLabsWebhookController(testConfig(), callResults as never);
  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => callResults.handleEvent.mockReset());

  it('rejects requests with an invalid signature', async () => {
    const body = JSON.stringify(transcriptionPayload());
    await expect(controller.handle({ rawBody: Buffer.from(body) } as never, sign(body, now(), 'wrong'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(callResults.handleEvent).not.toHaveBeenCalled();
  });

  it('passes a verified, parsed event to the result service', async () => {
    const body = JSON.stringify(transcriptionPayload());
    await expect(controller.handle({ rawBody: Buffer.from(body) } as never, sign(body, now()))).resolves.toEqual({ ok: true });
    expect(callResults.handleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'result', result: expect.objectContaining({ callId: CALL_ID, outcome: 'completed' }) }),
    );
  });

  it('acknowledges ignored event types without processing', async () => {
    const body = JSON.stringify({ type: 'post_call_audio', data: { conversation_id: 'c', full_audio: 'AAAA' } });
    await controller.handle({ rawBody: Buffer.from(body) } as never, sign(body, now()));
    expect(callResults.handleEvent).not.toHaveBeenCalled();
  });
});
