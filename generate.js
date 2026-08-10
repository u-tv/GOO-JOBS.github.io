import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");
const JOBS_DIR = path.join(PUBLIC, "job");
const DATA_FILE = path.join(PUBLIC, "jobs.json");

const SITE_URL = (
  process.env.SITE_URL || "https://goojobs.vercel.app"
).replace(//+$/, "");

const TARGET_JOBS = Number(process.env.TARGET_JOBS || 5000);
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 30);
const TIMEOUT = 20000;

await fs.mkdir(PUBLIC, { recursive: true });
await fs.mkdir(JOBS_DIR, { recursive: true });

function clean(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

function stripHtml(value) {
  return clean(value)
    .replace(/<script[sS]*?</script>/gi, " ")
    .replace(/<style[sS]*?</style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/s+/g, " ")
    .trim();
}

function safeUrl(value) {
  try {
    const url = new URL(clean(value));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function isoDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function slugify(title, id) {
  const slug = clean(title, "job")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${slug || "job"}-${String(id).replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function html(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "GOO-JOBS-Daily-Sync/1.0",
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalize(job) {
  const title = clean(job.title, "Remote Job");
  const company = clean(job.company, "Company");
  const applyUrl = safeUrl(job.applyUrl);

  if (!job.id || !applyUrl) return null;

  return {
    id: clean(job.id),
    title,
    company,
    salary: clean(job.salary, "Not disclosed"),
    description: stripHtml(job.description).slice(0, 5000),
    applyUrl,
    source: clean(job.source, "Unknown"),
    sourceUrl: safeUrl(job.sourceUrl) || applyUrl,
    category: clean(job.category, "General"),
    skills: clean(job.skills, "General"),
    location: clean(job.location, "Remote"),
    type: clean(job.type, "FULL_TIME"),
    posted: isoDate(job.posted),
    collectedAt: new Date().toISOString()
  };
}

async function fetchMusePage(page) {
  const apiKey = process.env.MUSE_API_KEY;
  if (!apiKey) return [];

  const url = new URL("https://www.themuse.com/api/public/jobs");
  url.searchParams.set("page", String(page));
  url.searchParams.set("api_key", apiKey);

  const data = await request(url);
  const results = Array.isArray(data.results) ? data.results : [];

  return results
    .map((job) =>
      normalize({
        id: `muse-${job.id}`,
        title: job.name,
        company: job.company?.name,
        description: job.contents,
        applyUrl: job.refs?.landing_page,
        source: "The Muse",
        sourceUrl: job.refs?.landing_page,
        category: job.categories?.map((x) => x.name).join(", "),
        skills: job.categories?.map((x) => x.name).join(", "),
        location: job.locations?.map((x) => x.name).join(", "),
        type: job.type,
        posted: job.publication_date
      })
    )
    .filter(Boolean);
}

async function fetchMuse() {
  if (!process.env.MUSE_API_KEY) {
    console.warn("MUSE_API_KEY missing; The Muse skipped");
    return [];
  }

  const output = [];

  for (let page = 0; page < 250 && output.length < TARGET_JOBS; page++) {
    try {
      const jobs = await fetchMusePage(page);
      if (!jobs.length) break;
      output.push(...jobs);
    } catch (error) {
      console.warn(`The Muse page ${page} failed: ${error.message}`);
      break;
    }
  }

  return output;
}

async function fetchRemoteJobsPage(offset) {
  const url = new URL("https://remotejobs.org/api/v1/jobs");
  url.searchParams.set("limit", "50");
  url.searchParams.set("offset", String(offset));

  const data = await request(url);
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data.jobs)
      ? data.jobs
      : Array.isArray(data.results)
        ? data.results
        : [];

  return rows
    .map((job) =>
      normalize({
        id: `remotejobs-${job.id || job.slug || job.url}`,
        title: job.title || job.position,
        company: job.company_name || job.company,
        description: job.description || job.excerpt,
        applyUrl: job.url || job.apply_url,
        source: "RemoteJobs.org",
        sourceUrl: job.url || job.apply_url,
        category: job.category,
        skills: Array.isArray(job.tags) ? job.tags.join(", ") : job.tags,
        location: job.location || "Remote",
        type: job.job_type || job.type,
        posted: job.created_at || job.date
      })
    )
    .filter(Boolean);
}

async function fetchRemoteJobs() {
  const output = [];

  for (let offset = 0; offset < 25000 && output.length < TARGET_JOBS; offset += 50) {
    try {
      const jobs = await fetchRemoteJobsPage(offset);
      if (!jobs.length) break;
      output.push(...jobs);
    } catch (error) {
      console.warn(`RemoteJobs offset ${offset} failed: ${error.message}`);
      break;
    }
  }

  return output;
}

async function fetchJobicy() {
  try {
    const data = await request(
      "https://jobicy.com/api/v2/remote-jobs?count=50"
    );

    return (data.jobs || [])
      .map((job) =>
        normalize({
          id: `jobicy-${job.id}`,
          title: job.jobTitle,
          company: job.companyName,
          salary:
            job.salaryMin && job.salaryMax
              ? `${job.salaryMin}-${job.salaryMax}`
              : "Not disclosed",
          description: job.jobDescription,
          applyUrl: job.url,
          source: "Jobicy",
          sourceUrl: job.url,
          category: job.jobIndustry,
          skills: job.jobIndustry,
          location: job.jobGeo || "Remote",
          type: job.jobType,
          posted: job.pubDate
        })
      )
      .filter(Boolean);
  } catch (error) {
    console.warn(`Jobicy failed: ${error.message}`);
    return [];
  }
}

async function fetchRemotive() {
  try {
    const data = await request(
      "https://remotive.com/api/remote-jobs?limit=100&page=1"
    );

    return (data.jobs || [])
      .map((job) =>
        normalize({
          id: `remotive-${job.id}`,
          title: job.title,
          company: job.company_name,
          salary: job.salary,
          description: job.description,
          applyUrl: job.url,
          source: "Remotive",
          sourceUrl: job.url,
          category: job.category,
          skills: job.tags,
          location: job.candidate_required_location,
          type: job.job_type,
          posted: job.publication_date
        })
      )
      .filter(Boolean);
  } catch (error) {
    console.warn(`Remotive failed: ${error.message}`);
    return [];
  }
}

async function readPrevious() {
  try {
    const data = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

function removeDuplicates(jobs) {
  const map = new Map();

  for (const job of jobs) {
    const key = `${job.title}|${job.company}|${job.applyUrl}`
      .toLowerCase()
      .replace(/s+/g, " ")
      .trim();

    if (!map.has(key)) map.set(key, job);
  }

  return [...map.values()];
}

function keepRecent(jobs) {
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;

  return jobs.filter((job) => {
    const time = new Date(job.posted).getTime();
    return Number.isNaN(time) || time >= cutoff;
  });
}

async function generatePage(job) {
  const slug = slugify(job.title, job.id);
  const directory = path.join(JOBS_DIR, slug);

  await fs.mkdir(directory, { recursive: true });

  const url = `${SITE_URL}/job/${slug}/`;

  const schema = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description: job.description || `${job.title} at ${job.company}`,
    datePosted: job.posted.slice(0, 10),
    employmentType: job.type.toUpperCase().replace(/[^A-Z_]/g, "_"),
    hiringOrganization: {
      "@type": "Organization",
      name: job.company
    },
    jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: {
      "@type": "Country",
      name: "Worldwide"
    },
    url
  };

  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(job.title)} at ${html(job.company)} | GOO JOBS</title>
<meta name="description" content="${html((job.description || "").slice(0, 160))}">
<link rel="canonical" href="${html(url)}">
<script type="application/ld+json">${json(schema)}</script>
<style>
body{margin:0;background:#eff6ff;font-family:system-ui;color:#0f172a}
main{max-width:850px;margin:40px auto;padding:16px}
article{background:#fff;padding:32px;border-radius:24px;box-shadow:0 15px 45px #0002}
h1{font-size:clamp(28px,5vw,48px)}
.company{color:#2563eb;font-size:22px;font-weight:700}
.meta{line-height:2;color:#475569}
.description{line-height:1.8;white-space:pre-line}
.apply{display:inline-block;background:#2563eb;color:#fff;padding:14px 24px;border-radius:999px;text-decoration:none;font-weight:700;margin:20px 0}
a{color:#2563eb}
</style>
</head>
<body>
<main><article>
<h1>${html(job.title)}</h1>
<p class="company">🏢 ${html(job.company)}</p>
<div class="meta">
<p>📍 ${html(job.location)}</p>
<p>🛠 ${html(job.skills)}</p>
<p>💰 ${html(job.salary)}</p>
<p>📅 ${html(job.posted.slice(0, 10))}</p>
<p>🔎 ${html(job.source)}</p>
</div>
<p class="description">${html(job.description)}</p>
<a class="apply" href="${html(job.applyUrl)}" target="_blank" rel="nofollow noopener noreferrer">Apply Now →</a>
<p><a href="${SITE_URL}/">← All jobs</a></p>
</article></main>
</body>
</html>`;

  await fs.writeFile(path.join(directory, "index.html"), page);
  return { ...job, slug, url };
}

async function generateFiles(jobs) {
  const pages = [];

  for (const job of jobs) {
    pages.push(await generatePage(job));
  }

  await fs.writeFile(
    DATA_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: pages.length,
        jobs: pages
      },
      null,
      2
    )
  );

  const urls = [
    `<url><loc>${SITE_URL}/</loc><lastmod>${new Date()
      .toISOString()
      .slice(0, 10)}</lastmod><priority>1</priority></url>`,
    ...pages.map(
      (job) =>
        `<url><loc>${job.url}</loc><lastmod>${new Date()
          .toISOString()
          .slice(0, 10)}</lastmod><priority>0.8</priority></url>`
    )
  ].join("");

  await fs.writeFile(
    path.join(PUBLIC, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`
  );

  await fs.writeFile(
    path.join(PUBLIC, "robots.txt"),
    `User-agent: *
Allow: /
Sitemap: ${SITE_URL}/sitemap.xml
`
  );

  try {
    await fs.copyFile(path.join(ROOT, "index.html"), path.join(PUBLIC, "index.html"));
  } catch {
    await fs.writeFile(
      path.join(PUBLIC, "index.html"),
      "<!doctype html><html><body><h1>GOO JOBS</h1><script>fetch('/jobs.json').then(r=>r.json()).then(console.log)</script></body></html>"
    );
  }

  return pages;
}

async function main() {
  console.log("Starting real-job sync...");

  const [muse, remoteJobs, jobicy, remotive] = await Promise.all([
    fetchMuse(),
    fetchRemoteJobs(),
    fetchJobicy(),
    fetchRemotive()
  ]);

  const fresh = removeDuplicates([
    ...muse,
    ...remoteJobs,
    ...jobicy,
    ...remotive
  ]);

  console.log(`Fresh real jobs received: ${fresh.length}`);

  const previous = await readPrevious();
  const merged = keepRecent(removeDuplicates([...fresh, ...previous])).slice(
    0,
    TARGET_JOBS
  );

  if (!merged.length) {
    throw new Error("No real jobs available; previous data was not overwritten.");
  }

  const pages = await generateFiles(merged);

  console.log(`Published ${pages.length} real jobs`);
  console.log(`Target capacity: ${TARGET_JOBS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
