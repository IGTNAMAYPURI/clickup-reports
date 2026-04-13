import * as fc from 'fast-check';

describe('Property Test Setup', () => {
  it('should have fast-check configured correctly', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        expect(a + b).toBe(b + a);
      }),
      { numRuns: 100 },
    );
  });
});
