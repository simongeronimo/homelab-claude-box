'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { json } = require('node:stream/consumers');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 8080;
const PORT = Number(process.env.PORT || DEFAULT_PORT);
const PROJECTS_DIR = '/root/github';
const TRANSCRIPTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const USAGE_TTL_MS = 60_000;

/**
 * ntfy publishes to a topic name with no account behind it, so the topic is
 * the password — it has to be unguessable, and it is set per box rather than
 * committed with a default anyone could read here. Unset disables the feature
 * and hides the button rather than failing when it is pressed.
 */
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';

/**
 * A pending reminder outlives the process on purpose. The launcher restarts on
 * crash and on every reload, and an in-memory timer would go with it — leaving
 * a reminder that was promised and silently never arrives, which is the one
 * failure you cannot notice.
 */
const REMINDER_FILE = path.join(os.homedir(), '.claude-box', 'reminder.json');

/** Past this, a missed reminder is stale news rather than a late one. */
const REMINDER_GRACE_MS = 60 * 60 * 1000;

/** Where Claude keeps the OAuth token that Remote Control depends on. */
const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');

/** Login checks hit the network, so they are cached like the usage bars. */
const STATUS_TTL_MS = 30_000;

/**
 * The PNG is for iOS: added to the Home Screen it ignores SVG icons entirely,
 * and without an apple-touch-icon it uses a screenshot of the page instead.
 * It is opaque and square-cornered on purpose — iOS renders transparency as
 * black and applies its own corner mask.
 */
const ICONS = {
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
  '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png' },
};

const exists = (p) => fsp.access(p).then(() => true, () => false);

const repoName = (nameWithOwner) => nameWithOwner.split('/').pop();

/**
 * Where Claude keeps a project's transcripts: one .jsonl per session, under
 * ~/.claude/projects/<project-path-with-slashes-as-dashes>/
 */
function transcriptDir(projectDir) {
  return path.join(TRANSCRIPTS_DIR, projectDir.replaceAll('/', '-'));
}

async function transcripts(projectDir) {
  try {
    return (await fsp.readdir(transcriptDir(projectDir))).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return []; // no sessions for this project yet
  }
}

/**
 * When a project was last worked on, as epoch ms, or 0 if never.
 *
 * Claude appends to a transcript as the conversation goes, so the newest file
 * mtime is the last time you actually used the project. The directory's own
 * mtime would only say when a session was last *created*.
 */
async function lastUsed(projectDir) {
  const dir = transcriptDir(projectDir);
  const times = await Promise.all(
    (await transcripts(projectDir)).map((f) =>
      fsp
        .stat(path.join(dir, f))
        .then((s) => s.mtimeMs)
        .catch(() => 0),
    ),
  );
  return Math.max(0, ...times);
}

/**
 * The opening prompt of a transcript, for labelling it in the session picker.
 *
 * ponytail: reads the first 64KB only. The opening prompt sits at the top of
 * the file and transcripts run to megabytes; a session whose first real user
 * message somehow lands past 64KB shows up unlabelled rather than costing a
 * multi-megabyte read per entry in the list.
 */
async function firstPrompt(file) {
  const handle = await fsp.open(file);
  try {
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(65536) });

    for (const line of buffer.subarray(0, bytesRead).toString().split('\n')) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // blank line, or the 64KB cut landed mid-line
      }
      if (entry.type !== 'user') continue;

      const content = entry.message?.content;
      const text = typeof content === 'string' ? content : content?.find?.((b) => b.text)?.text;
      if (text?.trim()) return text.trim().slice(0, 120);
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Same rule start-session enforces. Applied here too because listSessions
 * builds a filesystem path from this directly, without going through the
 * script.
 */
function isValidName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('.');
}

/** Resumable sessions for a project, most recent first. */
async function listSessions(project) {
  const projectDir = path.join(PROJECTS_DIR, project);
  const dir = transcriptDir(projectDir);

  const sessions = await Promise.all(
    (await transcripts(projectDir)).map(async (file) => {
      const full = path.join(dir, file);
      const [stat, label] = await Promise.all([fsp.stat(full), firstPrompt(full)]);
      return { id: path.basename(file, '.jsonl'), label, lastUsed: stat.mtimeMs };
    }),
  );

  return sessions.sort((a, b) => b.lastUsed - a.lastUsed);
}

/** Git repositories in PROJECTS_DIR, most recently worked on first. */
async function listProjects() {
  const entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });

  const projects = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const dir = path.join(PROJECTS_DIR, e.name);
        if (!(await exists(path.join(dir, '.git')))) return null;
        return { name: e.name, lastUsed: await lastUsed(dir) };
      }),
  );

  return projects
    .filter(Boolean)
    .sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
}

/**
 * The account's rate limit usage — the numbers behind the Claude app's usage
 * bars: the five hour session window, and the weekly limits.
 *
 * Shelled out to `usage` rather than fetched here, so the OAuth token stays
 * inside one small script and never enters the web server, which is the thing
 * listening on the network.
 *
 * Cached, because this is a round trip to Anthropic and the launcher's own
 * page load already fans out to several endpoints. A minute-old reading of a
 * five hour window is still the right reading.
 */
let usageCache = { at: 0, value: null };

async function usage() {
  if (usageCache.value && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.value;

  const raw = JSON.parse(await run('usage', []));

  // `limits` is the endpoint's own normalised view — the same list the app
  // renders, already carrying only the bars that apply to this account. The
  // wider response has a slot per limit kind, mostly null.
  const value = {
    limits: (raw.limits ?? [])
      .filter((l) => typeof l.percent === 'number')
      .map((l) => ({
        kind: l.kind,
        label: limitLabel(l),
        percent: l.percent,
        severity: l.severity ?? 'normal',
        resetsAt: l.resets_at ? Date.parse(l.resets_at) : null,
      })),
  };

  usageCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// "Tell me when the five hour window resets."
// ---------------------------------------------------------------------------

let reminderTimer = null;
let reminderAt = null;

async function writeReminder(at) {
  reminderAt = at;
  if (!at) return fsp.rm(REMINDER_FILE, { force: true });
  await fsp.mkdir(path.dirname(REMINDER_FILE), { recursive: true });
  await fsp.writeFile(REMINDER_FILE, JSON.stringify({ at }));
}

async function publish(title, message) {
  const res = await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: title, Priority: 'high', Tags: 'sparkles' },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
}

async function fireReminder() {
  try {
    await publish('Claude Box', 'Your five hour window has reset — you can continue.');
    console.log('reminder sent');
  } catch (err) {
    // Nothing useful to retry against: the window has reset either way, and a
    // retry loop would outlive the thing it is about.
    console.error('reminder failed to send:', err.message);
  }
  await writeReminder(null);
}

function armReminder(at) {
  clearTimeout(reminderTimer);
  reminderTimer = setTimeout(fireReminder, Math.max(0, at - Date.now()));
}

/** Arm or cancel the reminder for the window that is open now. */
async function setReminder(on) {
  if (!NTFY_TOPIC) throw new Error('notifications are not configured — set NTFY_TOPIC');

  if (!on) {
    clearTimeout(reminderTimer);
    await writeReminder(null);
    return { remindAt: null };
  }

  // The reset time is taken from the account rather than from the browser, so
  // a request cannot ask to be woken at an arbitrary time.
  const session = (await usage()).limits.find((l) => l.kind === 'session');
  if (!session?.resetsAt) throw new Error('no five hour window is open');

  armReminder(session.resetsAt);
  await writeReminder(session.resetsAt);
  return { remindAt: session.resetsAt };
}

/** Re-arm across a restart, which is the whole point of persisting it. */
async function restoreReminder() {
  const raw = await fsp.readFile(REMINDER_FILE, 'utf8').catch(() => null);
  if (!raw) return;

  let at;
  try {
    at = JSON.parse(raw).at;
  } catch {
    return writeReminder(null);
  }
  if (!Number.isFinite(at)) return writeReminder(null);

  const late = Date.now() - at;
  if (late < 0) {
    reminderAt = at;
    return armReminder(at);
  }
  // It came due while the launcher was down. Still worth saying if it only
  // just happened; otherwise drop it rather than announce old news.
  if (late < REMINDER_GRACE_MS) return fireReminder();
  return writeReminder(null);
}

/** The labels the Claude app itself uses. */
function limitLabel(limit) {
  if (limit.kind === 'session') return 'Current session';
  const model = limit.scope?.model?.display_name;
  return model ? `Current week (${model} only)` : 'Current week (all models)';
}

/** Live sessions, as Claude itself reports them. */
async function listRunning() {
  const agents = JSON.parse(await run('claude', ['agents', '--json']));

  return agents.map((a) => ({
    pid: a.pid,
    name: a.name,
    status: a.status,
    project: a.cwd?.startsWith(`${PROJECTS_DIR}/`) ? path.basename(a.cwd) : a.cwd,
  }));
}

/**
 * Stop a session by signalling the Claude process. Its tmux session ends with
 * it, since the session exists only to hold that command.
 *
 * The pid arrives from the browser, so it is checked against Claude's own list
 * before anything is signalled — otherwise this endpoint would kill arbitrary
 * processes in the container, PID 1 included.
 */
async function stopSession(pid) {
  const agent = (await listRunning()).find((a) => a.pid === pid);
  if (!agent) throw new Error(`no running session with pid ${pid}`);

  process.kill(pid, 'SIGTERM');
  return `stopped ${agent.name}`;
}

/**
 * Start a session, returning what start-session printed.
 *
 * execFile, not exec: `name` is passed as a discrete argument rather than
 * interpolated into a shell string, so a project name can never become a
 * command. start-session validates the name as well.
 */
async function startSession(name, sessionId) {
  // A stale Claude token still lets tmux come up and start-session report
  // success, but Remote Control never connects — so the session sits there
  // looking alive and is unreachable from the phone. Refuse up front and say
  // why, rather than handing back a success that cannot be used.
  const { claude } = await authStatus();
  if (!claude.ok && claude.certain) {
    throw new Error('Claude is signed out, so Remote Control would never connect. Sign in from the status panel first.');
  }
  return run('start-session', sessionId ? [name, sessionId] : [name]);
}

/** Repositories on GitHub that aren't cloned here yet. */
async function githubRepos() {
  const stdout = await run('gh', [
    'repo',
    'list',
    '--limit',
    '100',
    '--json',
    'nameWithOwner,description,updatedAt',
  ]);

  const local = new Set((await listProjects()).map((p) => p.name));
  return JSON.parse(stdout)
    .filter((r) => !local.has(repoName(r.nameWithOwner)))
    .map((r) => ({ repo: r.nameWithOwner, description: r.description, updatedAt: r.updatedAt }));
}

/** Refuse before doing any work, so a failure never leaves a half-made project. */
async function claimDirectory(name) {
  if (!isValidName(name)) throw new Error(`invalid project name: ${name}`);

  const dir = path.join(PROJECTS_DIR, name);
  if (await exists(dir)) throw new Error(`${name} already exists`);
  return dir;
}

async function cloneAndStart(nameWithOwner) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(nameWithOwner || '')) {
    throw new Error(`invalid repository: ${nameWithOwner}`);
  }
  const name = repoName(nameWithOwner);
  const dir = await claimDirectory(name);

  await run('gh', ['repo', 'clone', nameWithOwner, dir]);
  return startSession(name);
}

async function createAndStart(name, isPrivate) {
  await claimDirectory(name);

  // --clone puts it in cwd/<name>, which is where projects live anyway.
  await run('gh', ['repo', 'create', name, isPrivate ? '--private' : '--public', '--clone'], {
    cwd: PROJECTS_DIR,
  });
  return startSession(name);
}

/**
 * What you would lose by deleting this project, so the confirmation can say
 * something specific instead of a generic warning.
 *
 * Every check is best effort: a directory that isn't a git repository at all
 * is the most dangerous case, not an error, and it reports as such.
 */
async function projectRisk(name) {
  if (!isValidName(name)) throw new Error(`invalid project name: ${name}`);
  const cwd = path.join(PROJECTS_DIR, name);

  const git = async (args) => {
    try {
      return await run('git', ['-C', cwd, ...args]);
    } catch {
      return null; // not a repository, or git had nothing to say
    }
  };

  const [remote, status, unpushed] = await Promise.all([
    git(['remote', 'get-url', 'origin']),
    git(['status', '--porcelain']),
    // Commits on any local branch that no remote has. Empty when everything
    // is pushed; null when there are no remotes to compare against.
    git(['log', '--branches', '--not', '--remotes', '--oneline']),
  ]);

  const lines = (out) => (out ? out.split('\n').filter(Boolean).length : 0);

  return {
    isRepo: (await exists(path.join(cwd, '.git'))) === true,
    remote,
    uncommitted: lines(status),
    unpushed: lines(unpushed),
  };
}

/**
 * Delete a project directory, permanently.
 *
 * The name arrives from a browser on the LAN, so it is checked rather than
 * trusted: isValidName already rules out slashes and leading dots, and the
 * resolved path is required to be a direct child of PROJECTS_DIR, so no input
 * can reach outside it. lstat, not stat, because a symlink pointing somewhere
 * else must be refused rather than followed.
 *
 * Refused while a session is live in the project — pulling the directory out
 * from under a running Claude is a good way to lose work that was about to be
 * committed.
 */
async function deleteProject(name) {
  if (!isValidName(name)) throw new Error(`invalid project name: ${name}`);

  const dir = path.resolve(PROJECTS_DIR, name);
  if (path.dirname(dir) !== path.resolve(PROJECTS_DIR)) {
    throw new Error(`refusing to delete outside ${PROJECTS_DIR}`);
  }

  const stat = await fsp.lstat(dir).catch(() => null);
  if (!stat) throw new Error(`${name} does not exist`);
  if (!stat.isDirectory()) throw new Error(`${name} is not a directory`);

  const live = (await listRunning()).find((a) => a.project === name);
  if (live) throw new Error(`${name} has a running session — stop it first`);

  await fsp.rm(dir, { recursive: true, force: true });

  // Transcripts under ~/.claude/projects are deliberately left alone: they are
  // the history of the work, they cost nothing, and they come back usefully if
  // the project is ever cloned here again.
  return `deleted ${name}`;
}

// ---------------------------------------------------------------------------
// Are the logins still good, and signing back in without a terminal.
// ---------------------------------------------------------------------------

/**
 * Whether each login still works, checked against the services themselves
 * rather than trusted from a file on disk.
 *
 * This exists because of one specific failure: a Claude token that has gone
 * stale still lets a session start — tmux comes up, start-session prints
 * success — but Remote Control never connects, so the session looks alive in
 * the launcher and is unreachable from the phone. Nothing about that is
 * visible until you go looking, which is the worst way to find out.
 */
let statusCache = { at: 0, value: null };

async function authStatus({ fresh = false } = {}) {
  if (!fresh && statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value;
  }
  const [claude, github] = await Promise.all([claudeStatus(), githubStatus()]);
  const value = { claude, github };
  statusCache = { at: Date.now(), value };
  return value;
}

/**
 * The access token in the credentials file expires every few hours and Claude
 * refreshes it by itself, so its expiry says nothing useful. The date that
 * actually ends the login is the refresh token's.
 */
async function claudeExpiry() {
  try {
    const raw = await fsp.readFile(CREDENTIALS, 'utf8');
    return JSON.parse(raw).claudeAiOauth?.refreshTokenExpiresAt ?? null;
  } catch {
    return null;
  }
}

async function claudeStatus() {
  const expiresAt = await claudeExpiry();
  try {
    // usage() is a real call to Anthropic with the same OAuth token Remote
    // Control uses, and it is already cached for the usage bars — so this
    // proves the token works rather than only that a file exists, and costs
    // nothing extra.
    await usage();
    const who = JSON.parse(await run('claude', ['auth', 'status'])).email ?? null;
    return { ok: true, certain: true, who, expiresAt };
  } catch (err) {
    return { ...authFailure(err.message), who: null, expiresAt };
  }
}

async function githubStatus() {
  try {
    return { ok: true, certain: true, who: await run('gh', ['api', 'user', '--jq', '.login']) };
  } catch (err) {
    return { ...authFailure(err.message), who: null };
  }
}

const firstLine = (text) => String(text || '').split('\n')[0].slice(0, 200);

/**
 * Not signed in, or merely unable to tell?
 *
 * Worth separating: a failed *check* is not a failed login. A rate-limited or
 * offline box would otherwise report both services dead and refuse to start
 * any session at all — breaking the launcher precisely when you cannot get to
 * a terminal to argue with it. Only a definite rejection is certain; anything
 * unrecognised fails open, because wrongly blocking costs more than the zombie
 * session this guard exists to prevent.
 */
function authFailure(message) {
  const text = String(message || '');
  if (/401|authentication_error|invalid bearer|expired/i.test(text)) {
    return { ok: false, certain: true, detail: 'session expired' };
  }
  if (/gh auth login|not logged in|no longer valid|bad credentials/i.test(text)) {
    return { ok: false, certain: true, detail: 'not signed in' };
  }
  if (/429|rate.?limit/i.test(text)) {
    return { ok: false, certain: false, detail: 'rate limited, could not check' };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(text)) {
    return { ok: false, certain: false, detail: 'offline, could not check' };
  }
  return { ok: false, certain: false, detail: firstLine(text) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Signing in from a phone.
 *
 * Both CLIs only know how to log in at a terminal, so each is run inside a
 * detached tmux session and driven through its pane: read what it printed,
 * show that to the browser, type the answer back. Neither secret ever reaches
 * the page — GitHub's code is entered at github.com, and Claude's code is
 * exchanged by the CLI itself.
 */
const LOGIN = {
  github: {
    session: 'login-github',
    command: 'gh auth login --hostname github.com --git-protocol https --web',
    // "! First copy your one-time code: 54D1-8449"
    read: (pane) => {
      const code = pane.match(/one-time code:\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})/i)?.[1];
      return code ? { code, url: 'https://github.com/login/device' } : null;
    },
    // On a box where git is not wired to gh yet, this is asked before the
    // code is ever printed, and the flow simply stops until it is answered.
    prompts: [
      // The usual case here: the host entry still exists, its token is just
      // dead, so gh asks before replacing it.
      [/already logged into .*Do you want to re-authenticate/s, 'y'],
      // And this one when git is not wired to gh yet.
      [/Authenticate Git with your GitHub credentials\?/, 'y'],
    ],
    // gh then waits on "Press Enter to open github.com in your browser..."
    // before it starts polling, and there is no browser here to open.
    press: 'Enter',
  },
  claude: {
    session: 'login-claude',
    command: 'claude auth login --claudeai',
    // The redirect goes to a hosted callback rather than localhost, so the
    // whole approval happens on the phone and comes back as a code to paste.
    read: (pane) => {
      const url = pane.match(/https:\/\/claude\.com\/\S+/)?.[0];
      return url ? { url } : null;
    },
    needsCode: true,
  },
};

const DONE = 'LOGIN-FINISHED-';

/** tmux hard-wraps long lines; -J rejoins them so a URL comes back whole. */
async function pane(session) {
  return run('tmux', ['capture-pane', '-p', '-J', '-t', session]).catch(() => '');
}

async function startLogin(service) {
  const cfg = LOGIN[service];
  if (!cfg) throw new Error(`unknown service: ${service}`);

  await run('tmux', ['kill-session', '-t', cfg.session]).catch(() => {});
  // -e HOME: a tmux session inherits the tmux *server's* environment, not
  // this process's, and that server may long predate us. Without this the CLI
  // can end up reading a different home than the one being repaired.
  await run('tmux', [
    'new-session', '-d', '-x', '200', '-y', '50',
    '-e', `HOME=${os.homedir()}`,
    '-s', cfg.session,
    `${cfg.command}; echo ${DONE}$?; sleep 900`,
  ]);

  // Wait for it to print the thing the phone needs, answering anything it
  // asks on the way — these CLIs stop dead on an unanswered prompt, and there
  // is nobody at this terminal to notice.
  const answered = new Set();
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const text = await pane(cfg.session);

    for (const [pattern, key] of cfg.prompts ?? []) {
      if (answered.has(String(pattern)) || !pattern.test(text)) continue;
      answered.add(String(pattern));
      await run('tmux', ['send-keys', '-t', cfg.session, key, 'Enter']);
    }

    const seen = cfg.read(text);
    if (!seen) continue;
    if (cfg.press) await run('tmux', ['send-keys', '-t', cfg.session, cfg.press]);
    return { state: 'waiting', needsCode: Boolean(cfg.needsCode), ...seen };
  }

  await run('tmux', ['kill-session', '-t', cfg.session]).catch(() => {});
  throw new Error(`${service} sign-in did not start`);
}

async function loginState(service) {
  const cfg = LOGIN[service];
  if (!cfg) throw new Error(`unknown service: ${service}`);

  const text = await pane(cfg.session);
  if (!text) return { state: 'idle' };

  const finished = text.match(new RegExp(`${DONE}(\\d+)`));
  if (!finished) {
    return { state: 'waiting', needsCode: Boolean(cfg.needsCode), ...(cfg.read(text) || {}) };
  }

  const ok = finished[1] === '0';
  await run('tmux', ['kill-session', '-t', cfg.session]).catch(() => {});
  statusCache = { at: 0, value: null }; // the answer just changed
  if (!ok) return { state: 'failed', message: firstLine(text.split(DONE)[0].trim().split('\n').pop()) };
  return { state: 'done', message: 'Signed in.' };
}

/**
 * Hand a code back to the waiting CLI.
 *
 * It arrives from a browser and is typed into a terminal, so it is checked
 * rather than trusted, and sent with -l: without it tmux reads names like
 * "Enter" and "C-c" as keystrokes instead of text.
 */
async function submitLoginCode(service, code) {
  const cfg = LOGIN[service];
  if (!cfg?.needsCode) throw new Error(`${service} sign-in does not take a code`);
  if (!/^[A-Za-z0-9._~#/+=-]{8,512}$/.test(code || '')) throw new Error('that does not look like a sign-in code');

  await run('tmux', ['send-keys', '-l', '-t', cfg.session, code]);
  await run('tmux', ['send-keys', '-t', cfg.session, 'Enter']);

  for (let i = 0; i < 25; i++) {
    await sleep(400);
    const state = await loginState(service);
    if (state.state !== 'waiting') return state;
  }
  return { state: 'waiting', needsCode: true };
}

// ---------------------------------------------------------------------------
// Plumbing.
// ---------------------------------------------------------------------------

/**
 * Run a command, returning stdout. Failures surface the command's own stderr,
 * which says what actually went wrong, rather than "Command failed with exit
 * code 1".
 */
async function run(cmd, args, opts) {
  try {
    const { stdout } = await execFileAsync(cmd, args, opts);
    return stdout.trim();
  } catch (err) {
    throw new Error(err.stderr?.trim() || err.message);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Parse a JSON object body. Answers 400 and returns null if it isn't one, so
 * callers can `if (!body) return;` knowing a response has already gone out.
 */
async function readJson(req, res) {
  let body;
  try {
    body = await json(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON body' });
    return null;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { error: 'expected a JSON object' });
    return null;
  }
  return body;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    // Read first, then write the header. writeHead before the await means a
    // failed read leaves headersSent true, the error handler declines to
    // respond, and the request hangs until the browser gives up.
    const html = await fsp.readFile(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // The icons only change when the image does, and a browser asks for them on
  // every visit, so let it keep them for the day.
  const icon = ICONS[url.pathname];
  if (req.method === 'GET' && icon) {
    const body = await fsp.readFile(path.join(__dirname, icon.file));
    res.writeHead(200, {
      'content-type': icon.type,
      'cache-control': 'public, max-age=86400',
    });
    return res.end(body);
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, await authStatus({ fresh: url.searchParams.get('fresh') === '1' }));
  }

  if (req.method === 'GET' && url.pathname === '/api/login') {
    return sendJson(res, 200, await loginState(url.searchParams.get('service')));
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req, res);
    if (!body) return;
    return sendJson(res, 200, await startLogin(body.service));
  }

  if (req.method === 'POST' && url.pathname === '/api/login/code') {
    const body = await readJson(req, res);
    if (!body) return;
    return sendJson(res, 200, await submitLoginCode(body.service, body.code));
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return sendJson(res, 200, { projects: await listProjects() });
  }

  if (req.method === 'GET' && url.pathname === '/api/usage') {
    // Reminder state rides along rather than getting its own request: the page
    // already asks for this, and it is cheap and uncached.
    return sendJson(res, 200, {
      ...(await usage()),
      notify: { enabled: Boolean(NTFY_TOPIC), remindAt: reminderAt },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/remind') {
    const body = await readJson(req, res);
    if (!body) return;
    return sendJson(res, 200, await setReminder(body.on !== false));
  }

  if (req.method === 'GET' && url.pathname === '/api/github/repos') {
    return sendJson(res, 200, { repos: await githubRepos() });
  }

  if (req.method === 'POST' && url.pathname === '/api/clone') {
    const body = await readJson(req, res);
    if (!body) return;
    return sendJson(res, 200, { output: await cloneAndStart(body.repo) });
  }

  if (req.method === 'POST' && url.pathname === '/api/create') {
    const body = await readJson(req, res);
    if (!body) return;
    return sendJson(res, 200, { output: await createAndStart(body.name, body.private !== false) });
  }

  if (req.method === 'GET' && url.pathname === '/api/running') {
    return sendJson(res, 200, { running: await listRunning() });
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    const body = await readJson(req, res);
    if (!body) return;
    if (!Number.isInteger(body.pid)) {
      return sendJson(res, 400, { error: 'missing "pid"' });
    }
    return sendJson(res, 200, { output: await stopSession(body.pid) });
  }

  if (req.method === 'GET' && url.pathname === '/api/risk') {
    const project = url.searchParams.get('project');
    if (!isValidName(project)) return sendJson(res, 400, { error: 'invalid "project"' });
    return sendJson(res, 200, await projectRisk(project));
  }

  if (req.method === 'POST' && url.pathname === '/api/delete') {
    const body = await readJson(req, res);
    if (!body) return;
    if (typeof body.project !== 'string' || !body.project) {
      return sendJson(res, 400, { error: 'missing "project"' });
    }
    return sendJson(res, 200, { output: await deleteProject(body.project) });
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const project = url.searchParams.get('project');
    if (!isValidName(project)) return sendJson(res, 400, { error: 'invalid "project"' });
    return sendJson(res, 200, { sessions: await listSessions(project) });
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    const body = await readJson(req, res);
    if (!body) return;
    if (typeof body.project !== 'string' || !body.project) {
      return sendJson(res, 400, { error: 'missing "project"' });
    }
    const session = typeof body.session === 'string' ? body.session : undefined;
    return sendJson(res, 200, { output: await startSession(body.project, session) });
  }

  sendJson(res, 404, { error: 'not found' });
}

http
  .createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(`${req.method} ${req.url}:`, err);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    });
  })
  .listen(PORT, () => {
    // So a reload is `kill $(cat /run/launcher.pid)` using the shell builtin.
    // Restarting the container would work too, and would kill every session.
    //
    // Only the instance on the real port claims it. A second instance started
    // on another port — a test run — used to overwrite it, so the next reload
    // signalled a process that had already exited while the real launcher kept
    // serving stale code, with nothing to say anything was wrong.
    if (PORT === DEFAULT_PORT) {
      require('node:fs').writeFileSync('/run/launcher.pid', String(process.pid));
    }
    console.log(`launcher on ${PORT}, projects in ${PROJECTS_DIR}`);
    restoreReminder().catch((err) => console.error('could not restore reminder:', err.message));
  });
