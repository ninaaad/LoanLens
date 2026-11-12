// Mutable behaviour of the mock credit bureau and KYC provider.
// Raising `multiplier` is how the demo (and the seeded incident) simulates a provider slowdown.
export const defaults = () => ({
  bureau: { baseMs: 1800, sigma: 0.35, multiplier: 1, errorRate: 0.003, timeoutRate: 0.002, forceScore: null },
  kyc: { baseMs: 1100, sigma: 0.3, multiplier: 1, errorRate: 0.003, timeoutRate: 0.001, forceVerified: null },
});
export const mockState = defaults();
export const resetMock = () => {
  const d = defaults();
  mockState.bureau = d.bureau;
  mockState.kyc = d.kyc;
};
