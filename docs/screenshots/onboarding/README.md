# Onboarding screenshots (synthetic fixtures)

Playwright captures of a throwaway loopback app with a synthetic account. Review
material for the work-context onboarding slice, not browser E2E acceptance and
not a Teamily comparison.

- `onboarding-context.png`: `/onboarding` with the captured industry/role step.
- `onboarding-banner.png`: `/chat` with the non-blocking work-context hint.

- `onboarding-recommendations.png`: `/onboarding` with role-based automation recommendations after saving work context.

The `onboarding-recommendations.png` image is a historical capture of PR #140 before main integration. The integrated flow retains main's step 3 and adds an explicit paused-create control within it; this historical image is not evidence of that new layout or acceptance. Validation for this revision runs in GitHub CI.
