import type { MonitoredFetchTrigger } from './monitored-fetch-job.service';

/**
 * What MonitoredService needs from the fetch coordinator. Injected by token so MonitoredService never
 * imports the coordinator class: the coordinator depends on MonitoredService, and a class-typed
 * constructor parameter on both sides is an import cycle that breaks at decoration time.
 */
export const MONITORED_FETCH_REQUESTS = Symbol('MONITORED_FETCH_REQUESTS');

export interface MonitoredFetchRequests {
  request(monitorId: string, trigger: MonitoredFetchTrigger): Promise<boolean>;
  enqueueInserted(monitorId: string): void;
  cancel(monitorId: string): void;
  clearRetry(monitorId: string): void;
}
