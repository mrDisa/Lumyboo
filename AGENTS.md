# Lumyboo repository instructions

- Never commit, stage with `-f`, or publish `Lumyboo-Development-Plan.md`. It is a local working document, not a repository artifact.
- Local product decisions, status notes and chronological QA logs under the ignored paths in `.gitignore` also stay local. README, architecture and reproducible test instructions may be tracked.
- Preserve the approved Blanc/Noir design and the compact phone frame on desktop. The user explicitly approved this presentation for the desktop web app and a future interactive demo linked from a landing page. Do not expand the application into a dashboard without a new request.
- Follow the local development plan when present. Minutes are the approved daily-goal unit. XP, freeze and Fast Track rules still need agreement before implementation.
- Keep internal implementation and rollout notes out of the product UI. Do not claim unverified offline behavior or real account synchronization.

- After completing each development task, create a separate commit and push it to `https://github.com/mrDisa/Lumyboo` (private repository). Keep commits scoped to the task and run its relevant checks before pushing. Never include the ignored plan or internal work logs.
