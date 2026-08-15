'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { json } = require('node:stream/consumers');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8080);
const PROJECTS_DIR = '/root/github';
const TRANSCRIPTS_DIR = path.join(os.homedir(), '.claude', 'projects');

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

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return sendJson(res, 200, { projects: await listProjects() });
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
    require('node:fs').writeFileSync('/run/launcher.pid', String(process.pid));
    console.log(`launcher on ${PORT}, projects in ${PROJECTS_DIR}`);
  });
