import fs from "fs";
import { exec, execSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import OpenAI from "openai";

const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const repo = { owner: process.env.REPO_OWNER, repo: process.env.REPO_NAME };
const prNumber = Number(process.env.PR_NUMBER);
const comment = process.env.COMMENT_BODY || "";
const actor = process.env.ACTOR || "unknown";

function log(m){ console.log(`[gpt-pr-bot] ${m}`); }
function run(cmd){
  return new Promise((res, rej)=>{
    exec(cmd, { maxBuffer: 1024*1024*10 }, (e, out, err)=>{
      if (out) process.stdout.write(out);
      if (err) process.stderr.write(err);
      e ? rej(e) : res();
    });
  });
}
function runOut(cmd){ return execSync(cmd, { encoding: "utf8", stdio: ["ignore","pipe","pipe"] }); }
function listFiles(){ return runOut("git ls-files").split("\n").filter(Boolean).slice(0,200); }
function sampleContext(files){
  const picks = files.filter(p => !p.match(/(^\.|node_modules|dist|build|lock)/)).slice(0,12);
  return picks.map(p => {
    const txt = fs.readFileSync(p, "utf8");
    const head = txt.split("\n").slice(0,30).join("\n");
    return `--- ${p} ---\n${head}\n`;
  }).join("\n");
}
function ensureDir(path){ const d = path.split("/").slice(0,-1).join("/"); if (d && !fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function truncate(s,n){ return s.length>n ? s.slice(0,n-1)+"…" : s; }
function renderBody(task, applied, plan){
  const list = applied.map(a => `- \`${a.path}\` (${a.op}) — ${a.why||""}`).join("\n");
  return [
    `Task: ${task}`,
    ``,
    `Applied changes:`,
    list,
    ``,
    `<details><summary>Raw plan</summary>`,
    "```json",
    JSON.stringify(plan,null,2),
    "```",
    `</details>`
  ].join("\n");
}
async function commentOnPR(body){ await octo.issues.createComment({ ...repo, issue_number: prNumber, body }); }

async function main(){
  const task = comment.replace(/^\/gpt\s+/i, "").trim();
  if (!task) return log("No task after /gpt");

  const { data: pr } = await octo.pulls.get({ ...repo, pull_number: prNumber });
  const headRef = pr.head.ref;
  const sha = pr.head.sha.slice(0,7);
  const workBranch = `gpt/${sha}-${Date.now().toString(36)}`;

  await run(`git config user.name "gpt-pr-bot"`);
  await run(`git config user.email "actions@users.noreply.github.com"`);
  await run(`git checkout -b ${workBranch}`);

  const files = listFiles();
  const context = sampleContext(files);

  const system = `You are a careful repo editor. Output STRICT JSON with a "changes" array.
Each change is:
{ "path": "<relative path>", "operation": "append|replace|create",
  "find": "<exact text to replace (for replace)>",
  "content": "<text to insert/append or replacement>",
  "why": "<1 sentence rationale>" }
Rules:
- Edit max 5 files, max 500 lines total.
- Never touch lockfiles or secrets.
- Be surgical; small diffs.`;

  const user = `Task from @${actor}: ${task}

Repository context (partial):
${context}

Return ONLY JSON.`;

  const chat = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.2
  });

  const raw = chat.choices?.[0]?.message?.content || "{}";
  let plan; try { plan = JSON.parse(raw); }
  catch { return commentOnPR(`I couldn't parse a valid plan.\n\n\`\`\`json\n${raw}\n\`\`\``); }

  if (!Array.isArray(plan.changes) || plan.changes.length === 0)
    return commentOnPR("No safe changes proposed. (Ambiguous or no-op.)");

  const applied = [];
  for (const c of plan.changes) {
    const p = c.path;
    if (!p || p.startsWith(".git") || p.length>200) continue;

    if (c.operation === "create") {
      ensureDir(p); fs.writeFileSync(p, c.content ?? "", "utf8");
      applied.push({ path: p, op: "create", why: c.why });
    } else if (c.operation === "append") {
      if (!fs.existsSync(p)) continue;
      fs.appendFileSync(p, "\n" + (c.content ?? ""), "utf8");
      applied.push({ path: p, op: "append", why: c.why });
    } else if (c.operation === "replace") {
      if (!fs.existsSync(p) || !c.find) continue;
      const old = fs.readFileSync(p, "utf8");
      if (!old.includes(c.find)) continue;
      fs.writeFileSync(p, old.replace(c.find, c.content ?? ""), "utf8");
      applied.push({ path: p, op: "replace", why: c.why });
    }
  }
  if (applied.length === 0) return commentOnPR("Plan produced no applicable edits.");

  await run(`git add -A`);
  await run(`git commit -m "gpt: ${truncate(task,72)}"`);
  await run(`git push --set-upstream origin ${workBranch}`);

  const { data: childPR } = await octo.pulls.create({
    ...repo, head: workBranch, base: headRef,
    title: `gpt: ${truncate(task,60)}`, body: renderBody(task, applied, plan)
  });
  await commentOnPR(`Created helper PR #${childPR.number} with ${applied.length} change(s). Review & merge into your PR.`);
}
main().catch(e => { console.error(e); process.exit(0); });
