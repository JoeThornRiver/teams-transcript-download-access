# Contributing

Contributions are welcome through GitHub Issues and pull requests.

## Workflow

1. Open a numeric GitHub issue before making any change, including a small change.
2. Agree on a concrete outcome and scope in the issue.
3. Create an issue-linked branch from the current `main` branch.
4. Keep the implementation focused on the issue's acceptance criteria.
5. Use Conventional Commits.
6. Run the applicable repository checks.
7. Open a focused pull request that links the issue.
8. Address review findings and merge only after CI passes.

Do not use a pull request to introduce unrelated fixes or speculative improvements. Report an unrelated problem in its own issue.

## Verification

Install the locked dependencies and run the local checks:

```sh
npm ci
./scripts/validate-baseline.sh
npm run check
npm test
```

Behavior changes require the smallest relevant automated proof. Never delete, skip, or weaken a valid test to make a change pass.

## Security and privacy

Do not commit or publish credentials, tokens, tenant or subscription identifiers, participant data, meeting or recording titles, recording URLs, production logs, or local review artifacts.

Do not report a vulnerability in a public issue. Follow [SECURITY.md](SECURITY.md).
