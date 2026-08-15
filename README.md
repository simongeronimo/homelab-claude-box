# homelab-claude-box

A container that runs Claude Code sessions on a TrueNAS SCALE server, so they can be
started at home and driven from the Claude mobile app via Remote Control.

## Deploying on TrueNAS

Paths assume a pool named `Apps`. Adjust if yours differs.

1. Create a dataset `Apps/claude-box`, and a `home` directory inside it:

   ```bash
   mkdir /mnt/Apps/claude-box/home
   ```

   The repo does not need to be cloned on the NAS. The image is built by GitHub
   Actions and pulled from `ghcr.io`.

2. **Apps → Discover → ⋮ → Install via YAML**. Name it `claude-box` and paste the
   contents of `compose.yaml`.

3. Log in to Claude inside the container:

   ```bash
   docker exec -it claude-box bash
   claude auth login
   ```

   Use a claude.ai account. API keys and `claude setup-token` tokens do **not** work
   with Remote Control.

4. Confirm the credentials landed on the dataset rather than in the container's
   disposable layer. Run this on the NAS, not inside the container:

   ```bash
   ls -l /mnt/Apps/claude-box/home/.claude/.credentials.json
   ```

   If that file is missing, the volume mount is wrong and the login will not
   survive a restart.

5. Restart the app from the TrueNAS UI, then confirm the login survived:

   ```bash
   docker exec claude-box claude auth status
   ```

## Starting a session

```bash
docker exec claude-box start-session myproject
```

Projects live in `/root/github/`. The script starts Claude with Remote Control
enabled inside a detached `tmux` session, so it outlives the caller — a Remote
Control session dies with its process. The session then appears in the Code tab of
the Claude app.

## Development

Run a local container built from the working tree, with its own state in
`./data/home` and its own logins:

```bash
docker compose -f compose.dev.yaml up -d --build
docker compose -f compose.dev.yaml exec claude-box claude auth login
```

`app/` and `bin/` are bind-mounted, so edits take effect without a rebuild.
Reload the launcher after changing `server.js`:

```bash
docker compose -f compose.dev.yaml exec claude-box sh -c 'kill $(cat /run/launcher.pid)'
```

`bin/serve` restarts it within two seconds. Don't use `docker compose restart`
for this — restarting the container destroys every running session, which is the
thing `bin/serve` exists to prevent.

`index.html` needs nothing at all; it is read from disk on each request.

Rebuild only when the Dockerfile changes. Put some git repositories in
`data/home/github/` to have something to launch.

Cloning and creating repositories needs GitHub credentials in the container:

```bash
docker compose -f compose.dev.yaml exec claude-box gh auth login
```

## Updating

Push to `main`. GitHub Actions builds the image and pushes it to `ghcr.io`, then
restarting the app in the TrueNAS UI pulls it — `pull_policy: always` means every
start re-pulls.

### Releases

Pushing a git tag publishes matching image tags:

```bash
git tag v0.0.2 && git push --tags
```

That produces `0.0.2` and `0.0`, alongside the `latest` and `sha-<commit>` tags that
every push to `main` produces.

To pin or roll back, change the tag in `compose.yaml` from `latest` to a version or
a `sha-<commit>` tag and redeploy.

## Notes

- `/root` is mounted from `Apps/claude-box/home`, which holds the Claude login
  (`~/.claude`) and project checkouts. Everything else in the container is
  disposable and rebuilt from the Dockerfile.
- Do not set `ANTHROPIC_API_KEY`, `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, or
  `ANTHROPIC_BASE_URL` in the environment. Each one silently breaks Remote Control.
- PID 1 is currently a placeholder. It becomes the launcher web app once that exists.
