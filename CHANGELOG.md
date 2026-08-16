# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Image tags matching each version are published to
`ghcr.io/simongeronimo/homelab-claude-box`.

## [Unreleased]

### Added

- The Claude app's usage bars, at the top of the launcher: the five hour
  session window and the weekly limits, with the percentage used and when each
  resets. The numbers come from the account, so they match what the app shows
  rather than being estimated from anything local.
- `bin/usage`, which prints those numbers as JSON. There is no supported way to
  get them — `claude` has no usage subcommand and nothing on disk records
  utilisation — so it calls the same internal endpoint the CLI uses, with the
  CLI's own OAuth token. **That endpoint is undocumented and may change or
  disappear in any Claude Code release**, in which case the script exits
  non-zero and the launcher hides the panel rather than showing a stale number.
- The token is read only by that script, which sends it to Anthropic and
  nowhere else, never prints it, and never writes back to the credentials file
  that running sessions depend on. `GET /api/usage` forwards only the parsed
  percentages, and caches them for a minute so a page load costs at most one
  round trip.

## [0.1.1] - 2026-08-15

### Fixed

- Tapping Start twice started two sessions. `start-session` returns as soon as
  tmux is up, in well under a second, but Claude needs about ten more to
  register — so the button re-enabled while nothing had visibly changed. It now
  stays disabled and reads "Started" until the list refreshes.
- Resume is hidden for projects that have never been used. There are no
  transcripts to offer, so the button only ever opened an empty list.
- A failed read of `index.html` hung the request instead of returning 500. The
  handler wrote the response header before awaiting the file, so `headersSent`
  was already true and the error handler declined to answer.

## [0.1.0] - 2026-08-15

### Added

- Launcher web app (`app/server.js`, `app/index.html`) on port 8080: lists git
  repositories in `/root/github`, most recently worked on first, and starts a
  Remote Control session for any of them.
- Resume. `GET /api/sessions?project=<name>` lists a project's past sessions,
  labelled with their opening prompt and when they were last used; starting one
  passes its id to `claude --resume`. This is the only way to resume from a
  phone, since `/resume` is terminal-only.
- `start-session` accepts an optional session id, and refuses one with no
  matching transcript — `--resume` treats an unknown value as a search term and
  opens a picker, which in a detached session means a session that looks alive
  in the Claude app and never responds.
- `start-session` marks onboarding complete and the project directory trusted
  before spawning. Both prompts otherwise block a detached session forever.
- Starting projects that aren't on the box yet. `GET /api/github/repos` lists
  your GitHub repositories minus the ones already cloned; `POST /api/clone`
  clones one and starts a session in it, and `POST /api/create` makes a new
  repository (private by default), clones it, and starts a session. Both refuse
  before doing any work if the target directory exists, so a failure never
  leaves a half-made project.
- Stopping sessions. `GET /api/running` lists live sessions from
  `claude agents --json`; `POST /api/stop` signals one by pid, after checking it
  against that list so the endpoint can't signal arbitrary processes. Sessions
  can't be stopped from the Claude app, so this is launcher-only too.
- The launcher writes its pid to `/run/launcher.pid`, so it can be reloaded with
  `kill $(cat /run/launcher.pid)` without restarting the container and
  destroying every running session.
- `bin/serve`, a supervisor loop that runs the launcher as PID 1's child so a crash
  in the web app doesn't take running Claude sessions down with the container.
- `compose.dev.yaml` for local development: builds from the working tree and
  bind-mounts `app/` and `bin/start-session`, so edits are live without a rebuild.
- Resource limits on the deployed container (`pids_limit`, `mem_limit`,
  `no-new-privileges`), so a runaway agent takes down the container rather than
  the NAS.

### Changed

- Feature work happens on `dev` and merges to `main` when it is ready. The
  deployed image tracks `latest`, which every push to `main` rebuilds, so `main`
  has to stay deployable.

### Removed

- The one-session-per-project guard in `start-session`. Multiple sessions per
  project are now allowed; tmux names are suffixed (`project`, `project-2`).

## [0.0.1] - 2026-08-15

First tagged release.

### Added

- Container image based on `node:22-slim` with the Claude Code CLI, `git`, `gh`,
  `tmux` and `jq`.
- `bin/start-session`, which starts a Claude Code session with Remote Control
  enabled inside a detached tmux session, so it outlives the caller.
- GitHub Actions build publishing `latest`, `sha-<commit>`, and semver tags to
  `ghcr.io`.
- Deployment as a TrueNAS SCALE custom app, with `/root` mounted from a dataset so
  the Claude and GitHub logins survive image rebuilds.

[Unreleased]: https://github.com/simongeronimo/homelab-claude-box/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/simongeronimo/homelab-claude-box/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/simongeronimo/homelab-claude-box/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/simongeronimo/homelab-claude-box/releases/tag/v0.0.1
