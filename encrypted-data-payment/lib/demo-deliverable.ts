// A ready-made handover so the full flow can be demonstrated without picking files.
// The figures are illustrative sample data, not a real audit.
const encode = (value: string) => new TextEncoder().encode(value);

const report = `# Checkout performance audit: handover

Sample content for the Fiber Testnet demo. Figures are illustrative.

## Summary
Largest Contentful Paint on the checkout page is 4.1 s on a mid-range phone over 4G.
Three changes bring it under 2.5 s.

## Fixes, in priority order
1. Serve the hero image as AVIF or WebP at its displayed size (saves about 620 KB).
2. Load the chat widget on first interaction instead of page load (removes about 340 ms of blocking script).
3. Preload the checkout font and drop the unused italic weights.

## How to verify
Run Lighthouse in mobile mode three times and compare the median LCP before and after.
`;

const findings = `id,severity,area,finding,fix
1,high,images,Hero image is 1.4 MB and scaled down in CSS,Export at displayed size as AVIF/WebP
2,high,scripts,Chat widget blocks the main thread on load,Load on first interaction
3,medium,fonts,Four font files requested; two never used,Preload one and remove the rest
4,low,caching,Static assets served with a 1 hour cache,Set a one year immutable cache
`;

export function demoDeliverable() {
  return {
    title: 'Checkout performance audit',
    seller: '',
    description: 'Full audit of the checkout page with a prioritised fix list and a findings sheet you can import into your tracker.',
    sample: 'Checkout LCP is 4.1 s on a mid-range phone. Three fixes bring it under 2.5 s. The report ranks them by impact and explains how to verify each one.',
    note: 'Thanks for the work. Start with fix 1; it is the biggest win for the least effort.',
    files: [
      { name: 'audit-report.md', type: 'text/markdown', bytes: encode(report) },
      { name: 'findings.csv', type: 'text/csv', bytes: encode(findings) },
    ],
  };
}
