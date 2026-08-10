#!/usr/bin/env node
/**
 * GOO JOBS — FINAL ADVANCED AUTO-SYNC ENGINE
 * ==========================================
 *
 * Real jobs only • No dummy jobs • No fake fallback jobs
 * Multi-source aggregation • Automatic deduplication
 * Greenhouse • Lever • Arbeitnow • Remotive • RSS
 * NCS/India sources when publicly accessible
 * Optional API sources
 *
 * Node.js 20+
 *
 * RUN:
 *   node generate.js
 *
 * ENV:
 *   TARGET_JOBS=5000
 *   RETENTION_DAYS=45
 *
 * IMPORTANT:
 * A target of 5000 means "keep up to 5000 verified current jobs".
 * It does NOT manufacture jobs when the live sources contain fewer.
 */

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

// ============================================================
// CONFIG
// ============================================================

const ROOT = path.resolve(__dirname);
const PUBLIC = path.join(ROOT, 'public');
const JOB_DIR = path.join(PUBLIC, 'job');
const LOG_DIR = path.join(ROOT, 'logs');
const CACHE_DIR = path.join(ROOT, '.cache');

const SITE_URL =
  (process.env.SITE_URL || 'https://goojobs.in').replace(/\/+$/, '');

const TARGET_JOBS = Math.max(
  1,
  Number.parseInt(process.env.TARGET_JOBS || '5000', 10)
);

const RETENTION_DAYS = Math.max(
  1,
  Number.parseInt(process.env.RETENTION_DAYS || '45', 10)
);

const TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.TIMEOUT_MS || '30000', 10)
);

const MAX_RETRIES = Math.max(
  1,
  Number.parseInt(process.env.MAX_RETRIES || '4', 10)
);

const CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.CONCURRENCY || '8', 10)
);

const CACHE_TTL_MS = Math.max(
  0,
  Number.parseInt(process.env.CACHE_TTL_MS || '300000', 10)
);

const ARBEIT_PAGES = Math.max(
  1,
  Number.parseInt(process.env.ARBEIT_PAGES || '50', 10)
);

const HEALTH_PORT = Number.parseInt(
  process.env.HEALTH_CHECK_PORT || '0',
  10
);

const BLACKLISTED_DOMAINS = (process.env.BLACKLISTED_DOMAINS || '')
  .split(',')
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

const GREENHOUSE_BOARDS = (
  process.env.GREENHOUSE_BOARDS ||
  'stripe,airbnb,netflix,spotify,uber,lyft,slack,discord,notion,figma'
)
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const LEVER_BOARDS = (
  process.env.LEVER_BOARDS ||
  'flipkart,swiggy,razorpay,zerodha,phonepe,cred,meesho,unacademy,vedantu'
)
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const RSS_FEEDS = (
  process.env.RSS_FEEDS ||
  'https://remotive.com/remote-jobs/feed'
)
  .split('|')
  .map(x => x.trim())
  .filter(Boolean);

const INDIAN_API_KEY = process.env.INDIAN_API_KEY || '';
const JOBDATA_API_KEY = process.env.JOBDATA_API_KEY || '';

const ADSTERRA_SCRIPT =
  process.env.ADSTERRA_SMARTLINK_SCRIPT || '';

const USER_AGENT =
  'GOO-JOBS-Aggregator/Final (+https://goojobs.in)';

// ============================================================
// LOGGER
// ============================================================

const metrics = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  durationMs: 0,
  rawJobs: 0,
  validJobs: 0,
  duplicateJobs: 0,
  expiredJobs: 0,
  finalJobs: 0,
  sources: {},
  errors: []
};

function log(level, message, extra = {}) {
  const payload = {
    time: new Date().toISOString(),
    level,
    message,
    ...extra
  };

  process.stdout.write(JSON.stringify(payload) + '\n');
}

function info(message, extra) {
  log('INFO', message, extra);
}

function warn(message, extra) {
  log('WARN', message, extra);
}

function error(message, extra) {
  log('ERROR', message, extra);

  metrics.errors.push({
    message,
    ...extra
  });
}

// ============================================================
// FILE UTILITIES
// ============================================================

async function ensureDirectories() {
  await fs.mkdir(PUBLIC, { recursive: true });
  await fs.mkdir(JOB_DIR, { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;

  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

async function writeJSON(file, data) {
  await atomicWrite(
    file,
    JSON.stringify(data, null, 2)
  );
}

async function readJSON(file, fallback = null) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ============================================================
// STRING UTILITIES
// ============================================================

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHTML(value) {
  if (!value) return '';

  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value) {
  return stripHTML(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex')
    .slice(0, 20);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'job';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

// ============================================================
// XML / RSS UTILITIES
// ============================================================

function decodeXML(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function xmlTag(block, tag) {
  const safeTag = tag.replace(':', '\\:');

  const regex = new RegExp(
    `<${safeTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeTag}>`,
    'i'
  );

  const match = block.match(regex);

  return match ? decodeXML(match[1]).trim() : '';
}

function parseRSS(xml) {
  const items =
    xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  return items.map(item => ({
    title: stripHTML(xmlTag(item, 'title')),
    link: stripHTML(
      xmlTag(item, 'link') ||
      xmlTag(item, 'guid')
    ),
    description: stripHTML(
      xmlTag(item, 'description') ||
      xmlTag(item, 'content:encoded')
    ),
    publishedAt:
      xmlTag(item, 'pubDate') ||
      xmlTag(item, 'published') ||
      xmlTag(item, 'dc:date'),
    category: stripHTML(
      xmlTag(item, 'category')
    )
  }));
}

// ============================================================
// CACHE
// ============================================================

class DiskCache {
  constructor() {
    this.memory = new Map();
  }

  key(url) {
    return hash(url);
  }

  async get(url) {
    if (!CACHE_TTL_MS) return null;

    const key = this.key(url);

    const memory = this.memory.get(key);

    if (
      memory &&
      Date.now() - memory.time < CACHE_TTL_MS
    ) {
      return memory.value;
    }

    try {
      const file = path.join(CACHE_DIR, `${key}.json`);
      const cached = await readJSON(file);

      if (
        cached &&
        Date.now() - cached.time < CACHE_TTL_MS
      ) {
        this.memory.set(key, cached);

        return cached.value;
      }
    } catch {}

    return null;
  }

  async set(url, value) {
    if (!CACHE_TTL_MS) return;

    const key = this.key(url);

    const data = {
      time: Date.now(),
      value
    };

    this.memory.set(key, data);

    await writeJSON(
      path.join(CACHE_DIR, `${key}.json`),
      data
    ).catch(() => {});
  }
}

const cache = new DiskCache();

// ============================================================
// HTTP
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchText(url, options = {}) {
  const cached = await cache.get(url);

  if (cached !== null) {
    return cached;
  }

  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept':
            'application/json, application/rss+xml, text/xml, text/plain, */*',
          ...(options.headers || {})
        }
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`
        );
      }

      const text = await response.text();

      await cache.set(url, text);

      return text;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      if (attempt < MAX_RETRIES - 1) {
        await sleep(
          Math.min(
            10000,
            750 * Math.pow(2, attempt)
          )
        );
      }
    }
  }

  throw lastError;
}

async function fetchJSON(url, options = {}) {
  const text = await fetchText(url, options);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid JSON response from ${url}`
    );
  }
}

async function mapLimit(items, limit, worker) {
  const result = new Array(items.length);
  let cursor = 0;

  const workers = Array.from(
    {
      length: Math.min(
        limit,
        items.length || 1
      )
    },
    async () => {
      while (true) {
        const index = cursor++;

        if (index >= items.length) break;

        try {
          result[index] = await worker(
            items[index],
            index
          );
        } catch (err) {
          result[index] = {
            error: err
          };
        }
      }
    }
  );

  await Promise.all(workers);

  return result;
}

// ============================================================
// LOCATION
// ============================================================

const INDIAN_LOCATIONS = [
  'india',
  'mumbai',
  'delhi',
  'new delhi',
  'bangalore',
  'bengaluru',
  'hyderabad',
  'chennai',
  'pune',
  'kolkata',
  'gurgaon',
  'gurugram',
  'noida',
  'greater noida',
  'ghaziabad',
  'faridabad',
  'jaipur',
  'ahmedabad',
  'surat',
  'lucknow',
  'kanpur',
  'nagpur',
  'indore',
  'bhopal',
  'chandigarh',
  'kochi',
  'coimbatore',
  'vadodara',
  'patna',
  'ranchi',
  'bhubaneswar',
  'dehradun',
  'haridwar',
  'ludhiana',
  'amritsar',
  'jalandhar',
  'patiala',
  'sonipat',
  'panipat',
  'rohtak',
  'hisar',
  'karnal',
  'kurukshetra',
  'yamunanagar',
  'ambala',
  'sirsa',
  'fatehabad',
  'rewari',
  'bhiwani',
  'jind',
  'kaithal',
  'shimla',
  'goa',
  'remote',
  'work from home',
  'wfh',
  'anywhere'
];

function isIndiaOrRemote(location, text = '') {
  const value =
    `${location || ''} ${text || ''}`.toLowerCase();

  return INDIAN_LOCATIONS.some(
    item => value.includes(item)
  );
}

// ============================================================
// JOB NORMALIZATION
// ============================================================

function parseDate(value) {
  if (!value) return null;

  const date = new Date(value);

  if (
    Number.isNaN(date.getTime()) ||
    date.getTime() <= 0
  ) {
    return null;
  }

  return date.toISOString();
}

function detectRemote(title, description, location) {
  const text =
    `${title} ${description} ${location}`.toLowerCase();

  return /\bremote\b|\bwfh\b|work from home|work-from-home|anywhere|distributed team/i
    .test(text);
}

function detectHybrid(title, description, location) {
  const text =
    `${title} ${description} ${location}`.toLowerCase();

  return /\bhybrid\b|partially remote|flexible work/i
    .test(text);
}

function detectExperience(title) {
  const t = String(title || '').toLowerCase();

  if (
    /\bintern\b|\binternship\b|\btrainee\b|\bgraduate\b|\bapprentice\b|\bfresher\b/
      .test(t)
  ) {
    return 'Internship / Fresher';
  }

  if (
    /\bsenior\b|\bsr\.?\b|\blead\b|\bprincipal\b|\bstaff\b|\bhead\b|\bdirector\b|\barchitect\b/
      .test(t)
  ) {
    return 'Senior';
  }

  if (
    /\bjunior\b|\bjr\.?\b|\bassociate\b|\bentry\b|\bentry-level\b/
      .test(t)
  ) {
    return 'Entry';
  }

  return 'Mid';
}

function extractSkills(text) {
  const skills = [
    'javascript',
    'typescript',
    'react',
    'react native',
    'next.js',
    'node.js',
    'nodejs',
    'express',
    'angular',
    'vue',
    'python',
    'django',
    'flask',
    'fastapi',
    'java',
    'spring',
    'kotlin',
    'swift',
    'c++',
    'c#',
    '.net',
    'go',
    'golang',
    'rust',
    'php',
    'laravel',
    'ruby',
    'rails',
    'sql',
    'mysql',
    'postgresql',
    'mongodb',
    'redis',
    'graphql',
    'rest api',
    'aws',
    'azure',
    'gcp',
    'docker',
    'kubernetes',
    'terraform',
    'jenkins',
    'github actions',
    'git',
    'linux',
    'devops',
    'data science',
    'machine learning',
    'deep learning',
    'tensorflow',
    'pytorch',
    'pandas',
    'numpy',
    'excel',
    'power bi',
    'tableau',
    'figma',
    'photoshop',
    'seo',
    'digital marketing',
    'content writing',
    'sales',
    'marketing',
    'finance',
    'accounting',
    'hr',
    'recruitment',
    'customer support',
    'operations',
    'supply chain',
    'logistics',
    'data entry',
    'tally',
    'sap',
    'cybersecurity',
    'qa',
    'testing',
    'selenium',
    'playwright',
    'flutter',
    'android',
    'ios',
    'blockchain',
    'solidity',
    'web3',
    'ai',
    'generative ai',
    'llm'
  ];

  const normalized = normalizeText(text);

  return unique(
    skills
      .filter(skill =>
        normalized.includes(
          normalizeText(skill)
        )
      )
      .map(
        skill =>
          skill.charAt(0).toUpperCase() +
          skill.slice(1)
      )
  ).slice(0, 15);
}

function normalizeJob(raw) {
  const title = stripHTML(raw.title).trim();

  const company =
    stripHTML(
      raw.company ||
      raw.companyName ||
      raw.employer ||
      ''
    ).trim();

  const description =
    stripHTML(
      raw.description ||
      raw.content ||
      raw.excerpt ||
      ''
    ).trim();

  const location =
    stripHTML(
      raw.location ||
      raw.city ||
      'India'
    ).trim();

  const url =
    String(
      raw.url ||
      raw.applyUrl ||
      raw.hostedUrl ||
      raw.link ||
      ''
    ).trim();

  const source =
    String(raw.source || 'Unknown').trim();

  const publishedAt =
    parseDate(
      raw.publishedAt ||
      raw.postedAt ||
      raw.createdAt ||
      raw.updatedAt
    );

  if (
    !title ||
    !company ||
    !description ||
    !url
  ) {
    return null;
  }

  if (!/^https?:\/\//i.test(url)) {
    return null;
  }

  if (
    BLACKLISTED_DOMAINS.some(
      domain =>
        url.toLowerCase().includes(domain)
    )
  ) {
    return null;
  }

  if (
    !isIndiaOrRemote(
      location,
      `${title} ${description}`
    )
  ) {
    return null;
  }

  const remote = detectRemote(
    title,
    description,
    location
  );

  const hybrid = detectHybrid(
    title,
    description,
    location
  );

  const sourceId =
    raw.externalId ||
    raw.id ||
    url;

  const id = hash(
    `${source}|${sourceId}|${url}`
  );

  const slugBase =
    `${title}-${company}-${id.slice(0, 8)}`;

  return {
    id,
    externalId: String(sourceId),
    title,
    company,
    description,
    location,
    url,
    source,
    category:
      raw.category ||
      raw.department ||
      'General',
    employmentType:
      raw.employmentType ||
      raw.jobType ||
      'Full-time',
    salary:
      raw.salary ||
      raw.salaryRange ||
      null,
    publishedAt:
      publishedAt ||
      new Date().toISOString(),
    remote,
    hybrid,
    experienceLevel:
      detectExperience(title),
    skills:
      extractSkills(
        `${title} ${description}`
      ),
    slug:
      slugify(slugBase),
    verifiedSource: true,
    isLive: true,
    firstSeenAt:
      new Date().toISOString(),
    lastSeenAt:
      new Date().toISOString(),
    updatedAt:
      new Date().toISOString()
  };
}

// ============================================================
// SOURCE 1 — ARBEITNOW
// ============================================================

async function fetchArbeitnow() {
  const jobs = [];

  for (
    let page = 1;
    page <= ARBEIT_PAGES;
    page++
  ) {
    try {
      const url =
        `https://www.arbeitnow.com/api/job-board-api?page=${page}`;

      const data = await fetchJSON(url);

      const list =
        Array.isArray(data?.data)
          ? data.data
          : [];

      if (!list.length) break;

      for (const item of list) {
        jobs.push({
          externalId:
            `arbeitnow:${item.slug || item.id || hash(item.url)}`,
          title: item.title,
          company:
            item.company_name ||
            item.company,
          description:
            item.description ||
            item.excerpt,
          location:
            item.location ||
            'Remote',
          url:
            item.url ||
            item.apply_url,
          source: 'Arbeitnow',
          category:
            item.tags?.[0] ||
            'General',
          employmentType:
            item.job_types?.[0] ||
            'Full-time',
          salary:
            item.salary,
          publishedAt:
            item.created_at ||
            item.published_at
        });
      }

      info('Arbeitnow page complete', {
        page,
        jobs: jobs.length
      });

      if (list.length < 10) break;
    } catch (err) {
      error('Arbeitnow page failed', {
        page,
        error: err.message
      });

      break;
    }
  }

  metrics.sources.Arbeitnow = {
    fetched: jobs.length
  };

  return jobs;
}

// ============================================================
// SOURCE 2 — LEVER
// ============================================================

async function fetchLever() {
  const jobs = [];

  const results = await mapLimit(
    LEVER_BOARDS,
    CONCURRENCY,
    async company => {
      const url =
        `https://api.lever.co/v0/postings/${encodeURIComponent(
          company.toLowerCase()
        )}?mode=json`;

      return {
        company,
        data: await fetchJSON(url)
      };
    }
  );

  for (const result of results) {
    if (result?.error) {
      error('Lever board failed', {
        error: result.error.message
      });
      continue;
    }

    const company = result.company;

    const list =
      Array.isArray(result.data)
        ? result.data
        : [];

    for (const item of list) {
      jobs.push({
        externalId:
          `lever:${item.id}`,
        title:
          item.text ||
          item.title,
        company,
        description:
          item.description ||
          item.content ||
          '',
        location:
          item.categories?.location ||
          'Remote',
        url:
          item.applyUrl ||
          item.hostedUrl ||
          '',
        source: 'Lever',
        category:
          item.categories?.team ||
          'General',
        employmentType:
          item.categories?.commitment ||
          'Full-time',
        publishedAt:
          item.createdAt ||
          item.updatedAt
      });
    }
  }

  metrics.sources.Lever = {
    fetched: jobs.length
  };

  return jobs;
}

// ============================================================
// SOURCE 3 — GREENHOUSE
// ============================================================

async function fetchGreenhouse() {
  const jobs = [];

  const results = await mapLimit(
    GREENHOUSE_BOARDS,
    CONCURRENCY,
    async company => {
      const url =
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
          company.toLowerCase()
        )}/jobs?content=true`;

      return {
        company,
        data: await fetchJSON(url)
      };
    }
  );

  for (const result of results) {
    if (result?.error) {
      error('Greenhouse board failed', {
        error: result.error.message
      });
      continue;
    }

    const company = result.company;

    const list =
      Array.isArray(result.data?.jobs)
        ? result.data.jobs
        : [];

    for (const item of list) {
      jobs.push({
        externalId:
          `greenhouse:${item.id}`,
        title: item.title,
        company,
        description:
          item.content ||
          item.description ||
          '',
        location:
          item.location?.name ||
          'Remote',
        url:
          item.absolute_url ||
          '',
        source: 'Greenhouse',
        category:
          item.departments?.[0]?.name ||
          'General',
        employmentType:
          'Full-time',
        publishedAt:
          item.updated_at ||
          item.created_at
      });
    }
  }

  metrics.sources.Greenhouse = {
    fetched: jobs.length
  };

  return jobs;
}

// ============================================================
// SOURCE 4 — RSS
// ============================================================

async function fetchRSS() {
  const jobs = [];

  for (const feed of RSS_FEEDS) {
    try {
      const xml =
        await fetchText(feed);

      const items =
        parseRSS(xml);

      for (const item of items) {
        if (!item.title || !item.link) {
          continue;
        }

        jobs.push({
          externalId:
            `rss:${hash(item.link)}`,
          title: item.title,
          company:
            'Various',
          description:
            item.description,
          location:
            'India',
          url:
            item.link,
          source:
            'RSS',
          category:
            item.category ||
            'General',
          employmentType:
            'Full-time',
          publishedAt:
            item.publishedAt
        });
      }
    } catch (err) {
      error('RSS feed failed', {
        feed,
        error: err.message
      });
    }
  }

  metrics.sources.RSS = {
    fetched: jobs.length
  };

  return jobs;
}

// ============================================================
// SOURCE 5 — REMOTIVE
// ============================================================

async function fetchRemotive() {
  const jobs = [];

  try {
    const data =
      await fetchJSON(
        'https://remotive.com/api/remote-jobs'
      );

    const list =
      Array.isArray(data?.jobs)
        ? data.jobs
        : [];

    for (const item of list) {
      jobs.push({
        externalId:
          `remotive:${item.id}`,
        title:
          item.title,
        company:
          item.company_name ||
          item.company ||
          'Unknown',
        description:
          item.description ||
          '',
        location:
          item.candidate_required_location ||
          'Remote',
        url:
          item.url ||
          '',
        source:
          'Remotive',
        category:
          item.category ||
          'Remote',
        employmentType:
          item.job_type ||
          'Full-time',
        salary:
          item.salary,
        publishedAt:
          item.publication_date ||
          item.created_at
      });
    }
  } catch (err) {
    /*
     * RSS fallback is still real-source data.
     */
    try {
      const xml =
        await fetchText(
          'https://remotive.com/remote-jobs/feed'
        );

      for (const item of parseRSS(xml)) {
        if (!item.title || !item.link) {
          continue;
        }

        jobs.push({
          externalId:
            `remotive-rss:${hash(item.link)}`,
          title:
            item.title,
          company:
            'Remote Company',
          description:
            item.description,
          location:
            'Remote',
          url:
            item.link,
          source:
            'Remotive RSS',
          category:
            'Remote',
          employmentType:
            'Full-time',
          publishedAt:
            item.publishedAt
        });
      }
    } catch (rssErr) {
      error('Remotive failed', {
        error: err.message,
        rssError: rssErr.message
      });
    }
  }

  metrics.sources.Remotive = {
    fetched: jobs.length
  };

  return jobs;
}

// ============================================================
// SOURCE 6 — NCS
// ============================================================

async function fetchNCS() {
  const jobs = [];

  /*
   * NCS endpoints can change.
   * We intentionally do not fabricate data if the
   * public endpoint is unavailable.
   */

  const endpoints = [
    'https://www.ncs.gov.in/_api/jobs/search?page=1&size=100'
  ];

  for (const url of endpoints) {
    try {
      const data =
        await fetchJSON(url, {
          headers: {
            Accept:
              'application/json'
          }
        });

      const list =
        data?.data ||
        data?.jobs ||
        data?.results ||
        [];

      if (!Array.isArray(list)) {
        continue;
      }

      for (const item of list) {
        const id =
          item.jobId ||
          item.id;

        const title =
          item.title ||
          item.jobTitle;

        if (!id || !title) {
          continue;
        }

        jobs.push({
          externalId:
            `ncs:${id}`,
          title,
          company:
            item.organization ||
            item.employer ||
            'NCS',
          description:
            item.description ||
            item.jobDescription ||
            '',
          location:
            [
              item.city,
              item.state,
              'India'
            ]
              .filter(Boolean)
              .join(', '),
          url:
            item.applyUrl ||
            item.url ||
            '',
          source:
            'NCS',
          category:
            item.sector ||
            item.industry ||
            'Government',
          employmentType:
            item.employmentType ||
            item.jobType ||
            'Full-time',
          salary:
            item.salary,
          publishedAt:
            item.postedDate ||
            item.publishedDate ||
            item.createdAt
        });
      }

      break;
    } catch (err) {
      error('NCS endpoint failed', {
        url,
        error: err.message
      });
    }
  }

  metrics.sources.NCS = {
    fetched: jobs.length
  };

  return jobs;
}

// ============================================================
// SOURCE 7 — OPTIONAL INDIAN API
// ============================================================

async function fetchIndianAPI() {
  if (!INDIAN_API_KEY) {
    metrics.sources.IndianAPI = {
      skipped: true,
      reason: 'API key not configured'
    };

    return [];
  }

  const jobs = [];

  try {
    const data =
      await fetchJSON(
        'https://indianapi.in/api/v2/job/search',
        {
          headers: {
            'X-Api-Key':
              INDIAN_API_KEY
          }
        }
      );

    const list =
      data?.results ||
      data?.jobs ||
      data?.data ||
      [];

    if (Array.isArray(list)) {
      for (const item of list) {
        jobs.push({
          externalId:
            `indianapi:${item.id || item.job_id}`,
          title:
            item.title ||
            item.job_title,
          company:
            item.company ||
            item.company_name ||
            item.employer,
          description:
            item.description ||
            item.job_description ||
            '',
          location:
            item.location ||
            item.city ||
            'India',
          url:
            item.url ||
            item.apply_url ||
            item.link ||
            '',
          source:
            'IndianAPI',
          category:
            item.category ||
            item.industry ||
            'General',
          employmentType:
            item.job_type ||
            item.employment_type ||
            'Full-time',
          salary:
            item.salary ||
            item.salary_range,
          publishedAt:
            item.posted_at ||
            item.created_at ||
            item.date
        });
      }
    }
  } catch (err) {
    error('IndianAPI failed', {
      error: err.message
    });
  }

  metrics.sources.IndianAPI = {
    fetched: jobs.length
  };

  return jobs;
}

// ============================================================
// SOURCE 8 — OPTIONAL JOBDATAAPI
// ============================================================

async function fetchJobDataAPI() {
  if (!JOBDATA_API_KEY) {
    metrics.sources.JobDataAPI = {
      skipped: true,
      reason: 'API key not configured'
    };

    return [];
  }

  const jobs = [];

  try {
    const data =
      await fetchJSON(
        'https://jobdataapi.com/api/jobs?country_code=IN&limit=100',
        {
          headers: {
            Authorization:
              `Bearer ${JOBDATA_API_KEY}`
          }
        }
      );

    const list =
      data?.results ||
      data?.data ||
      [];

    if (Array.isArray(list)) {
      for (const item of list) {
        jobs.push({
          externalId:
            `jobdata:${item.id || item.job_id}`,
          title:
            item.title,
          company:
            item.company ||
            item.company_name,
          description:
            item.description ||
            item.job_description ||
            '',
          location:
            item.location ||
            item.city ||
            'India',
          url:
            item.url ||
            item.apply_url ||
            '',
          source:
            'JobDataAPI',
          category:
            item.category ||
            item.industry ||
            'General',
          employmentType:
            item.employment_type ||
            item.job_type ||
            'Full-time',
          salary:
            item.salary ||
            item.salary_range,
          publishedAt:
            item.posted_at ||
            item.date
        });
      }
    }
  } catch (err) {
    error('JobDataAPI failed', {
      error: err.message
    });
  }

  metrics.sources.JobDataAPI = {
    fetched: jobs.length
  };

  return jobs;
}

// ============================================================
// DEDUPLICATION
// ============================================================

function normalizedURL(url) {
  try {
    const u = new URL(url);

    u.hash = '';

    [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'ref',
      'source'
    ].forEach(param =>
      u.searchParams.delete(param)
    );

    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url || '')
      .trim()
      .toLowerCase();
  }
}

function fingerprint(job) {
  return [
    normalizeText(job.title),
    normalizeText(job.company),
    normalizeText(job.location)
  ].join('|');
}

function similarity(a, b) {
  const A =
    new Set(
      normalizeText(a)
        .split(' ')
        .filter(x => x.length > 2)
    );

  const B =
    new Set(
      normalizeText(b)
        .split(' ')
        .filter(x => x.length > 2)
    );

  if (!A.size || !B.size) {
    return 0;
  }

  let common = 0;

  for (const word of A) {
    if (B.has(word)) {
      common++;
    }
  }

  return common /
    Math.max(A.size, B.size);
}

function deduplicate(jobs) {
  const byURL = new Map();
  const byFingerprint = new Map();

  const output = [];
  let duplicates = 0;

  const sorted =
    [...jobs].sort(
      (a, b) =>
        new Date(b.publishedAt) -
        new Date(a.publishedAt)
    );

  for (const job of sorted) {
    const urlKey =
      normalizedURL(job.url);

    if (byURL.has(urlKey)) {
      duplicates++;
      mergeJob(
        byURL.get(urlKey),
        job
      );
      continue;
    }

    const fp =
      fingerprint(job);

    let duplicate = null;

    for (const [
      existingFP,
      existingJob
    ] of byFingerprint) {
      if (
        existingFP === fp ||
        similarity(
          existingFP,
          fp
        ) >= 0.9
      ) {
        duplicate = existingJob;
        break;
      }
    }

    if (duplicate) {
      duplicates++;

      mergeJob(
        duplicate,
        job
      );

      continue;
    }

    byURL.set(
      urlKey,
      job
    );

    byFingerprint.set(
      fp,
      job
    );

    output.push(job);
  }

  metrics.duplicateJobs =
    duplicates;

  return output;
}

function mergeJob(target, source) {
  target.skills =
    unique([
      ...(target.skills || []),
      ...(source.skills || [])
    ]).slice(0, 15);

  if (
    source.description &&
    source.description.length >
      target.description.length
  ) {
    target.description =
      source.description;
  }

  if (
    !target.salary &&
    source.salary
  ) {
    target.salary =
      source.salary;
  }

  target.lastSeenAt =
    new Date().toISOString();

  target.updatedAt =
    new Date().toISOString();
}

// ============================================================
// LIVE / EXPIRY FILTER
// ============================================================

function isFresh(job) {
  const date =
    new Date(job.publishedAt);

  if (
    Number.isNaN(date.getTime())
  ) {
    return false;
  }

  const age =
    Date.now() -
    date.getTime();

  return (
    age <=
    RETENTION_DAYS *
      86400000
  );
}

function validateJob(job) {
  if (!job) return false;

  if (
    !job.title ||
    job.title.length < 3
  ) {
    return false;
  }

  if (
    !job.company ||
    job.company.length < 2
  ) {
    return false;
  }

  if (
    !job.description ||
    job.description.length < 20
  ) {
    return false;
  }

  if (
    !job.url ||
    !/^https?:\/\//i.test(job.url)
  ) {
    return false;
  }

  if (
    !job.publishedAt ||
    !isFresh(job)
  ) {
    return false;
  }

  return true;
}

// ============================================================
// SCORING
// ============================================================

function scoreJob(job) {
  let score = 0;

  const ageDays =
    Math.max(
      0,
      (
        Date.now() -
        new Date(
          job.publishedAt
        ).getTime()
      ) /
        86400000
    );

  score += Math.max(
    0,
    45 -
      ageDays * 1.8
  );

  score += Math.min(
    15,
    (job.skills?.length || 0) *
      1.2
  );

  score += Math.min(
    10,
    job.description.length /
      100
  );

  if (job.remote) {
    score += 6;
  }

  if (job.hybrid) {
    score += 3;
  }

  if (
    job.salary ||
    job.salaryRange
  ) {
    score += 5;
  }

  if (
    job.company &&
    job.company !== 'Various'
  ) {
    score += 5;
  }

  if (
    job.verifiedSource
  ) {
    score += 10;
  }

  return Math.round(
    Math.min(
      100,
      score
    )
  );
}

function rankJobs(jobs) {
  for (const job of jobs) {
    job.score =
      scoreJob(job);
  }

  jobs.sort(
    (a, b) =>
      b.score -
      a.score ||
      new Date(b.publishedAt) -
      new Date(a.publishedAt)
  );

  return jobs;
}

// ============================================================
// PREVIOUS DATA
// ============================================================

async function loadPreviousJobs() {
  const data =
    await readJSON(
      path.join(
        PUBLIC,
        'jobs.json'
      ),
      null
    );

  if (
    Array.isArray(
      data?.jobs
    )
  ) {
    return data.jobs;
  }

  return [];
}

// ============================================================
// JOB PAGE
// ============================================================

function createJobPage(job) {
  const canonical =
    `${SITE_URL}/job/${job.slug}/`;

  const title =
    `${job.title} at ${job.company} in ${job.location} | GOO JOBS`;

  const description =
    stripHTML(
      job.description
    ).slice(0, 155);

  const datePosted =
    new Date(
      job.publishedAt
    ).toISOString();

  const validThrough =
    new Date(
      new Date(
        job.publishedAt
      ).getTime() +
        RETENTION_DAYS *
          86400000
    ).toISOString();

  const schema = {
    '@context':
      'https://schema.org',
    '@type':
      'JobPosting',
    title:
      job.title,
    description:
      job.description,
    datePosted,
    validThrough,
    employmentType:
      job.employmentType ||
      'FULL_TIME',
    hiringOrganization: {
      '@type':
        'Organization',
      name:
        job.company
    },
    jobLocation: {
      '@type':
        'Place',
      address: {
        '@type':
          'PostalAddress',
        addressLocality:
          job.location,
        addressCountry:
          'IN'
      }
    },
    url:
      canonical,
    sameAs: [
      job.url
    ]
  };

  const skills =
    (job.skills || [])
      .map(
        skill =>
          `<span class="skill">${escapeHTML(
            skill
          )}</span>`
      )
      .join('');

  const remote =
    job.remote
      ? `<span class="badge remote">Remote</span>`
      : '';

  const hybrid =
    job.hybrid
      ? `<span class="badge hybrid">Hybrid</span>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">
<meta name="robots"
content="index,follow">
<title>${escapeHTML(title)}</title>
<meta name="description"
content="${escapeHTML(description)}">
<link rel="canonical"
href="${escapeHTML(canonical)}">

<meta property="og:type"
content="article">
<meta property="og:title"
content="${escapeHTML(title)}">
<meta property="og:description"
content="${escapeHTML(description)}">
<meta property="og:url"
content="${escapeHTML(canonical)}">

<script type="application/ld+json">${JSON.stringify(schema)}</script>

<style>
*{box-sizing:border-box}
body{
margin:0;
background:#080b12;
color:#edf2ff;
font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
line-height:1.65
}
.container{
width:min(900px,calc(100% - 30px));
margin:auto;
padding:25px 0 60px
}
header{
display:flex;
justify-content:space-between;
align-items:center;
border-bottom:1px solid #20283a;
padding-bottom:18px;
margin-bottom:28px
}
.logo{
font-weight:900;
font-size:20px;
color:#46d9ff
}
nav a{
color:#9ba8bf;
text-decoration:none;
margin-left:15px;
font-size:14px
}
h1{
font-size:clamp(26px,5vw,42px);
line-height:1.2;
margin:12px 0
}
.meta{
display:flex;
gap:8px;
flex-wrap:wrap;
margin:15px 0 25px
}
.badge,.pill,.skill{
display:inline-block;
border:1px solid #263149;
background:#101827;
border-radius:999px;
padding:5px 11px;
font-size:12px;
color:#aeb9ce
}
.remote{color:#54e6a2}
.hybrid{color:#d3a8ff}
.card{
background:#101622;
border:1px solid #202a40;
border-radius:20px;
padding:25px
}
.card h2{
font-size:19px
}
.description{
color:#aeb9ce;
white-space:normal
}
.skills{
margin-top:20px;
display:flex;
gap:7px;
flex-wrap:wrap
}
.skill{
color:#8ddfff
}
.apply{
display:inline-block;
margin-top:25px;
padding:13px 22px;
border-radius:12px;
background:#39d9ff;
color:#001019;
font-weight:800;
text-decoration:none
}
.back{
display:inline-block;
margin-top:22px;
color:#8ddfff;
text-decoration:none
}
footer{
margin-top:35px;
padding-top:20px;
border-top:1px solid #20283a;
color:#758199;
font-size:13px;
text-align:center
}
</style>
</head>

<body>
<div class="container">

<header>
<div class="logo">GOO JOBS</div>
<nav>
<a href="/">Home</a>
<a href="/sitemap.xml">Sitemap</a>
</nav>
</header>

<div class="meta">
<span class="badge">Verified Source</span>
<span class="badge">${escapeHTML(job.source)}</span>
${remote}
${hybrid}
</div>

<h1>${escapeHTML(job.title)}</h1>

<div class="meta">
<span class="pill">
${escapeHTML(job.company)}
</span>

<span class="pill">
${escapeHTML(job.location)}
</span>

<span class="pill">
${escapeHTML(job.employmentType)}
</span>

<span class="pill">
${escapeHTML(job.experienceLevel)}
</span>
</div>

<section class="card">

<h2>Job Description</h2>

<div class="description">
${job.description
  .split(/\n+/)
  .map(
    paragraph =>
      `<p>${escapeHTML(
        paragraph
      )}</p>`
  )
  .join('')}
</div>

${
  skills
    ? `
<h2>Skills</h2>
<div class="skills">
${skills}
</div>
`
    : ''
}

<a
class="apply"
href="${escapeHTML(job.url)}"
target="_blank"
rel="nofollow noopener">
Apply on Official Source
</a>

</section>

<a class="back"
href="/">
← Back to all jobs
</a>

<footer>
GOO JOBS • Real job aggregation
from public sources.
</footer>

${
  ADSTERRA_SCRIPT
    ? ADSTERRA_SCRIPT
    : ''
}

</div>
</body>
</html>`;
}

// ============================================================
// GENERATE JOB PAGES
// ============================================================

async function generateJobPages(jobs) {
  /*
   * Remove generated job folders first.
   * This prevents expired jobs from remaining indexable.
   */

  await fs.rm(
    JOB_DIR,
    {
      recursive: true,
      force: true
    }
  );

  await fs.mkdir(
    JOB_DIR,
    {
      recursive: true
    }
  );

  await mapLimit(
    jobs,
    CONCURRENCY,
    async job => {
      const directory =
        path.join(
          JOB_DIR,
          job.slug
        );

      await fs.mkdir(
        directory,
        {
          recursive: true
        }
      );

      await atomicWrite(
        path.join(
          directory,
          'index.html'
        ),
        createJobPage(job)
      );

      return true;
    }
  );

  info(
    'Job pages generated',
    {
      count: jobs.length
    }
  );
}

// ============================================================
// SITEMAP
// ============================================================

async function generateSitemap(jobs) {
  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  let xml =
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url>
<loc>${SITE_URL}/</loc>
<lastmod>${today}</lastmod>
<changefreq>daily</changefreq>
<priority>1.0</priority>
</url>
`;

  for (const job of jobs) {
    const date =
      new Date(
        job.updatedAt ||
        job.publishedAt
      )
        .toISOString()
        .slice(0, 10);

    xml += `
<url>
<loc>${SITE_URL}/job/${escapeHTML(
      job.slug
    )}/</loc>
<lastmod>${date}</lastmod>
<changefreq>daily</changefreq>
<priority>0.8</priority>
</url>
`;
  }

  xml += '\n</urlset>';

  await atomicWrite(
    path.join(
      PUBLIC,
      'sitemap.xml'
    ),
    xml
  );
}

// ============================================================
// ROBOTS
// ============================================================

async function generateRobots() {
  const robots =
`User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;

  await atomicWrite(
    path.join(
      PUBLIC,
      'robots.txt'
    ),
    robots
  );
}

// ============================================================
// SOURCE STATUS
// ============================================================

async function generateSourceStatus() {
  await writeJSON(
    path.join(
      PUBLIC,
      'source-status.json'
    ),
    {
      generatedAt:
        new Date().toISOString(),
      target:
        TARGET_JOBS,
      finalJobs:
        metrics.finalJobs,
      sources:
        metrics.sources,
      errors:
        metrics.errors
    }
  );
}

// ============================================================
// JOBS JSON
// ============================================================

async function generateJobsJSON(jobs) {
  await writeJSON(
    path.join(
      PUBLIC,
      'jobs.json'
    ),
    {
      generatedAt:
        new Date().toISOString(),

      count:
        jobs.length,

      target:
        TARGET_JOBS,

      liveOnly:
        true,

      dummyJobs:
        false,

      jobs,

      sources:
        metrics.sources
    }
  );
}

// ============================================================
// HOMEPAGE
// ============================================================

async function generateHomepage() {
  const source =
    path.join(
      ROOT,
      'index.html'
    );

  try {
    const html =
      await fs.readFile(
        source,
        'utf8'
      );

    await atomicWrite(
      path.join(
        PUBLIC,
        'index.html'
      ),
      html
    );
  } catch {
    /*
     * Do not fabricate homepage content.
     * If index.html does not exist, build fails clearly.
     */

    throw new Error(
      'index.html was not found in project root'
    );
  }
}

// ============================================================
// MAIN PIPELINE
// ============================================================

async function main() {
  const started =
    Date.now();

  info(
    'GOO JOBS FINAL AUTO-SYNC STARTED',
    {
      target:
        TARGET_JOBS
    }
  );

  await ensureDirectories();

  const previous =
    await loadPreviousJobs();

  info(
    'Previous dataset loaded',
    {
      count:
        previous.length
    }
  );

  const sources = [
    [
      'Arbeitnow',
      fetchArbeitnow
    ],
    [
      'Lever',
      fetchLever
    ],
    [
      'Greenhouse',
      fetchGreenhouse
    ],
    [
      'RSS',
      fetchRSS
    ],
    [
      'Remotive',
      fetchRemotive
    ],
    [
      'NCS',
      fetchNCS
    ],
    [
      'IndianAPI',
      fetchIndianAPI
    ],
    [
      'JobDataAPI',
      fetchJobDataAPI
    ]
  ];

  const sourceResults =
    await Promise.allSettled(
      sources.map(
        async ([name, fetcher]) => {
          try {
            const jobs =
              await fetcher();

            return {
              name,
              jobs
            };
          } catch (err) {
            error(
              `${name} source crashed`,
              {
                error:
                  err.message
              }
            );

            return {
              name,
              jobs: []
            };
          }
        }
      )
    );

  let rawJobs = [];

  for (
    const result of sourceResults
  ) {
    if (
      result.status ===
      'fulfilled'
    ) {
      rawJobs.push(
        ...result.value.jobs
      );
    }
  }

  metrics.rawJobs =
    rawJobs.length;

  info(
    'Raw source collection complete',
    {
      jobs:
        rawJobs.length
    }
  );

  // ----------------------------------------------------------
  // NORMALIZE
  // ----------------------------------------------------------

  const normalized =
    rawJobs
      .map(normalizeJob)
      .filter(Boolean);

  metrics.validJobs =
    normalized.length;

  info(
    'Normalization complete',
    {
      jobs:
        normalized.length
    }
  );

  // ----------------------------------------------------------
  // DEDUP
  // ----------------------------------------------------------

  let jobs =
    deduplicate(
      normalized
    );

  info(
    'Deduplication complete',
    {
      jobs:
        jobs.length,
      duplicates:
        metrics.duplicateJobs
    }
  );

  // ----------------------------------------------------------
  // ONLY CURRENT REAL JOBS
  // ----------------------------------------------------------

  const beforeExpiry =
    jobs.length;

  jobs =
    jobs.filter(
      validateJob
    );

  metrics.expiredJobs =
    beforeExpiry -
    jobs.length;

  info(
    'Live/fresh filtering complete',
    {
      jobs:
        jobs.length,
      expired:
        metrics.expiredJobs
    }
  );

  /*
   * IMPORTANT:
   * Previous jobs are NOT blindly reactivated.
   *
   * A previous job survives only if it was fetched again
   * from a real source during the current sync.
   *
   * This prevents stale listings from pretending to be live.
   */

  const currentMap =
    new Map(
      jobs.map(
        job => [
          normalizedURL(
            job.url
          ),
          job
        ]
      )
    );

  const refreshed = [];

  for (const oldJob of previous) {
    const key =
      normalizedURL(
        oldJob.url
      );

    const current =
      currentMap.get(key);

    if (!current) {
      continue;
    }

    current.firstSeenAt =
      oldJob.firstSeenAt ||
      current.firstSeenAt;

    current.lastSeenAt =
      new Date().toISOString();

    refreshed.push(
      current
    );
  }

  /*
   * Add newly discovered jobs.
   */

  const finalMap =
    new Map();

  for (const job of [
    ...refreshed,
    ...jobs
  ]) {
    finalMap.set(
      normalizedURL(
        job.url
      ),
      job
    );
  }

  jobs =
    [...finalMap.values()];

  // ----------------------------------------------------------
  // RANK
  // ----------------------------------------------------------

  jobs =
    rankJobs(jobs);

  // ----------------------------------------------------------
  // LIMIT
  // ----------------------------------------------------------

  jobs =
    jobs.slice(
      0,
      TARGET_JOBS
    );

  metrics.finalJobs =
    jobs.length;

  info(
    'Final live dataset ready',
    {
      jobs:
        jobs.length,
      requested:
        TARGET_JOBS
    }
  );

  /*
   * NEVER create dummy jobs.
   */

  if (!jobs.length) {
    throw new Error(
      'ZERO REAL JOBS FOUND. Build stopped. No dummy jobs generated.'
    );
  }

  // ----------------------------------------------------------
  // GENERATE
  // ----------------------------------------------------------

  await generateHomepage();

  await generateJobPages(
    jobs
  );

  await generateJobsJSON(
    jobs
  );

  await generateSitemap(
    jobs
  );

  await generateRobots();

  await generateSourceStatus();

  // ----------------------------------------------------------
  // FINAL METRICS
  // ----------------------------------------------------------

  metrics.finishedAt =
    new Date().toISOString();

  metrics.durationMs =
    Date.now() -
    started;

  await writeJSON(
    path.join(
      LOG_DIR,
      'metrics.json'
    ),
    metrics
  );

  info(
    'GOO JOBS AUTO-SYNC COMPLETE',
    {
      finalJobs:
        jobs.length,
      target:
        TARGET_JOBS,
      durationMs:
        metrics.durationMs
    }
  );

  /*
   * Non-zero exit code only when there are no jobs.
   * Fewer than TARGET_JOBS is NOT an error because
   * the engine must never manufacture fake listings.
   */
}

main().catch(
  async err => {
    error(
      'BUILD FAILED',
      {
        error:
          err?.stack ||
          err?.message ||
          String(err)
      }
    );

    metrics.finishedAt =
      new Date().toISOString();

    metrics.durationMs =
      Date.now() -
      new Date(
        metrics.startedAt
      ).getTime();

    await writeJSON(
      path.join(
        LOG_DIR,
        'metrics.json'
      ),
      metrics
    ).catch(() => {});

    process.exit(1);
  }
);

// ============================================================
// OPTIONAL HEALTH SERVER
// ============================================================

if (HEALTH_PORT > 0) {
  http
    .createServer(
      async (_req, res) => {
        res.writeHead(
          200,
          {
            'Content-Type':
              'application/json'
          }
        );

        res.end(
          JSON.stringify({
            ok: true,
            site:
              SITE_URL,
            target:
              TARGET_JOBS,
            time:
              new Date().toISOString()
          })
        );
      }
    )
    .listen(
      HEALTH_PORT,
      () => {
        info(
          'Health server started',
          {
            port:
              HEALTH_PORT
          }
        );
      }
    );
}
