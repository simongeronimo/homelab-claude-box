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

// ---------------------------------------------------------------------------
// Handlers. These two are yours to write.
// ---------------------------------------------------------------------------

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
        try {
          await fsp.access(path.join(dir, '.git'));
        } catch {
          return null;
        }
        return { name: e.name, lastUsed: await lastUsed(dir) };
      }),
  );

  return projects
    .filter(Boolean)
    .sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
}

/** Live sessions, as Claude itself reports them. */
async function listRunning() {
  const { stdout } = await execFileAsync('claude', ['agents', '--json']);
  const agents = JSON.parse(stdout);

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
  try {
    const args = sessionId ? [name, sessionId] : [name];
    const { stdout } = await execFileAsync('start-session', args);
    return stdout.trim();
  } catch (err) {
    // start-session reports why it refused on stderr; that is what the user
    // needs to see, not "Command failed with exit code 1".
    throw new Error(err.stderr?.trim() || err.message);
  }
}

// ---------------------------------------------------------------------------
// Plumbing.
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(await fsp.readFile(path.join(__dirname, 'index.html')));
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return sendJson(res, 200, { projects: await listProjects() });
  }

  if (req.method === 'GET' && url.pathname === '/api/running') {
    return sendJson(res, 200, { running: await listRunning() });
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    let body;
    try {
      body = await json(req);
    } catch {
      return sendJson(res, 400, { error: 'expected a JSON body' });
    }
    if (!Number.isInteger(body?.pid)) {
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
    let body;
    try {
      body = await json(req);
    } catch {
      return sendJson(res, 400, { error: 'expected a JSON body' });
    }
    if (typeof body?.project !== 'string' || !body.project) {
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
