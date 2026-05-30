const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------
const SITE_URL = 'https://goojobs.vercel.app';  // Change to your domain
const JOBS_COUNT = 1020;                       // How many jobs to generate
const OUTPUT_DIR = '.';                        // Root directory

// ---------- Helper: Generate realistic job data ----------
const JOB_TITLES = [
  "Remote Data Entry Specialist", "Virtual Assistant for E‑commerce", "Online Tutor – English & Math",
  "Social Media Manager (Remote)", "Freelance Content Writer", "Customer Support Agent (WFH)",
  "Medical Transcriptionist", "Search Engine Evaluator", "Remote Graphic Designer",
  "IT Helpdesk Support (Remote)", "Sales Representative (Home Based)", "Project Coordinator (Remote)",
  "Digital Marketing Assistant", "HR Recruiter (Work from Home)", "Accounting Clerk (Remote)",
  "Web Developer (Entry Level)", "SEO Specialist", "App Tester (Remote)", "Data Analyst (Remote)",
  "Translator (Hindi/English)"
];
const COMPANIES = ["TechSolutions", "Global Remote", "WorkAnywhere", "HomeBase Inc.", "CloudWorks", "VirtualStaff", "RemoteFirst", "GoHire", "JobNet", "FreelanceHub"];
const SALARY_RANGES = ["₹15,000 – ₹25,000", "₹25,000 – ₹35,000", "₹35,000 – ₹50,000", "₹50,000 – ₹70,000", "₹70,000+"];
const SKILLS_LIST = [
  "Communication, Time Management", "Excel, Data Entry", "Social Media, Content Creation",
  "Customer Service, CRM", "Writing, SEO", "English, Grammar", "Programming, HTML/CSS", "Analytics, Reporting"
];

function generateJob(index) {
  const title = JOB_TITLES[index % JOB_TITLES.length] + (index > 500 ? " (Urgent)" : "");
  const company = COMPANIES[Math.floor(Math.random() * COMPANIES.length)] + " " + (Math.floor(Math.random() * 100) + 1);
  const salary = SALARY_RANGES[Math.floor(Math.random() * SALARY_RANGES.length)];
  const skills = SKILLS_LIST[Math.floor(Math.random() * SKILLS_LIST.length)];
  const postedDate = new Date().toISOString().split('T')[0];
  const description = `${title} – This is a genuine work‑from‑home opportunity. You will handle daily tasks, collaborate with international teams, and enjoy flexible hours. Full training provided. Requirements: ${skills}, own laptop, stable internet. Benefits: performance bonus, paid leave, career growth. This role has been verified by GOO JOBS – thousands of candidates have already been placed.`;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + index;
  return {
    id: index,
    slug,
    title,
    company,
    description,
    salary,
    skills,
    applyUrl: `${SITE_URL}/apply/${slug}`,
    postedDate,
    source: "GOO JOBS",
    rawDate: Date.now() - (index * 3600000)
  };
}

// ---------- Generate all jobs ----------
const jobs = [];
for (let i = 1; i <= JOBS_COUNT; i++) {
  jobs.push(generateJob(i));
}
console.log(`✅ Generated ${jobs.length} jobs.`);

// ---------- Ensure output directories ----------
if (!fs.existsSync(path.join(OUTPUT_DIR, 'job'))) {
  fs.mkdirSync(path.join(OUTPUT_DIR, 'job'), { recursive: true });
}

// ---------- Generate individual job pages ----------
for (const job of jobs) {
  const jobDir = path.join(OUTPUT_DIR, 'job', job.slug);
  if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
  const metaDesc = job.description.substring(0, 160);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${job.title} at ${job.company} | GOO JOBS</title>
  <meta name="description" content="${metaDesc}">
  <meta name="keywords" content="${job.title.toLowerCase()}, remote job, work from home, ${job.skills.toLowerCase()}">
  <link rel="canonical" href="${SITE_URL}/job/${job.slug}/">
  <meta property="og:title" content="${job.title}">
  <meta property="og:description" content="${metaDesc}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${SITE_URL}/job/${job.slug}/">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${job.title}">
  <meta name="twitter:description" content="${metaDesc}">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": "${job.title}",
    "description": "${job.description.replace(/"/g, '\\"')}",
    "datePosted": "${job.postedDate}",
    "employmentType": "FULL_TIME",
    "hiringOrganization": {
      "@type": "Organization",
      "name": "${job.company}",
      "sameAs": "${SITE_URL}"
    },
    "jobLocation": {
      "@type": "Place",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Remote",
        "addressCountry": "India"
      }
    },
    "baseSalary": {
      "@type": "MonetaryAmount",
      "currency": "INR",
      "value": {
        "@type": "QuantitativeValue",
        "minValue": ${parseInt(job.salary.match(/\\d+/)?.[0] || 15000)},
        "maxValue": ${parseInt(job.salary.match(/(\\d+)(?!.*\\d)/)?.[0] || 70000)},
        "unitText": "MONTH"
      }
    }
  }
  </script>
  <style>
    body { font-family: system-ui, sans-serif; background: #f1f5f9; margin: 0; padding: 20px; line-height: 1.5; }
    .container { max-width: 800px; margin: auto; background: white; border-radius: 24px; padding: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
    h1 { color: #1e293b; font-size: 1.8rem; margin-bottom: 8px; }
    .company { color: #2563eb; font-size: 1.2rem; margin-bottom: 12px; }
    .salary { background: #e2e8f0; display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 0.9rem; margin: 12px 0; }
    .skills { margin: 20px 0; }
    .btn { background: #2563eb; color: white; padding: 10px 24px; border-radius: 40px; text-decoration: none; display: inline-block; font-weight: bold; margin-top: 20px; }
    .footer { margin-top: 40px; font-size: 0.8rem; color: #64748b; text-align: center; }
    @media (max-width: 640px) { .container { padding: 20px; } h1 { font-size: 1.4rem; } }
  </style>
</head>
<body>
<div class="container">
  <h1>${job.title}</h1>
  <div class="company">🏢 ${job.company}</div>
  <div class="salary">💰 ${job.salary} / month</div>
  <div class="skills"><strong>🔧 Required skills:</strong> ${job.skills}</div>
  <p>${job.description}</p>
  <p><strong>📅 Posted:</strong> ${job.postedDate}</p>
  <a href="${job.applyUrl}" class="btn" target="_blank">Apply Now →</a>
  <div class="footer">© GOO JOBS – Trusted by 10,000+ job seekers</div>
</div>
</body>
</html>`;
  fs.writeFileSync(path.join(jobDir, 'index.html'), html);
  console.log(`📄 Generated: /job/${job.slug}/`);
}

// ---------- Generate sitemap.xml ----------
let sitemapUrls = `<url><loc>${SITE_URL}/</loc><lastmod>${new Date().toISOString().split('T')[0]}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`;
for (const job of jobs) {
  sitemapUrls += `
  <url>
    <loc>${SITE_URL}/job/${job.slug}/</loc>
    <lastmod>${job.postedDate}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
}
const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls}
</urlset>`;
fs.writeFileSync(path.join(OUTPUT_DIR, 'sitemap.xml'), sitemapXml);
console.log('🗺️ Generated: sitemap.xml');

// ---------- Generate robots.txt ----------
const robotsTxt = `User-agent: *
Allow: /
Sitemap: ${SITE_URL}/sitemap.xml`;
fs.writeFileSync(path.join(OUTPUT_DIR, 'robots.txt'), robotsTxt);
console.log('🤖 Generated: robots.txt');

// ---------- Generate a new homepage (index.html) with links to static job pages ----------
let jobCards = '';
for (const job of jobs.slice(0, 100)) { // Show first 100 on homepage (pagination can be added later)
  jobCards += `
  <div class="job-card">
    <h3><a href="/job/${job.slug}/">${job.title}</a></h3>
    <p class="company">${job.company} • 🌍 Remote</p>
    <p class="salary">${job.salary}</p>
    <p class="skills">${job.skills}</p>
    <a href="/job/${job.slug}/" class="details-link">View Details →</a>
  </div>`;
}
const homeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GOO JOBS – 1000+ Remote Home‑Based Jobs</title>
  <meta name="description" content="Find 1000+ genuine work‑from‑home jobs. Daily updated, zero‑competition keywords. Apply now and start earning from home.">
  <link rel="canonical" href="${SITE_URL}/">
  <link rel="sitemap" type="application/xml" href="/sitemap.xml">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: system-ui, sans-serif; }
    body { background: #f8fafc; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { background: linear-gradient(135deg, #e50914, #ffc107, #2563eb); background-clip: text; -webkit-background-clip: text; color: transparent; font-size: 2.5rem; margin-bottom: 10px; }
    .sub { text-align: center; margin-bottom: 30px; color: #475569; }
    .jobs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 24px; }
    .job-card { background: white; border-radius: 20px; padding: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); transition: 0.2s; border: 1px solid #e2e8f0; }
    .job-card:hover { transform: translateY(-3px); box-shadow: 0 12px 20px rgba(0,0,0,0.1); }
    .job-card h3 a { color: #1e293b; text-decoration: none; font-size: 1.2rem; font-weight: 700; }
    .job-card h3 a:hover { color: #2563eb; }
    .company { color: #64748b; font-size: 0.9rem; margin: 8px 0; }
    .salary { color: #10b981; font-weight: 600; margin: 8px 0; }
    .skills { color: #475569; font-size: 0.85rem; margin: 8px 0; }
    .details-link { display: inline-block; margin-top: 12px; background: #2563eb; color: white; padding: 6px 16px; border-radius: 30px; text-decoration: none; font-size: 0.8rem; font-weight: 500; }
    .details-link:hover { background: #1d4ed8; }
    .pagination { margin-top: 40px; text-align: center; }
    footer { text-align: center; margin-top: 60px; padding: 20px; border-top: 1px solid #e2e8f0; color: #64748b; }
    @media (max-width: 700px) { .jobs-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<div class="container">
  <h1 style="text-align:center;">GOO JOBS</h1>
  <p class="sub">🔍 1000+ verified home‑based jobs • Updated daily</p>
  <div class="jobs-grid">
    ${jobCards}
  </div>
  <div class="pagination">
    <a href="#" style="text-decoration:underline;">Page 1</a> | <a href="#">Page 2</a> | <a href="#">Page 3</a> ...
  </div>
  <footer>© 2025 GOO JOBS – Real jobs, real reviews, instant apply</footer>
</div>
</body>
</html>`;
fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), homeHtml);
console.log('🏠 Generated: index.html (homepage with static links)');

console.log('\n✨ All done! Deploy the entire folder to your hosting (Cloudflare Pages / Netlify).');
console.log('🔗 Each job has its own URL and full SEO meta tags.');
