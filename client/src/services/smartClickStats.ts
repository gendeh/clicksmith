import { PlaybackStatus } from '../types';

type SmartClickStats = Pick<
  PlaybackStatus,
  | 'successfulMatches'
  | 'failedMatches'
  | 'retries'
  | 'lastError'
  | 'smartClickLastSource'
  | 'smartClickLastConfidence'
  | 'smartClickLastDHashDistance'
  | 'smartClickLastScale'
  | 'smartClickAnchorDx'
  | 'smartClickAnchorDy'
>;

function finiteText(value: number | undefined, digits?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return digits === undefined ? String(value) : value.toFixed(digits);
}

export function formatSmartClickStatsLine(status: SmartClickStats | null | undefined): string {
  const matched = status?.successfulMatches ?? 0;
  const failed = status?.failedMatches ?? 0;
  const retries = status?.retries ?? 0;
  const source = status?.smartClickLastSource?.trim() || 'n/a';
  const confidence = finiteText(status?.smartClickLastConfidence, 2);
  const dhash = finiteText(status?.smartClickLastDHashDistance);
  const scale = finiteText(status?.smartClickLastScale, 2);
  const dx = status?.smartClickAnchorDx;
  const dy = status?.smartClickAnchorDy;
  const anchor =
    typeof dx === 'number' &&
    Number.isFinite(dx) &&
    typeof dy === 'number' &&
    Number.isFinite(dy)
      ? `(${dx}, ${dy})`
      : 'n/a';
  const last = status?.lastError ? `, last: ${status.lastError}` : '';
  return `SmartClick stats: ${matched} matched, ${failed} fallback, ${retries} retries, source ${source}, confidence ${confidence}, dHash ${dhash}, anchor ${anchor}, scale ${scale}${last}.`;
}
