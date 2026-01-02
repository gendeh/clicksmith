import { AutoTuneResult, AutoTuneSettings, RecordedEvent } from '../types';

export interface AutoTuneOutput {
  adjustments: number[];
  report: AutoTuneResult;
}

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function scoreCandidate(adjustments: number[], baseEvents: RecordedEvent[]): number {
  const jitter = adjustments.reduce((sum, value) => sum + Math.abs(value), 0);
  const penalty = jitter / Math.max(1, baseEvents.length);
  const expectedSmoothness = Math.max(0, 1 - penalty / 10);
  return expectedSmoothness;
}

export function runAutoTune(
  events: RecordedEvent[],
  settings: AutoTuneSettings
): AutoTuneOutput {
  const maxJitter = settings.maxJitter ?? 20;
  const populationSize = settings.populationSize ?? 6;
  const generations = settings.generations ?? 2;

  let bestAdjustments: number[] = events.map(() => 0);
  let bestFitness = 0;

  for (let gen = 0; gen < generations; gen++) {
    for (let i = 0; i < populationSize; i++) {
      const candidate = events.map(() => Math.round(randomBetween(-maxJitter, maxJitter)));
      const fitness = scoreCandidate(candidate, events);
      if (fitness > bestFitness) {
        bestFitness = fitness;
        bestAdjustments = candidate;
      }
    }
  }

  const report: AutoTuneResult = {
    generation: generations,
    bestFitness,
    avgFitness: bestFitness,
    bestAdjustments,
    improvement: bestFitness,
  };

  return { adjustments: bestAdjustments, report };
}
