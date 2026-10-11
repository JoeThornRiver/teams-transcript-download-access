# Repository Instructions

Issues are tracked exclusively in GitHub.

## Workflow

- Every change, including a small change, requires a numeric GitHub issue.
- Create an issue-linked branch and never work directly on `main`.
- Keep branches, pull requests, checks, reviews, and merges on GitHub.
- Use Conventional Commits.
- Run the repository's applicable checks before review and never merge on red.
- Never commit or push without explicit operator authorization.

## Validation

Run all repository-owned checks with Node.js 20 or newer:

```sh
./scripts/validate-baseline.sh
npm run check
npm test
```
