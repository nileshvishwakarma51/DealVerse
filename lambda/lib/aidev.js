'use strict';

// "AI Developer" — lets an admin request a code change from the panel. The change
// is implemented by an AI agent (OpenCode) running in a GitHub Actions workflow on
// a throwaway `ai/*` branch, gated by tests/build/synth. This module is a thin
// GitHub-API client + task store; ALL the actual work happens in the workflows.
// Prod is never touched until the admin taps Deploy.
//
// Isolation: state lives in ONE global config item `aidev` (never a tenant item),
// so no existing feature/config/data is read or modified here.
const crypto = require('crypto');
const { ApiError } = require('./errors');
const { getGlobal, setGlobal } = require('./store');

const KEY = 'aidev';
const API = 'https://api.github.com';
const DEV_WORKFLOW = 'ai-develop.yml';
const DEPLOY_WORKFLOW = 'ai-deploy.yml';
const DEFAULT_OWNER = 'nileshvishwakarma51';
const DEFAULT_REPO = 'DealVerse';
const TIMEOUT_MS = 10000;
const MAX_TASKS = 30;

async function load() {
  const c = (await getGlobal(KEY)) || {};
  return {
    pat: c.pat || null,
    owner: c.owner || DEFAULT_OWNER,
    repo: c.repo || DEFAULT_REPO,
    tasks: Array.isArray(c.tasks) ? c.tasks : [],
  };
}
async function save(c) {
  await setGlobal(KEY, c);
}

// Non-sensitive view — never returns the PAT.
function mask(c) {
  return { configured: !!c.pat, owner: c.owner, repo: c.repo };
}

// ── GitHub REST helper (never logs the token) ────────────────────────────────
async function gh(cfg, method, path, body) {
  if (!cfg.pat) throw new ApiError(400, 'Connect a GitHub token first.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.pat}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'DealVerse-AIDev',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(502, 'Could not reach GitHub.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(401, 'GitHub rejected the token (check its scopes / expiry).');
  }
  if (res.status === 204) return null; // dispatch / delete success
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new ApiError(502, `GitHub error: ${(data && data.message) || res.status}`);
  }
  return data;
}

// ── Config ───────────────────────────────────────────────────────────────────
async function getConfig() {
  return mask(await load());
}
async function setPat({ pat, owner, repo }) {
  const c = await load();
  if (pat !== undefined) c.pat = String(pat || '').trim() || null;
  if (owner) c.owner = String(owner).trim();
  if (repo) c.repo = String(repo).trim();
  await save(c);
  return mask(c);
}

// ── Tasks ────────────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'change';
}
function stamp() {
  // Compact UTC yyyymmddHHMM for a readable, sortable branch name.
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

async function createTask(prompt) {
  const p = String(prompt || '').trim();
  if (!p) throw new ApiError(400, 'Describe the change you want.');
  const c = await load();
  if (!c.pat) throw new ApiError(400, 'Connect a GitHub token first.');
  const id = crypto.randomBytes(4).toString('hex');
  const branch = `ai/${stamp()}-${slugify(p)}-${id.slice(0, 4)}`;
  const now = new Date().toISOString();
  // Dispatch the develop workflow from main; it creates the branch itself.
  await gh(c, 'POST', `/repos/${c.owner}/${c.repo}/actions/workflows/${DEV_WORKFLOW}/dispatches`, {
    ref: 'main',
    inputs: { prompt: p, branch, task_id: id },
  });
  const task = {
    id,
    prompt: p,
    branch,
    createdAt: now,
    updatedAt: now,
    discarded: false,
    deployed: false,
    develop: { dispatchedAt: now, runId: null, status: 'queued', conclusion: null, url: null },
    deploy: null,
  };
  c.tasks.unshift(task);
  c.tasks = c.tasks.slice(0, MAX_TASKS);
  await save(c);
  return task;
}

// Find the newest workflow run created at/after `sinceIso` that no other task has
// already claimed. Used to attach a run id to a freshly-dispatched task.
async function findRun(c, workflowFile, sinceIso, claimedIds) {
  const data = await gh(c, 'GET', `/repos/${c.owner}/${c.repo}/actions/workflows/${workflowFile}/runs?per_page=20&event=workflow_dispatch`);
  const runs = (data && data.workflow_runs) || [];
  const since = Date.parse(sinceIso) - 60000; // small skew allowance
  const match = runs
    .filter((r) => Date.parse(r.created_at) >= since && !claimedIds.has(r.id))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  return match || null;
}

// Refresh live status of any non-terminal task from the GitHub Actions API.
async function refresh(c) {
  const claimedDev = new Set(c.tasks.map((t) => t.develop && t.develop.runId).filter(Boolean));
  const claimedDep = new Set(c.tasks.map((t) => t.deploy && t.deploy.runId).filter(Boolean));
  let changed = false;

  for (const t of c.tasks) {
    if (t.discarded) continue;
    // develop phase
    if (t.develop && t.develop.status !== 'completed') {
      try {
        if (!t.develop.runId) {
          const run = await findRun(c, DEV_WORKFLOW, t.develop.dispatchedAt, claimedDev);
          if (run) {
            t.develop.runId = run.id;
            claimedDev.add(run.id);
            t.develop.status = run.status;
            t.develop.conclusion = run.conclusion;
            t.develop.url = run.html_url;
            changed = true;
          }
        } else {
          const run = await gh(c, 'GET', `/repos/${c.owner}/${c.repo}/actions/runs/${t.develop.runId}`);
          if (run && (run.status !== t.develop.status || run.conclusion !== t.develop.conclusion)) {
            t.develop.status = run.status;
            t.develop.conclusion = run.conclusion;
            t.develop.url = run.html_url;
            changed = true;
          }
        }
      } catch {
        /* transient — try next refresh */
      }
    }
    // deploy phase
    if (t.deploy && t.deploy.status !== 'completed') {
      try {
        if (!t.deploy.runId) {
          const run = await findRun(c, DEPLOY_WORKFLOW, t.deploy.dispatchedAt, claimedDep);
          if (run) {
            t.deploy.runId = run.id;
            claimedDep.add(run.id);
            t.deploy.status = run.status;
            t.deploy.conclusion = run.conclusion;
            t.deploy.url = run.html_url;
            changed = true;
          }
        } else {
          const run = await gh(c, 'GET', `/repos/${c.owner}/${c.repo}/actions/runs/${t.deploy.runId}`);
          if (run && (run.status !== t.deploy.status || run.conclusion !== t.deploy.conclusion)) {
            t.deploy.status = run.status;
            t.deploy.conclusion = run.conclusion;
            t.deploy.url = run.html_url;
            if (run.status === 'completed' && run.conclusion === 'success') t.deployed = true;
            changed = true;
          }
        }
      } catch {
        /* transient */
      }
    }
  }
  if (changed) {
    c.tasks.forEach((t) => { t.updatedAt = new Date().toISOString(); });
    await save(c);
  }
  return c;
}

// A single human-facing status string for the UI.
function uiStatus(t) {
  if (t.discarded) return 'discarded';
  if (t.deploy) {
    if (t.deploy.status !== 'completed') return 'deploying';
    return t.deploy.conclusion === 'success' ? 'deployed' : 'deploy-failed';
  }
  if (t.develop.status !== 'completed') {
    return t.develop.runId ? 'running' : 'queued';
  }
  return t.develop.conclusion === 'success' ? 'ready' : 'failed';
}

function viewTask(c, t) {
  return {
    id: t.id,
    prompt: t.prompt,
    branch: t.branch,
    status: uiStatus(t),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    developUrl: t.develop && t.develop.url,
    deployUrl: t.deploy && t.deploy.url,
    diffUrl: `https://github.com/${c.owner}/${c.repo}/compare/main...${encodeURIComponent(t.branch)}`,
  };
}

async function listTasks() {
  let c = await load();
  if (c.pat && c.tasks.some((t) => !t.discarded)) {
    c = await refresh(c);
  }
  return { config: mask(c), tasks: c.tasks.map((t) => viewTask(c, t)) };
}

async function deployTask(id) {
  const c = await load();
  const t = c.tasks.find((x) => x.id === id);
  if (!t) throw new ApiError(404, 'Task not found.');
  if (t.discarded) throw new ApiError(400, 'That task was discarded.');
  if (t.develop.status !== 'completed' || t.develop.conclusion !== 'success') {
    throw new ApiError(400, 'The change is not ready (build/tests have not passed).');
  }
  if (t.deploy && t.deploy.status !== 'completed') throw new ApiError(400, 'A deploy is already in progress.');
  const now = new Date().toISOString();
  await gh(c, 'POST', `/repos/${c.owner}/${c.repo}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`, {
    ref: 'main',
    inputs: { branch: t.branch },
  });
  t.deploy = { dispatchedAt: now, runId: null, status: 'queued', conclusion: null, url: null };
  t.updatedAt = now;
  await save(c);
  return viewTask(c, t);
}

async function discardTask(id) {
  const c = await load();
  const t = c.tasks.find((x) => x.id === id);
  if (!t) throw new ApiError(404, 'Task not found.');
  // Best-effort branch delete (may already be gone); never blocks marking discarded.
  try {
    await gh(c, 'DELETE', `/repos/${c.owner}/${c.repo}/git/refs/heads/${t.branch}`);
  } catch {
    /* ignore */
  }
  t.discarded = true;
  t.updatedAt = new Date().toISOString();
  await save(c);
  return viewTask(c, t);
}

module.exports = { getConfig, setPat, createTask, listTasks, deployTask, discardTask };
