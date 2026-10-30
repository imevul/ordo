# Contributing to Ordo

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for something

Open a [GitHub issue](https://github.com/imevul/ordo/issues). For a bug, say what you did, what you expected and what
happened instead, and which version or commit you run. Don't post the details of a security problem in a public
issue: open one that asks for a private channel, and we'll take it from there.

## Making a change

You need Node 24+, pnpm 12 and Docker.

```bash
make dev          # Postgres in Docker, API on :3001, web on :5173 with hot reload
pnpm db:seed      # optional demo data: demo@ordo.test / ordo-demo-password
```

[docs/development.md](docs/development.md) explains the layout and the conventions (tenant scoping, mutations,
migrations, text and design); [AGENTS.md](AGENTS.md) is the condensed version. A few things that save a review round:

- Keep a pull request to one change, and say in its description what it does and how you checked it.
- Add tests: API changes get an integration test in `apps/api/test/`, shared logic a unit test next to it.
- For UI changes, check them in a browser at desktop width and at 375px, and add a screenshot to the pull request.
- Every visible string goes through `t()`, in English at least.
- Before pushing, run:

  ```bash
  pnpm typecheck && pnpm test && pnpm lint
  ```

## Terms

By contributing, you license your contribution under the project's license ([FSL-1.1-ALv2](LICENSE.md)) and agree
that the maintainer may relicense it in future versions.
