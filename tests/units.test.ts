import {
  resolveInitialUnits,
  toggleUnitSystem,
  formatViewerSpeed,
  formatViewerDistance,
  PREFERRED_UNITS_STORAGE_KEY,
} from '../lib/track/units';

describe('Unit System & Preference Utilities (CIE-030)', () => {
  describe('resolveInitialUnits', () => {
    it('prioritizes explicit URL query parameters', () => {
      expect(resolveInitialUnits('imperial', 'metric', ['fr-FR'])).toBe('imperial');
      expect(resolveInitialUnits('mi', 'metric', ['fr-FR'])).toBe('imperial');
      expect(resolveInitialUnits('mph', 'metric', ['fr-FR'])).toBe('imperial');
      expect(resolveInitialUnits('metric', 'imperial', ['en-US'])).toBe('metric');
      expect(resolveInitialUnits('km', 'imperial', ['en-US'])).toBe('metric');
      expect(resolveInitialUnits('kmh', 'imperial', ['en-US'])).toBe('metric');
    });

    it('falls back to stored preference when query parameter is omitted or invalid', () => {
      expect(resolveInitialUnits(null, 'imperial', ['fr-FR'])).toBe('imperial');
      expect(resolveInitialUnits('', 'metric', ['en-US'])).toBe('metric');
      expect(resolveInitialUnits('invalid', 'imperial', ['fr-FR'])).toBe('imperial');
    });

    it('falls back to browser locale detection when query and storage are omitted', () => {
      expect(resolveInitialUnits(null, null, ['en-US'])).toBe('imperial');
      expect(resolveInitialUnits(null, null, ['es-US', 'es-ES'])).toBe('imperial');
      expect(resolveInitialUnits(null, null, ['en-LR'])).toBe('imperial');
      expect(resolveInitialUnits(null, null, ['my-MM'])).toBe('imperial');
      expect(resolveInitialUnits(null, null, ['en-GB'])).toBe('metric');
      expect(resolveInitialUnits(null, null, ['de-DE'])).toBe('metric');
      expect(resolveInitialUnits(null, null, ['ja-JP'])).toBe('metric');
      expect(resolveInitialUnits(null, null, [])).toBe('metric');
      expect(resolveInitialUnits(null, null, null)).toBe('metric');
    });
  });

  describe('toggleUnitSystem', () => {
    it('toggles metric to imperial and vice versa', () => {
      expect(toggleUnitSystem('metric')).toBe('imperial');
      expect(toggleUnitSystem('imperial')).toBe('metric');
    });
  });

  describe('formatViewerSpeed', () => {
    it('formats metric speeds accurately', () => {
      expect(formatViewerSpeed(25.4, 'metric')).toBe('25 km/h');
      expect(formatViewerSpeed(25.6, 'metric')).toBe('26 km/h');
      expect(formatViewerSpeed(0, 'metric')).toBe('0 km/h');
      expect(formatViewerSpeed(null, 'metric')).toBe('0 km/h');
      expect(formatViewerSpeed(-5, 'metric')).toBe('0 km/h');
    });

    it('formats imperial speeds accurately', () => {
      // 25 km/h * 0.621371 = 15.534 -> 16 mph
      expect(formatViewerSpeed(25.0, 'imperial')).toBe('16 mph');
      // 50 km/h * 0.621371 = 31.068 -> 31 mph
      expect(formatViewerSpeed(50.0, 'imperial')).toBe('31 mph');
      expect(formatViewerSpeed(0, 'imperial')).toBe('0 mph');
      expect(formatViewerSpeed(undefined, 'imperial')).toBe('0 mph');
    });
  });

  describe('formatViewerDistance', () => {
    it('formats metric distances in km', () => {
      expect(formatViewerDistance(1500, 'metric')).toBe('1.5 km');
      expect(formatViewerDistance(10200, 'metric')).toBe('10.2 km');
      expect(formatViewerDistance(0, 'metric')).toBe('0.0 km');
      expect(formatViewerDistance(null, 'metric')).toBe('0.0 km');
    });

    it('formats imperial distances in mi', () => {
      // 1609.344 m = 1.0 mi
      expect(formatViewerDistance(1609.344, 'imperial')).toBe('1.0 mi');
      // 8046.72 m = 5.0 mi
      expect(formatViewerDistance(8046.72, 'imperial')).toBe('5.0 mi');
      expect(formatViewerDistance(0, 'imperial')).toBe('0.0 mi');
      expect(formatViewerDistance(undefined, 'imperial')).toBe('0.0 mi');
    });
  });

  it('exports correct storage key constant', () => {
    expect(PREFERRED_UNITS_STORAGE_KEY).toBe('trackme_preferred_units');
  });
});
