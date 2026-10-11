import { CallStatus } from '@prisma/client';
import { JOB_DELIVER_RECORDING, JOB_PLACE_CALL, JOB_RECONCILE_CALL } from '../src/calls/calls.constants';
import { CallsProcessor } from '../src/calls/calls.processor';
import { VoiceProviderError } from '../src/voice/voice-provider.interface';
import { mockPrisma, PrismaMock, testConfig } from './helpers';

describe('CallsProcessor', () => {
  let prisma: PrismaMock;
  let voice: { startCall: jest.Mock; fetchResult: jest.Mock; fetchRecording: jest.Mock };
  let queue: { add: jest.Mock };
  let blocklist: { isBlocked: jest.Mock };
  let results: { failBeforeDial: jest.Mock; applyResult: jest.Mock };
  let notifications: { sendAudio: jest.Mock; sendText: jest.Mock };
  let processor: CallsProcessor;

  const call = { id: 'c1', userId: 'u1', toNumber: '+380671234567', status: CallStatus.QUEUED, customerName: 'Оля', scenarioKey: 'pizza', customTopic: null, providerCallId: null };
  const job = (name: string, attemptsMade = 0, attempts = 3) => ({ name, data: { callId: 'c1' }, attemptsMade, opts: { attempts } }) as never;

  beforeEach(() => {
    prisma = mockPrisma();
    voice = { startCall: jest.fn().mockResolvedValue({ providerCallId: 'conv_1' }), fetchResult: jest.fn(), fetchRecording: jest.fn() };
    queue = { add: jest.fn() };
    blocklist = { isBlocked: jest.fn().mockResolvedValue(false) };
    results = { failBeforeDial: jest.fn(), applyResult: jest.fn() };
    notifications = { sendAudio: jest.fn(), sendText: jest.fn() };
    processor = new CallsProcessor(testConfig(), voice, queue as never, prisma as never, blocklist as never, results as never, notifications as never);
    prisma.call.findUnique.mockResolvedValue({ ...call });
    prisma.call.updateMany.mockResolvedValue({ count: 1 });
  });

  it('claims the call, dials with agent variables and schedules reconciliation', async () => {
    await processor.process(job(JOB_PLACE_CALL));
    expect(prisma.call.updateMany).toHaveBeenCalledWith({ where: { id: 'c1', status: CallStatus.QUEUED }, data: { status: CallStatus.DIALING } });
    expect(voice.startCall).toHaveBeenCalledWith(
      expect.objectContaining({ toNumber: '+380671234567', maxDurationSec: 180, variables: expect.objectContaining({ call_id: 'c1', customer_name: 'Оля' }) }),
    );
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { providerCallId: 'conv_1' } });
    expect(queue.add).toHaveBeenCalledWith(JOB_RECONCILE_CALL, { callId: 'c1' }, expect.anything());
  });

  it('never dials twice: a call already claimed by another attempt is skipped', async () => {
    prisma.call.updateMany.mockResolvedValue({ count: 0 });
    await processor.process(job(JOB_PLACE_CALL));
    expect(voice.startCall).not.toHaveBeenCalled();
  });

  it('does not dial a number that opted out while queued, and refunds', async () => {
    blocklist.isBlocked.mockResolvedValue(true);
    await processor.process(job(JOB_PLACE_CALL));
    expect(voice.startCall).not.toHaveBeenCalled();
    expect(results.failBeforeDial).toHaveBeenCalledWith('c1', 'number blocked before dialing');
  });

  it('re-queues and rethrows retryable provider errors while attempts remain', async () => {
    voice.startCall.mockRejectedValue(new VoiceProviderError('503', true));
    await expect(processor.process(job(JOB_PLACE_CALL, 0, 3))).rejects.toThrow('503');
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { status: CallStatus.QUEUED } });
    expect(results.failBeforeDial).not.toHaveBeenCalled();
  });

  it('fails and refunds on non-retryable errors or the last attempt', async () => {
    voice.startCall.mockRejectedValueOnce(new VoiceProviderError('400 bad number', false));
    await processor.process(job(JOB_PLACE_CALL));
    voice.startCall.mockRejectedValueOnce(new VoiceProviderError('503', true));
    await processor.process(job(JOB_PLACE_CALL, 2, 3));
    expect(results.failBeforeDial).toHaveBeenCalledTimes(2);
  });

  it('delivers the recording once', async () => {
    prisma.call.findUnique.mockResolvedValue({ ...call, providerCallId: 'conv_1', recordingSent: false, user: { telegramId: 42n } });
    voice.fetchRecording.mockResolvedValue(Buffer.from('mp3'));
    await processor.process(job(JOB_DELIVER_RECORDING));
    expect(notifications.sendAudio).toHaveBeenCalledWith(42n, Buffer.from('mp3'), expect.stringMatching(/\.mp3$/), expect.any(String));
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { recordingSent: true } });
  });

  it('retries recording delivery until the audio is ready', async () => {
    prisma.call.findUnique.mockResolvedValue({ ...call, providerCallId: 'conv_1', recordingSent: false, user: { telegramId: 42n } });
    voice.fetchRecording.mockResolvedValue(null);
    await expect(processor.process(job(JOB_DELIVER_RECORDING))).rejects.toThrow();
  });

  it('reconciles a call whose webhook never arrived', async () => {
    prisma.call.findUnique.mockResolvedValue({ ...call, status: CallStatus.DIALING, providerCallId: 'conv_1' });
    voice.fetchResult.mockResolvedValue({ providerCallId: 'conv_1', outcome: 'no_answer', durationSec: 0, transcript: [], optOut: false });
    await processor.process(job(JOB_RECONCILE_CALL));
    expect(results.applyResult).toHaveBeenCalledWith(expect.objectContaining({ callId: 'c1', outcome: 'no_answer' }));
  });

  it('refunds only never-claimed calls when place-call exhausts retries', async () => {
    await processor.onFailed(job(JOB_PLACE_CALL, 3, 3), new Error('db down'));
    expect(results.failBeforeDial).toHaveBeenCalledWith('c1', expect.any(String), [CallStatus.QUEUED]);
  });
});
