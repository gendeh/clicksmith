import { formatSmartClickStatsLine } from '../src/services/smartClickStats';

describe('formatSmartClickStatsLine', () => {
  test('exposes source, confidence, dHash, anchor, and scale when a match is accepted', () => {
    expect(
      formatSmartClickStatsLine({
        successfulMatches: 2,
        failedMatches: 1,
        retries: 0,
        smartClickLastSource: 'window',
        smartClickLastConfidence: 1,
        smartClickLastDHashDistance: 0,
        smartClickAnchorDx: 0,
        smartClickAnchorDy: 0,
        smartClickLastScale: 1.4,
      })
    ).toBe(
      'SmartClick stats: 2 matched, 1 fallback, 0 retries, source window, confidence 1.00, dHash 0, anchor (0, 0), scale 1.40.'
    );
  });

  test('keeps the triage fields visible before any match', () => {
    expect(formatSmartClickStatsLine(null)).toBe(
      'SmartClick stats: 0 matched, 0 fallback, 0 retries, source n/a, confidence n/a, dHash n/a, anchor n/a, scale n/a.'
    );
  });

  test('shows a fallback source without inventing a confidence or a half-written anchor', () => {
    expect(
      formatSmartClickStatsLine({
        successfulMatches: 0,
        failedMatches: 1,
        retries: 1,
        smartClickLastSource: 'expected_fallback',
        smartClickAnchorDx: 50,
        lastError: 'image_service_unavailable',
      })
    ).toBe(
      'SmartClick stats: 0 matched, 1 fallback, 1 retries, source expected_fallback, confidence n/a, dHash n/a, anchor n/a, scale n/a, last: image_service_unavailable.'
    );
  });
});
