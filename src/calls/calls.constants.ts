export const CALLS_QUEUE = 'calls';

export const JOB_PLACE_CALL = 'place-call';
export const JOB_DELIVER_RECORDING = 'deliver-recording';
export const JOB_RECONCILE_CALL = 'reconcile-call';

export interface CallJobData {
  callId: string;
}

/** If no webhook arrives within this time, poll the provider for the result. */
export const RECONCILE_DELAY_MS = 15 * 60 * 1000;
