import type { MonitoredWorkRating } from '@bookorbit/types';

import type { MergedWork, ObservationRating } from './observation.types';

export function toObservationRating(average: unknown, count: unknown): ObservationRating | null {
  const parsedAverage = typeof average === 'string' ? Number.parseFloat(average) : typeof average === 'number' ? average : Number.NaN;
  if (!Number.isFinite(parsedAverage) || parsedAverage <= 0 || parsedAverage > 5) return null;
  const parsedCount = typeof count === 'string' ? Number.parseInt(count.replace(/,/g, ''), 10) : typeof count === 'number' ? count : Number.NaN;
  return { average: parsedAverage, count: Number.isFinite(parsedCount) && parsedCount > 0 ? Math.round(parsedCount) : null };
}

export function ratingsField(work: MergedWork): { ratings?: MonitoredWorkRating[] } {
  const ratings = Object.entries(work.ratings ?? {}).flatMap(([source, rating]) =>
    rating ? [{ source: source as MonitoredWorkRating['source'], average: rating.average, count: rating.count }] : [],
  );
  return ratings.length > 0 ? { ratings } : {};
}
