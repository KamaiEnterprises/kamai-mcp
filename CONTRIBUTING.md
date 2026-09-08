# Contributing

Pull requests are welcome. Open an issue first for anything beyond a small fix
so we can agree on the approach.

- Open your pull request against the default branch.
- `bun run build` and `bun run test` must pass; CI runs both.
- Keep comments to what a reader cannot infer from the code.
- Bump `WIDGET_VERSION` in `src/widgets/index.ts` when a widget's HTML changes in
  a way hosts must not keep cached.

By contributing you agree that your contribution is licensed under the
[Apache-2.0](LICENSE) license.
