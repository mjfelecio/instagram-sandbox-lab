/**
 * Bounded, in-memory observation history per session. One entry per actual
 * Instagram request. No automatic polling; no disk persistence.
 */

export type ObservationKind =
  | 'account_info'
  | 'media_list'
  | 'media_fetch'
  | 'media_insights'
  | 'token_exchange'
  | 'token_extend';

export interface Observation {
  id: string;
  kind: ObservationKind;
  startedAt: number;
  receivedAt: number;
  endpoint: string;
  requested: {
    fields?: string[];
    metrics?: string[];
    mediaId?: string;
    after?: string | null;
    limit?: number | null;
  };
  httpStatus: number;
  providerError: { code: string; message: string; type?: string } | null;
  transportError?: string;
  metrics: Array<Record<string, unknown>>;
  data: unknown;
  precisionWarnings: string[];
  ok: boolean;
}

export const MAX_OBSERVATIONS_PER_SESSION = 200;

export class ObservationStore {
  private bySession = new Map<string, Observation[]>();
  private counter = 0;

  add(sessionKey: string, entry: Omit<Observation, 'id'>): Observation {
    const list = this.bySession.get(sessionKey) ?? [];
    this.counter += 1;
    const observation: Observation = { id: `obs_${this.counter}`, ...entry };
    list.push(observation);
    if (list.length > MAX_OBSERVATIONS_PER_SESSION) {
      list.splice(0, list.length - MAX_OBSERVATIONS_PER_SESSION);
    }
    this.bySession.set(sessionKey, list);
    return observation;
  }

  list(sessionKey: string): Observation[] {
    return [...(this.bySession.get(sessionKey) ?? [])];
  }

  clear(sessionKey: string): void {
    this.bySession.delete(sessionKey);
  }
}
