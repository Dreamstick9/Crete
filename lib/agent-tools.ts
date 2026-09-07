/**
 * lib/agent-tools.ts
 *
 * Phase A read-only tool registry for the OSS assistant agent.
 *
 * Server-side only: this module imports `./github` (which itself uses
 * `next/headers`) and must never be imported from client components.
 *
 * Rules enforced here:
 * - Every `run` validates args manually and returns `{ok:false, summary}`
 *   on bad input — never throws for user input (internal failures are also
 *   mapped to `{ok:false, ...}` so the loop never sees an exception).
 * - Every string originating from GitHub passes through `sanitizeField`.
 * - Every summary is capped at 2000 chars.
 * - Network calls only hit api.github.com, with the caller's own token
 *   (caller's own token first, standard fallback chain after that).
 * - No API keys, no prompt text, no non-`@/lib` imports.
 */

import { sanitizeField } from './assistant';
import { getStudentsKV } from './kv-students';
import { getFlaggedPRs } from './flagged';
import { FOCUSED_ANSWER_CHARS, askRepo, normalizeRepoName, parseIssueRef, repoTopics } from './deepwiki';
import { readUrls, webSearch } from './websearch';

export interface AgentContext {
  /** Verified GitHub login (resolved by lib/session.ts), or null in tests
   *  and on the not-signed-in path the routes now reject before we get here. */
  username: string | null;
  /** The caller's own OAuth token. Tools use this and only this. */
  token: string | null;
  requestId: string;
  /**
   * The Kairi chat id this turn belongs to. Forwarded to the web-search
   * provider, which uses a stable per-conversation id for free-tier rate
   * limiting. It is an opaque UUID and carries no identity, so sending it
   * discloses nothing about the student.
   */
  sessionId?: string;
  /**
   * How many tool calls the model asked for in this one turn. Set by the
   * loop, which is the only place that knows. A tool whose output is a token
   * budget rather than a fixed payload uses it to shrink: three narrow
   * DeepWiki questions asked together should cost about what one broad one
   * costs, and without this each call would happily return its full cap.
   */
  batchSize?: number;
}

/**
 * GitHub headers for a call made on the caller's behalf.
 *
 * Deliberately NOT `getGitHubHeaders()`: with no argument that helper falls
 * back to picking a *random other student's* OAuth token out of
 * `github_token_pool`, which charges a stranger's rate limit for this
 * request and, on any `/user`-shaped endpoint, would return the stranger's
 * data. Building the headers inline here makes it structurally impossible
 * for a tool to reach the pool, and greppable that we never do.
 */
function callerHeaders(ctx: AgentContext): HeadersInit {
  const token = ctx.token || process.env.GITHUB_TOKEN;
  return token
    ? { Accept: 'application/vnd.github.v3+json', Authorization: `Bearer ${token}` }
    : { Accept: 'application/vnd.github.v3+json' };
}

export interface ToolResult {
  ok: boolean;
  summary: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema for the model
  needsLogin: boolean; // true = guests get "sign in" refusal
  costsSearch: boolean; // true = spends GitHub Search quota
  /**
   * True when the result contains text written by people who are not us —
   * issue titles, repository documentation, a third party's summary of a
   * codebase. The loop wraps these in the untrusted-data envelope before the
   * model sees them, because "ignore previous instructions" in an issue title
   * is a real and cheap attack (OWASP LLM01). Tools that only ever return
   * strings this repo composed itself leave it false.
   */
  untrusted?: boolean;
  run: (args: Record<string, unknown>, ctx: AgentContext) => Promise<ToolResult>;
}

const MAX_SUMMARY_CHARS = 2000;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USERNAME_RE = /^[A-Za-z0-9-]{1,39}$/;
const LANGUAGE_RE = /^[A-Za-z0-9+#-]+$/;
const MAX_LIMIT = 100;
const MAX_PR_NUMBER = 10_000_000;

function cap(summary: string): string {
  return summary.length > MAX_SUMMARY_CHARS ? summary.slice(0, MAX_SUMMARY_CHARS) : summary;
}

function fail(summary: string): ToolResult {
  return { ok: false, summary: cap(summary) };
}

function ok(summary: string): ToolResult {
  return { ok: true, summary: cap(summary) };
}

function isArgsObject(args: unknown): args is Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args);
}

/**
 * Like `sanitizeField`, but keeps newlines.
 *
 * An issue body is Markdown: the reproduction steps are a numbered list and
 * the stack trace is a fenced block. `sanitizeField` collapses all
 * whitespace, which is correct for a title and destroys a body — it turns
 * the one part of an issue the model most needs to read accurately into a
 * single run-on line. Control characters still go, and so do runs of blank
 * lines, which are pure token cost.
 */
function sanitizeBody(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

async function getMyStanding(
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected an object.');
  if (!ctx || typeof ctx.username !== 'string' || ctx.username.trim().length === 0) {
    return fail('Sign in with GitHub to see your standing. Guests cannot use this tool.');
  }
  const username = ctx.username.trim();
  try {
    const students = await getStudentsKV();
    const tracked = students.find((s) => s.github.toLowerCase() === username.toLowerCase());
    if (!tracked) {
      const u = sanitizeField(username, 40);
      return ok(
        `@${u} is not currently tracked on the leaderboard. Request to be added on /join.`,
      );
    }
    const u = sanitizeField(tracked.github, 40);
    const extra = [
      tracked.year ? sanitizeField(tracked.year, 20) : '',
      tracked.campus ? sanitizeField(tracked.campus, 20) : '',
    ]
      .filter(Boolean)
      .join(', ');
    return ok(
      `@${u} is tracked on the leaderboard${extra ? ` (${extra})` : ''}. ` +
        `Profile: /contributors/${u}. Work checker: /check-work/${u}.`,
    );
  } catch {
    return fail('Could not load roster data right now. Try again later.');
  }
}

async function explainFlag(args: Record<string, unknown>): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {repo, number}.');
  const { repo, number } = args;
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    return fail('Invalid repo: expected "<owner>/<repo>" using letters, numbers, ".", "_" or "-".');
  }
  if (
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    number < 1 ||
    number >= MAX_PR_NUMBER
  ) {
    return fail(`Invalid number: expected a positive integer below ${MAX_PR_NUMBER}.`);
  }
  const id = `${repo}#${number}`;
  try {
    const flagged = await getFlaggedPRs();
    const match =
      flagged.find((f) => f.id === id) ??
      flagged.find((f) => f.id.toLowerCase() === id.toLowerCase());
    if (!match) {
      return ok(`PR ${sanitizeField(id, 100)} is not flagged.`);
    }
    const reason = sanitizeField(match.reason, 20);
    const note = typeof match.note === 'string' && match.note.trim() ? sanitizeField(match.note, 500) : '';
    const title = sanitizeField(match.title, 160);
    const author = sanitizeField(match.author, 40);
    return ok(
      `PR ${sanitizeField(id, 100)} is flagged (reason: ${reason || 'unknown'})` +
        (author ? `; author: @${author}` : '') +
        (title ? `; title: "${title}"` : '') +
        (note ? `. Note: ${note}` : '.'),
    );
  } catch {
    return fail('Could not look up flag data right now. Try again later.');
  }
}

export interface SearchIssueItem {
  title?: unknown;
  html_url?: unknown;
  repository_url?: unknown;
}

async function findGoodFirstIssues(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {language?, limit?}.');
  const { language, limit } = args;
  if (language !== undefined) {
    if (typeof language !== 'string' || language.length > 20 || !LANGUAGE_RE.test(language)) {
      return fail(
        'Invalid language: use up to 20 chars of letters, numbers, "+", "#" or "-".',
      );
    }
  }
  if (limit !== undefined) {
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIMIT
    ) {
      return fail(`Invalid limit: expected an integer between 1 and ${MAX_LIMIT}.`);
    }
  }
  const wanted = Math.min(typeof limit === 'number' ? limit : 5, 5);
  let q = 'is:issue state:open label:"good first issue" no:assignee';
  if (typeof language === 'string') q += ` language:${language}`;
  try {
    const headers = callerHeaders(ctx);
    // Over-fetch, then keep one issue per repository. The Search API sorts
    // by creation date and busy repositories open several beginner issues
    // in a burst, so the top five were routinely five issues from the same
    // project — which is one suggestion, not five.
    const res = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=30`,
      { headers, signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        return fail('GitHub Search rate limit is exhausted right now. Try again later.');
      }
      return fail(`GitHub Search failed (status ${res.status}). Try again later.`);
    }
    const data = (await res.json()) as { items?: SearchIssueItem[] };
    const items = pickDistinctRepos(Array.isArray(data.items) ? data.items : [], wanted);
    if (items.length === 0) {
      return ok(
        `No open good-first-issues found${typeof language === 'string' ? ` for language "${sanitizeField(language, 20)}"` : ''}.`,
      );
    }
    const lines = items.map((item, i) => {
      const title = sanitizeField(item.title, 160) || '(untitled)';
      const url = sanitizeField(item.html_url, 300);
      const repo = repoOfSearchItem(item);
      return `${i + 1}. ${title} (${repo || 'unknown repo'}) — ${url}`;
    });
    return ok(lines.join('\n'));
  } catch {
    return fail('Could not search GitHub right now. Try again later.');
  }
}

function repoOfSearchItem(item: SearchIssueItem): string {
  const repoUrl = typeof item.repository_url === 'string' ? item.repository_url : '';
  return sanitizeField(repoUrl.replace('https://api.github.com/repos/', ''), 100);
}

/** One issue per repository, in the order GitHub returned them. Exported for tests. */
export function pickDistinctRepos(items: SearchIssueItem[], limit: number): SearchIssueItem[] {
  const seen = new Set<string>();
  const out: SearchIssueItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const repo = repoOfSearchItem(item).toLowerCase();
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

async function lookupContributor(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {username}.');
  const { username } = args;
  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
    return fail('Invalid username: 1-39 chars of letters, numbers or hyphens.');
  }
  const name = username.trim();
  try {
    const students = await getStudentsKV();
    const entry = students.find((s) => s.github.toLowerCase() === name.toLowerCase());
    const rosterLine = entry
      ? (() => {
          const login = sanitizeField(entry.github, 40) || name;
          const extra = [
            entry.year ? sanitizeField(entry.year, 20) : '',
            entry.campus ? sanitizeField(entry.campus, 20) : '',
          ]
            .filter(Boolean)
            .join(', ');
          return (
            `@${login} is tracked on this leaderboard${extra ? ` (${extra})` : ''}. ` +
            `Profile: /contributors/${login}. Work checker: /check-work/${login}.`
          );
        })()
      : `@${sanitizeField(name, 40)} is not tracked on this leaderboard (they can request adding on /join).`;

    // Public stats are best-effort; the roster verdict stands on its own.
    let statsLine = 'Public GitHub stats: unavailable right now.';
    try {
      const headers = callerHeaders(ctx);
      const res = await fetch(`https://api.github.com/users/${encodeURIComponent(name)}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404) {
        statsLine = `No GitHub account named @${sanitizeField(name, 40)} exists.`;
      } else if (res.ok) {
        // Only public fields are ever read - emails and private data are ignored.
        const data = (await res.json()) as {
          login?: unknown;
          public_repos?: unknown;
          followers?: unknown;
          following?: unknown;
          bio?: unknown;
          company?: unknown;
        };
        const login = sanitizeField(data.login, 40) || name;
        const num = (v: unknown) => (typeof v === 'number' ? String(v) : '?');
        const bio = sanitizeField(data.bio, 160);
        const company = sanitizeField(data.company, 60);
        statsLine =
          `Public GitHub stats for @${login}: public_repos=${num(data.public_repos)}, ` +
          `followers=${num(data.followers)}, following=${num(data.following)}` +
          (company ? `, company="${company}"` : '') +
          (bio ? `. Bio: "${bio}"` : '') +
          `. https://github.com/${login}`;
      }
    } catch {
      // Keep the roster verdict even when the live lookup fails.
    }
    return ok(`${rosterLine}\n${statsLine}`);
  } catch {
    return fail('Could not look up that user right now. Try again later.');
  }
}

async function compareContributors(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {usernames}.');
  const { usernames } = args;
  if (
    !Array.isArray(usernames) ||
    usernames.length < 2 ||
    usernames.length > 3 ||
    !usernames.every((u) => typeof u === 'string' && USERNAME_RE.test(u))
  ) {
    return fail(
      'Invalid usernames: pass an array of 2-3 GitHub usernames (1-39 chars, letters, numbers, hyphens).',
    );
  }
  const names = usernames as string[];
  try {
    const students = await getStudentsKV();
    const trackedSet = new Set(students.map((s) => s.github.toLowerCase()));
    const headers = callerHeaders(ctx);
    const lines: string[] = [];
    for (const name of names) {
      const tracked = trackedSet.has(name.toLowerCase());
      let stats = 'GitHub stats unavailable';
      try {
        const res = await fetch(`https://api.github.com/users/${encodeURIComponent(name)}`, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 404) {
          stats = 'GitHub user not found';
        } else if (res.ok) {
          // Only public fields are ever read — emails and private data are ignored.
          const data = (await res.json()) as {
            login?: unknown;
            public_repos?: unknown;
            followers?: unknown;
          };
          const login = sanitizeField(data.login, 40) || name;
          const repos = typeof data.public_repos === 'number' ? data.public_repos : '?';
          const followers = typeof data.followers === 'number' ? data.followers : '?';
          stats = `@${login}: public_repos=${repos}, followers=${followers}`;
        }
      } catch {
        // Keep the tracked/untracked verdict even when the live lookup fails.
      }
      lines.push(`@${sanitizeField(name, 40)}: ${tracked ? 'tracked' : 'not tracked'}; ${stats}.`);
    }
    return ok(lines.join('\n'));
  } catch {
    return fail('Could not compare contributors right now. Try again later.');
  }
}

const SITE_TOPICS = ['leaderboard', 'join', 'login', 'refresh', 'flagging', 'contributing'] as const;
type SiteTopic = (typeof SITE_TOPICS)[number];

const SITE_ANSWERS: Record<SiteTopic, string> = {
  leaderboard:
    'The /contributors leaderboard ranks tracked NST students by repo-quality-weighted merged PRs: each merged PR earns weight from its repo signals (stars, forks and more), with decay for repeats in the same repo. ' +
    'Pages render from cache, and a background job refreshes the ~20-30 stalest students every 15 minutes, so data can lag behind GitHub. ' +
    'Use the year, campus and period filters to slice it, and open /contributors/<username> for a per-student PR, issue and review breakdown.',
  join:
    'To join, submit your GitHub username (plus year and campus) on the /join page; an admin reviews the request and approves it. ' +
    'Once approved you appear on the leaderboard, initially as a placeholder until the background refresh fetches your GitHub data. ' +
    'Only real public contributions count toward ranking — see the contributing topic for what qualifies.',
  login:
    'Signing in with GitHub is optional and read-only (scope read:user); every page, including your own profile, works fully as a guest. ' +
    'Logging in removes manual refresh cooldowns, so a stale profile fetches live immediately using your own token instead of waiting for the background rotation. ' +
    'Your token also joins the shared pool that speeds up background refreshes for everyone, while the app never writes to GitHub on your behalf.',
  refresh:
    'Leaderboard pages serve cached data by default, and a background job refreshes the stalest students every 15 minutes (worst-case full coverage is roughly every 16 hours per student). ' +
    'Guests can trigger a manual refresh subject to cooldowns (5 minutes for the leaderboard, 2 hours for an own profile); signed-in users can refresh anytime with their own token. ' +
    'Locally the leaderboard starts empty until data is populated — run npm run bootstrap-data, which calls the same incremental refresh endpoint the production schedule hits.',
  flagging:
    'Admins can flag any PR as fake (made to game the system), self_pr (to the student\u2019s own or a controlled repo), or low_quality (trivial changes); flagged PRs are excluded from scoring but still listed. ' +
    'Automatically, a repository is excluded when it is archived or a fork, or when it has effectively no audience (almost no stars or watchers relative to its forks and merged PRs) and no releases \u2014 the signature of a repo created to farm PRs. Every other repo counts, weighted by its quality signals. A student\u2019s own repos never count unless an admin explicitly approves that repo. ' +
    'Use the explain_flag tool with "<owner>/<repo>" and the PR number to check whether a specific PR is flagged and why.',
  contributing:
    'Contribute real pull requests and issues to public repositories you do not own — only merged PRs into other people\u2019s repos move your ranking. ' +
    'Issues labelled good-first-issue are a solid starting point; the find_good_first_issues tool searches them, optionally filtered by language. ' +
    'To change this tracker itself, fork or branch, ensure npm run build passes, and open a PR against main with a clear description of why the change is needed.',
};

async function siteHelp(args: Record<string, unknown>): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {topic}.');
  const { topic } = args;
  if (typeof topic !== 'string' || !(SITE_TOPICS as readonly string[]).includes(topic)) {
    return fail(`Invalid topic: expected one of ${SITE_TOPICS.join('|')}.`);
  }
  return ok(SITE_ANSWERS[topic as SiteTopic]);
}

/**
 * Issues in ONE repository the student named.
 *
 * This is the "I dropped a repo, find me something to work on" path, and it
 * is deliberately separate from find_good_first_issues, which searches all of
 * GitHub and has no repo parameter at all. It uses the plain Issues API
 * rather than the Search API, so it does not spend the (much scarcer) search
 * quota and returns fresher results.
 *
 * Filtering matters more than listing here. A beginner sent to an issue that
 * is three years stale, already assigned, or actually a pull request has been
 * actively misled, so all three are dropped rather than ranked down.
 */
async function findRepoIssues(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {repo}.');
  const repo = normalizeRepoName(args.repo);
  if (!repo) return fail('Invalid repo: give it as "<owner>/<repo>" or a github.com link.');

  const label = typeof args.label === 'string' ? args.label.trim().slice(0, 50) : '';
  if (label && !/^[A-Za-z0-9 :_.\-]+$/.test(label)) {
    return fail('Invalid label: letters, numbers, spaces, colons, dots, hyphens and underscores only.');
  }
  const limit = Math.min(
    typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 5,
    5,
  );

  const url = new URL(`https://api.github.com/repos/${repo}/issues`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'desc');
  url.searchParams.set('per_page', '30');
  if (label) url.searchParams.set('labels', label);

  let res: Response;
  try {
    res = await fetch(url, { headers: callerHeaders(ctx), signal: AbortSignal.timeout(10000) });
  } catch {
    return fail('GitHub did not respond in time. Try again in a moment.');
  }
  if (res.status === 404) return fail(`No public repository "${repo}" — check the spelling.`);
  if (res.status === 403) return fail('GitHub rate limit reached for this token. Try again later.');
  if (!res.ok) return fail(`GitHub returned ${res.status} for ${repo}.`);

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return fail('GitHub sent a malformed response.');
  }
  if (!Array.isArray(raw)) return fail('GitHub sent an unexpected response.');

  const STALE_MS = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const picked = raw
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    // The Issues API returns pull requests too; they are not work to pick up.
    .filter((i) => !('pull_request' in i))
    // An assigned issue is somebody else's. Sending a beginner to duplicate
    // it wastes the only thing they have less of than skill: momentum.
    .filter((i) => !i.assignee && (!Array.isArray(i.assignees) || i.assignees.length === 0))
    .filter((i) => {
      const updated = typeof i.updated_at === 'string' ? Date.parse(i.updated_at) : NaN;
      return !Number.isFinite(updated) || now - updated < STALE_MS;
    })
    .slice(0, limit);

  if (picked.length === 0) {
    return ok(
      `No unassigned, recently-active open issues found in ${repo}` +
        `${label ? ` with label "${label}"` : ''}. ` +
        'Try without a label filter, or ask me to look at a different repository.',
    );
  }

  const lines = picked.map((i) => {
    const num = typeof i.number === 'number' ? i.number : 0;
    const title = sanitizeField(typeof i.title === 'string' ? i.title : '', 110);
    const labels = Array.isArray(i.labels)
      ? i.labels
          .map((l) => (l && typeof l === 'object' ? (l as Record<string, unknown>).name : l))
          .filter((n): n is string => typeof n === 'string')
          .slice(0, 4)
          .map((n) => sanitizeField(n, 30))
          .join(', ')
      : '';
    const comments = typeof i.comments === 'number' ? i.comments : 0;
    return (
      `#${num} ${title}` +
      `${labels ? ` [${labels}]` : ''} — ${comments} comments — ` +
      `https://github.com/${repo}/issues/${num}`
    );
  });

  return ok(
    `Open, unassigned issues in ${repo}${label ? ` labelled "${label}"` : ''}:\n${lines.join('\n')}`,
  );
}

/**
 * One specific issue or pull request, read in full.
 *
 * This is the tool that makes "help me solve this" mean anything. Without
 * it the agent answered issue links from a repository summary alone: it
 * knew how the codebase was laid out and had never seen a word of the
 * problem it was being asked to solve, so the DeepWiki question it composed
 * was a guess at what the issue probably said.
 *
 * Deliberately NOT part of find_repo_issues, which lists candidates and
 * drops pull requests entirely. `/repos/{owner}/{repo}/issues/{n}` serves
 * issues and PRs from the same numbering, so a student pasting either kind
 * of link is answered here.
 *
 * Everything this returns was typed by a stranger into a public text box,
 * which is the single most likely place for a prompt-injection payload to
 * reach us. Registered `untrusted: true`.
 */
const MAX_ISSUE_BODY_CHARS = 1200;
const MAX_ISSUE_COMMENTS = 3;
const MAX_COMMENT_CHARS = 260;

async function readIssue(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {repo, number}.');

  // The repo argument may itself be a full issue URL carrying the number, so
  // try that first and let an explicit `number` override it.
  const ref = parseIssueRef(args.repo) ?? parseIssueRef(args.issue);
  const repo = ref?.repo ?? normalizeRepoName(args.repo);
  if (!repo) return fail('Invalid repo: give it as "<owner>/<repo>" or a github.com issue link.');

  const explicit =
    typeof args.number === 'number' && Number.isFinite(args.number) ? Math.floor(args.number) : null;
  const number = explicit ?? ref?.number ?? null;
  if (number === null) {
    return fail(`Give me the issue number in ${repo} — for example 123, or the full issue link.`);
  }
  // Out of range is a different mistake from absent, and saying "give me a
  // number" to someone who just gave one sends them round the same loop.
  if (number < 1 || number > MAX_PR_NUMBER) {
    return fail(`${number} is not a real issue number in ${repo}.`);
  }

  const base = `https://api.github.com/repos/${repo}/issues/${number}`;
  let res: Response;
  try {
    res = await fetch(base, { headers: callerHeaders(ctx), signal: AbortSignal.timeout(10000) });
  } catch {
    return fail('GitHub did not respond in time. Try again in a moment.');
  }
  if (res.status === 404) return fail(`No public issue ${repo}#${number} — check the number.`);
  if (res.status === 403) return fail('GitHub rate limit reached for this token. Try again later.');
  if (!res.ok) return fail(`GitHub returned ${res.status} for ${repo}#${number}.`);

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return fail('GitHub sent a malformed response.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('GitHub sent an unexpected response.');
  }
  const issue = raw as Record<string, unknown>;

  const isPR = 'pull_request' in issue;
  const kind = isPR ? 'pull request' : 'issue';
  const title = sanitizeField(issue.title, 140);
  const state = sanitizeField(issue.state, 12) || 'unknown';
  const author =
    issue.user && typeof issue.user === 'object'
      ? sanitizeField((issue.user as Record<string, unknown>).login, 39)
      : '';
  const labels = Array.isArray(issue.labels)
    ? issue.labels
        .map((l) => (l && typeof l === 'object' ? (l as Record<string, unknown>).name : l))
        .filter((n): n is string => typeof n === 'string')
        .slice(0, 6)
        .map((n) => sanitizeField(n, 30))
        .join(', ')
    : '';
  const assigned =
    !!issue.assignee || (Array.isArray(issue.assignees) && issue.assignees.length > 0);
  const commentCount = typeof issue.comments === 'number' ? issue.comments : 0;

  // Maintainer replies early in a thread are where "here is where to look"
  // and "go ahead, it is yours" live, which is exactly the context a
  // beginner needs. GitHub returns comments oldest-first by default.
  let comments: string[] = [];
  if (commentCount > 0) {
    try {
      const cRes = await fetch(`${base}/comments?per_page=${MAX_ISSUE_COMMENTS}`, {
        headers: callerHeaders(ctx),
        signal: AbortSignal.timeout(10000),
      });
      if (cRes.ok) {
        const cRaw: unknown = await cRes.json();
        if (Array.isArray(cRaw)) {
          comments = cRaw
            .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
            .slice(0, MAX_ISSUE_COMMENTS)
            .map((c) => {
              const who =
                c.user && typeof c.user === 'object'
                  ? sanitizeField((c.user as Record<string, unknown>).login, 39)
                  : 'someone';
              return `- @${who}: ${sanitizeField(c.body, MAX_COMMENT_CHARS)}`;
            })
            .filter((line) => line.length > 6);
        }
      }
    } catch {
      // A comment thread we could not read is not a failed lookup; the issue
      // itself is the load-bearing part and we already have it.
    }
  }

  const header =
    `${repo}#${number} — ${kind}, ${state}${assigned ? ', already assigned' : ', unassigned'}\n` +
    `Title: ${title}\n` +
    (author ? `Opened by @${author}\n` : '') +
    (labels ? `Labels: ${labels}\n` : '') +
    `Link: https://github.com/${repo}/${isPR ? 'pull' : 'issues'}/${number}\n`;
  const commentBlock = comments.length
    ? `\nFirst ${comments.length} comment${comments.length > 1 ? 's' : ''} of ${commentCount}:\n${comments.join('\n')}`
    : '';

  // The body is trimmed last and to whatever room is left, so a long thread
  // never pushes the summary past the cap and silently truncates the tail —
  // which is where `ok()` would otherwise cut, mid-comment.
  const room = MAX_SUMMARY_CHARS - header.length - commentBlock.length - 40;
  const body = sanitizeBody(issue.body, Math.min(MAX_ISSUE_BODY_CHARS, Math.max(room, 0)));

  return ok(`${header}${body ? `\nDescription:\n${body}` : '\nNo description was given.'}${commentBlock}`);
}

/**
 * Repository comprehension, delegated to DeepWiki.
 *
 * The alternative — cloning and reading the repo ourselves — costs more
 * tokens than this deployment has in a day. See lib/deepwiki.ts.
 */
async function explainRepo(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {repo, question}.');
  // Several questions in one turn get shorter answers each, so asking three
  // narrow things costs roughly what asking one broad thing costs.
  const fannedOut = typeof ctx?.batchSize === 'number' && ctx.batchSize > 1;
  const result = await askRepo(args.repo, args.question, fannedOut ? FOCUSED_ANSWER_CHARS : undefined);
  if (result.ok) {
    return ok(
      `DeepWiki on ${normalizeRepoName(args.repo)}:\n${result.text}` +
        (result.truncated ? '\n[answer truncated]' : ''),
    );
  }
  // A repository DeepWiki has not indexed is a refusal, not a degraded
  // answer. Falling back to a GitHub-only guess would produce something that
  // sounds equally confident and is far less grounded.
  return fail(result.detail);
}

/** The documented topics DeepWiki holds for a repo: a table of contents. */
async function repoOverview(args: Record<string, unknown>): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {repo}.');
  const result = await repoTopics(args.repo);
  if (result.ok) return ok(`DeepWiki topics for ${normalizeRepoName(args.repo)}:\n${result.text}`);
  return fail(result.detail);
}

/** Web search, routed through the provider so we never fetch a URL ourselves. */
async function searchTheWeb(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {objective, queries}.');
  const result = await webSearch(args.objective, args.queries, ctx.sessionId || ctx.requestId);
  if (!result.ok) return fail(result.detail);
  return ok(`Web results:\n${result.text}${result.truncated ? '\n[truncated]' : ''}`);
}

/** Reads specific pages the student named or a search surfaced. */
async function readWebPages(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  if (!isArgsObject(args)) return fail('Invalid arguments: expected {urls}.');
  const result = await readUrls(args.urls, args.objective, ctx.sessionId || ctx.requestId);
  if (!result.ok) return fail(result.detail);
  return ok(`Page content:\n${result.text}${result.truncated ? '\n[truncated]' : ''}`);
}

export const TOOLS: ToolDef[] = [
  {
    name: 'get_my_standing',
    description:
      'Look up the signed-in caller on the leaderboard roster: tracked status, year/campus, and links to their profile and work-checker pages. Requires login.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    needsLogin: true,
    costsSearch: false,
    run: (args, ctx) => getMyStanding(args, ctx),
  },
  {
    name: 'explain_flag',
    description:
      'Check whether a PR "<owner>/<repo>#<number>" was flagged by admins and report the reason (fake, self_pr, low_quality) plus any admin note.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo as "<owner>/<repo>".' },
        number: { type: 'integer', description: 'PR number, positive integer.' },
      },
      required: ['repo', 'number'],
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: false,
    run: (args) => explainFlag(args),
  },
  {
    name: 'find_good_first_issues',
    description:
      'Search all of GitHub for open, unassigned good-first-issues, one per repository so the student gets five different projects (one Search API call). Optional language filter and limit (max 5).',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'Optional programming language filter.' },
        limit: { type: 'integer', minimum: 1, description: 'Optional max results; capped at 5.' },
      },
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: true,
    run: (args, ctx) => findGoodFirstIssues(args, ctx),
  },
  {
    name: 'lookup_contributor',
    description:
      'Look up one GitHub user by username: whether they are tracked on this leaderboard (with year/campus and profile links) plus their public GitHub stats (public_repos, followers). Use this whenever someone asks about a single GitHub account, including their own.',
    parameters: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'The GitHub username to look up.' },
      },
      required: ['username'],
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: false,
    run: (args, ctx) => lookupContributor(args, ctx),
  },
  {
    name: 'compare_contributors',
    description:
      'Compare 2-3 GitHub users: whether each is tracked on the leaderboard plus public_repos and followers counts. No private data is ever returned.',
    parameters: {
      type: 'object',
      properties: {
        usernames: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 3,
          description: '2-3 GitHub usernames to compare.',
        },
      },
      required: ['usernames'],
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: false,
    run: (args, ctx) => compareContributors(args, ctx),
  },
  {
    name: 'site_help',
    description:
      'Answer how-this-site-works questions for one topic: leaderboard, join, login, refresh, flagging, or contributing.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: [...SITE_TOPICS],
          description: 'Help topic to explain.',
        },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: false,
    run: (args) => siteHelp(args),
  },
  {
    name: 'find_repo_issues',
    description:
      'List open, unassigned, recently-active issues in ONE specific repository the user named. Use this whenever someone gives you a repo (owner/repo or a github.com link) and wants something to work on. Optional label filter such as "good first issue" or "bug".',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as "<owner>/<repo>" or a github.com URL.' },
        label: { type: 'string', description: 'Optional label filter, e.g. "good first issue".' },
        limit: { type: 'integer', minimum: 1, description: 'Optional max results; capped at 5.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: false,
    untrusted: true, // issue titles and labels are written by strangers
    run: (args, ctx) => findRepoIssues(args, ctx),
  },
  {
    name: 'read_issue',
    description:
      'Read ONE specific GitHub issue or pull request in full — its title, state, labels, description and first few comments. Call this first whenever the student links or names a specific issue or PR, before asking anything about the codebase: it tells you what the actual task is instead of leaving you to guess from the link.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description:
            'Repository as "<owner>/<repo>", or the full github.com issue/pull URL (the number is taken from it).',
        },
        number: {
          type: 'integer',
          minimum: 1,
          description: 'Issue or pull request number. Optional when the repo field is a full issue URL.',
        },
      },
      required: ['repo'],
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: false,
    untrusted: true, // an issue body is a public text box a stranger typed into
    run: (args, ctx) => readIssue(args, ctx),
  },
  {
    name: 'explain_repo',
    description:
      'Ask a grounded question about how a specific GitHub repository works — its architecture, where a feature lives, how to set it up, what a module does, or where to start on an issue. Backed by DeepWiki, which has already indexed most public repositories. Use this instead of guessing about unfamiliar code. Working a specific issue: ask two or three NARROW questions in the same turn rather than one broad one — several short answers beat one long one.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as "<owner>/<repo>" or a github.com URL.' },
        question: {
          type: 'string',
          description: 'A specific question about the repository, e.g. "where is routing handled?".',
        },
      },
      required: ['repo', 'question'],
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: false,
    untrusted: true, // third-party summary of a repo anyone can edit
    run: (args, ctx) => explainRepo(args, ctx),
  },
  {
    name: 'repo_overview',
    description:
      'List the documented topics DeepWiki holds for a repository — a table of contents for the codebase. Cheaper than explain_repo; good when the user has named a repo but has no specific question yet.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as "<owner>/<repo>" or a github.com URL.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: false,
    untrusted: true,
    run: (args) => repoOverview(args),
  },
  {
    name: 'web_search',
    description:
      'Search the live web and get back sources with short excerpts. Use for anything current or outside GitHub and this site: error messages, library documentation, how a tool works, what changed in a release, general "how do I" questions. Give 2-3 short keyword queries in one call rather than searching repeatedly.',
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'What you are trying to find out, in one sentence.',
        },
        queries: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 3,
          description: 'One to three keyword queries of 3-6 words each.',
        },
      },
      required: ['objective', 'queries'],
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: false,
    untrusted: true, // web pages are written by strangers
    run: (args, ctx) => searchTheWeb(args, ctx),
  },
  {
    name: 'read_url',
    description:
      'Read specific web pages when search excerpts are not enough — the student linked a page, or you need the actual wording of a doc. Pass up to 3 URLs. Prefer web_search first; only read a page when its excerpt was insufficient.',
    parameters: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 3,
          description: 'http(s) URLs to read.',
        },
        objective: {
          type: 'string',
          description: 'What to look for on those pages, in one sentence.',
        },
      },
      required: ['urls'],
      additionalProperties: false,
    },
    needsLogin: false,
    costsSearch: false,
    untrusted: true,
    run: (args, ctx) => readWebPages(args, ctx),
  },
];

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolSchemasForModel(
  allowedNames: string[],
): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  if (!Array.isArray(allowedNames)) return [];
  const allowed = new Set(allowedNames);
  return TOOLS.filter((t) => allowed.has(t.name)).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function guestAllowedTools(): string[] {
  return TOOLS.filter((t) => !t.needsLogin).map((t) => t.name);
}
