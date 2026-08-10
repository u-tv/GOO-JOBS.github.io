import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");
const JOB_DIR = path.join(PUBLIC_DIR, "job");
const DATA_FILE = path.join(PUBLIC_DIR, "jobs.json");

const SITE_URL = (
  process.env.SITE_URL || "https://goojobs.vercel.app"
).replace(//+$/, "");

const TARGET_JOBS = Number(process.env.TARGET_JOBS || 5000);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 45);
const API_LIMIT = Number(process.env.INDIAN_API_LIMIT || 5000);

await fs.mkdir(PUBLIC_DIR, { recursive: true });
await fs.mkdir(JOB_DIR, { recursive: true });

function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

function stripHtml(value) {
  return text(value)
    .replace(/<script[sS]*?</script>/gi, " ")
    .replace(/<style[sS]*?</style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/s+/g, " ")
    .trim();
}

function safeUrl(value) {
  try {
    const url = new URL(text(value));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function isoDate(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString();
}

function html(value) {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slugify(title, id) {
  const slug = text(title, "job")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

  return `${slug || "job"}-${String(id).replace(
    /[^a-zA-Z0-9_-]/g,
    ""
  )}`;
}

async function fetchIndianJobs() {
  const apiKey = process.env.INDIAN_API_KEY;

  if (!apiKey) {
    throw new Error("INDIAN_API_KEY GitHub Secret में missing है");
  }

  const url = new URL("https://jobs.indianapi.in/jobs");
  url.searchParams.set("limit", String(API_LIMIT));

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Api-Key": apiKey,
      "User-Agent": "GOO-JOBS/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`IndianAPI failed: ${response.status}`);
  }

  const data = await response.json();

  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data.jobs)
      ? data.jobs
      : Array.isArray(data.results)
        ? data.results
        : [];

  return rows
    .map((job) => {
      const applyUrl = safeUrl(
        job.apply_link || job.apply_url || job.url || job.link
      );

      const id = text(
        job.id || job.job_id || applyUrl
      );

      if (!id || !applyUrl) return null;

      return {
        id: `indianapi-${id}`,
        title: text(job.title || job.job_title, "Indian Job"),
        company: text(job.company || job.company_name, "Company"),
        description: stripHtml(
          job.job_description ||
            job.description ||
            job.role_and_responsibility ||
            job.about_company
        ).slice(0, 5000),
        salary: text(
          job.salary || job.salary_range,
          "Not disclosed"
        ),
        location: text(job.location, "India"),
        experience: text(job.experience, "Not specified"),
        skills: text(
          job.education_and_skills || job.skills,
          "General"
        ),
        category: text(job.category || job.industry, "General"),
        type: text(job.job_type, "Full Time"),
        posted: isoDate(job.posted_date || job.created_at),
        applyUrl,
        source: "IndianAPI",
        sourceUrl: applyUrl,
        collectedAt: new Date().toISOString()
      };
    })
    .filter(Boolean);
}

async function readPreviousJobs() {
  try {
    const data = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

function deduplicate(jobs) {
  const map = new Map();

  for (const job of jobs) {
    const key = (
      job.applyUrl ||
      `${job.title}|${job.company}|${job.location}`
    )
      .toLowerCase()
      .trim();

    if (!map.has(key)) map.set(key, job);
  }

  return [...map.values()];
}

function removeExpired(jobs) {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;

  return jobs.filter((job) => {
    const timestamp = new Date(job.posted).getTime();

    if (Number.isNaN(timestamp)) return true;
    return timestamp >= cutoff;
  });
}

async function createJobPage(job) {
  const slug = slugify(job.title, job.id);
  const directory = path.join(JOB_DIR, slug);
  const url = `${SITE_URL}/job/${slug}/`;

  await fs.mkdir(directory, { recursive: true });

  const schema = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description: job.description || `${job.title} at ${job.company}`,
    datePosted: job.posted.slice(0, 10),
    hiringOrganization: {
      "@type": "Organization",
      name: job.company
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressCountry: "IN"
      }
    },
    url,
    sameAs: job.applyUrl
  };

  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(job.title)} at ${html(job.company)} | GOO JOBS</title>
<meta name="description" content="${html(
    job.description.slice(0, 160)
  )}">
<link rel="canonical" href="${html(url)}">
<script type="application/ld+json">${JSON.stringify(schema).replace(
    /</g,
    "\\u003c"
  )}</script>
<style>
body{margin:0;background:#eff6ff;font-family:system-ui;color:#0f172a}
main{max-width:850px;margin:40px auto;padding:16px}
article{background:#fff;border-radius:24px;padding:32px;box-shadow:0 15px 45px #0002}
h1{font-size:clamp(28px,5vw,48px)}
.company{color:#2563eb;font-size:22px;font-weight:700}
.meta{line-height:2;color:#475569}
.description{line-height:1.8;white-space:pre-line}
.apply{display:inline-block;margin:20px 0;padding:14px 24px;border-radius:999px;background:#2563eb;color:white;text-decoration:none;font-weight:700}
a{color:#2563eb}
</style>
</head>
<body>
<main>
<article>
<h1>${html(job.title)}</h1>
<p class="company">🏢 ${html(job.company)}</p>
<div class="meta">
<p>📍 ${html(job.location)}</p>
<p>🛠 ${html(job.skills)}</p>
<p>💼 ${html(job.experience)}</p>
<p>💰 ${html(job.salary)}</p>
<p>📅 ${html(job.posted.slice(0, 10))}</p>
<p>🔎 ${html(job.source)}</p>
</div>
<p class="description">${html(job.description)}</p>
<a class="apply" href="${html(
    job.applyUrl
  )}" target="_blank" rel="nofollow noopener noreferrer">Apply Now →</a>
<p><a href="${SITE_URL}/">← All jobs</a></p>
</article>
</main>
</body>
</html>`;

  await fs.writeFile(
    path.join(directory, "index.html"),
    page,
    "utf8"
  );

  return {
    ...job,
    slug,
    url
  };
}

async function buildSite(jobs) {
  const pages = [];

  for (const job of jobs) {
    pages.push(await createJobPage(job));
  }

  await fs.writeFile(
    path.join(PUBLIC_DIR, "jobs.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: pages.length,
        jobs: pages
      },
      null,
      2
    ),
    "utf8"
  );

  const today = new Date().toISOString().slice(0, 10);

  const urls = [
    `<url><loc>${SITE_URL}/</loc><lastmod>${today}</lastmod><priority>1</priority></url>`,
    ...pages.map(
      (job) =>
        `<url><loc>${job.url}</loc><lastmod>${today}</lastmod><priority>0.8</priority></url>`
    )
  ].join("");

  await fs.writeFile(
    path.join(PUBLIC_DIR, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    "utf8"
  );

  await fs.writeFile(
    path.join(PUBLIC_DIR, "robots.txt"),
    `User-agent: *
Allow: /
Sitemap: ${SITE_URL}/sitemap.xml
`,
    "utf8"
  );

  try {
    await fs.copyFile(
      path.join(ROOT, "index.html"),
      path.join(PUBLIC_DIR, "index.html")
    );
  } catch {
    await fs.writeFile(
      path.join(PUBLIC_DIR, "index.html"),
      "<h1>GOO JOBS</h1><p>Open jobs.json to view listings.</p>",
      "utf8"
    );
  }

  console.log(`Published ${pages.length} real Indian jobs`);
}

async function main() {
  const fresh = await fetchIndianJobs();
  const previous = await readPreviousJobs();

  const jobs = removeExpired(
    deduplicate([...fresh, ...previous])
  )
    .sort((a, b) => new Date(b.posted) - new Date(a.posted))
    .slice(0, TARGET_JOBS);

  if (!jobs.length) {
    throw new Error(
      "No real jobs found. Existing jobs.json was not overwritten."
    );
  }

  await buildSite(jobs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
