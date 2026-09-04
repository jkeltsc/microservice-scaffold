import * as fc from 'fast-check';

// Global fast-check configuration shared by every package's test suite.
// A default of 100 runs per property gives meaningful coverage without making
// the suite prohibitively slow in CI. Individual properties may still override
// this locally by passing `{ numRuns }` to `fc.assert`.
fc.configureGlobal({ numRuns: 100 });
