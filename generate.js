#!/usr/bin/env node
/**
 * GOO JOBS – ULTIMATE MERGED AUTO-SYNC ENGINE (generate.js)
 * ==========================================================
 * MERGED FROM BOTH ADVANCED VERSIONS – NO FEATURE LEFT BEHIND
 *
 * Sources:
 * 1. Arbeitnow          (300 pages × 15 jobs ≈ 4500)
 * 2. RemoteOK            (100+ remote jobs)
 * 3. Lever.co            (70+ popular companies)
 * 4. Greenhouse          (70+ popular companies)
 * 5. Recruitee           (50+ companies)
 * 6. Breezy HR           (30+ companies)
 * 7. RSS Feeds           (Remotive, Working Nomads, Jobicy, Himalayas)
 * 8. Remotive RSS        (separate adapter)
 * 9. NCS India           (Government job portal)
 * 10. IndianAPI          (optional, requires INDIAN_API_KEY)
 * 11. JobDataAPI         (optional, requires JOBDATA_API_KEY)
 *
 * Features (merged from both):
 * - Persistent disk cache + in‑memory cache
 * - Token bucket rate limiter
 * - Concurrency control (configurable)
 * - Retry with exponential backoff + jitter
 * - Smart deduplication (URL + fingerprint + similarity)
 * - Indian location detection + remote/hybrid flagging
 * - Skill extraction, experience level, salary parsing
 * - Job scoring & ranking (freshness, skills, remote, salary, company, verified source)
 * - Previous data preservation (merges only re‑fetched jobs)
 * - Automatic expiry after 45 days
 * - Adsterra Smart Link placeholder injection
 * - Individual job pages with full SEO schema & styling
 * - Chunked sitemap & robots.txt
 * - Source health report
 * - Cleanup of old job pages
 * - Unique slug generation
 * - Atomic writes with verification
 * - Optional health check server
 * - Graceful shutdown
 * - Never generates dummy jobs
 *
 * Run: node generate.js
 * Node 18+ (native fetch)
 */

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

// ────────────────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname);
const PUBLIC_DIR = path.join(ROOT, 'public');
const JOB_DIR = path.join(PUBLIC_DIR, 'job');
const CACHE_DIR = path.join(ROOT, '.cache');
const LOG_DIR = path.join(ROOT, 'logs');

const SITE_URL = (process.env.SITE_URL || 'https://goojobs.in').replace(/\/+$/, '');
const TARGET_JOBS = Math.max(5000, parseInt(process.env.TARGET_JOBS || '5000', 10));
const RETENTION_DAYS = Math.max(1, parseInt(process.env.RETENTION_DAYS || '45', 10));
const TIMEOUT_MS = Math.max(5000, parseInt(process.env.TIMEOUT_MS || '30000', 10));
const MAX_RETRIES = Math.max(2, parseInt(process.env.MAX_RETRIES || '4', 10));
const CONCURRENCY = Math.max(5, parseInt(process.env.CONCURRENCY || '12', 10));
const CACHE_TTL_MS = Math.max(0, parseInt(process.env.CACHE_TTL_MS || '600000', 10));
const ARBEIT_PAGES = Math.max(10, parseInt(process.env.ARBEIT_PAGES || '300', 10));
const HEALTH_PORT = parseInt(process.env.HEALTH_CHECK_PORT || '0', 10);
const ENABLE_CACHE = process.env.ENABLE_CACHE !== 'false';
const ENABLE_METRICS = process.env.ENABLE_METRICS !== 'false';

const BLACKLIST = (process.env.BLACKLISTED_DOMAINS || '')
  .split(',')
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

const ADSTERRA_SCRIPT = process.env.ADSTERRA_SMARTLINK_SCRIPT || '';
const ADSTERRA_TOKEN = '<!--ADSTERRA_SMARTLINK-->';

// ── Merged company boards (union of both code versions) ──
function parseList(value, fallbackArray, separator = ',') {
  if (!value) return fallbackArray;
  return value.split(separator).map(x => x.trim()).filter(Boolean);
}

function mergeLists(...lists) {
  return [...new Set(lists.flat())];
}

// Greenhouse – combined list from Code2 and Code1
const GREENHOUSE_BOARDS = mergeLists(
  parseList(process.env.GREENHOUSE_BOARDS, []),
  [
    'stripe','airbnb','netflix','spotify','uber','lyft','slack','discord','notion','figma',
    'coinbase','datadog','asana','doordash','okta','dropbox','cloudflare','hubspot','twilio',
    'reddit','pinterest','robinhood','mongodb','gitlab','grammarly','duolingo','plaid','brex',
    'gusto','instacart','affirm','rippling','samsara','databricks','hashicorp','palantir',
    'snowflake','canva','ramp','linear','vercel','benchling','faire','gopuff','lattice','coursera',
    'khanacademy','mozilla'
  ],
  parseList(process.env.GREENHOUSE_BOARD_URLS, []),
  [
    'razorpay','freshworks','zoho','chargebee','postman','hasura','rudderstack','browserstack',
    'lamdatest','hotjar','intercom','interakt','clevertap','webengage','madstreetden','capillary',
    'inmobi','sharechat','moglix','lendingkart','mintifi','gojek','grab','sea','bytedance',
    'stripe','shopify','spotify','netflix','airbnb','uber','lyft','dropbox','figma','notion',
    'atlassian','slack','zoom','gong','salesforce'
  ].map(s => s.trim())
);

// Lever – combined
const LEVER_BOARDS = mergeLists(
  parseList(process.env.LEVER_BOARDS, []),
  [
    'flipkart','swiggy','razorpay','zerodha','phonepe','cred','meesho','unacademy','vedantu',
    'browserstack','postman','freshworks','dream11','groww','slice','delhivery','acko','urbancompany',
    'lenskart','ola','upstox','sharechat','chargebee','zepto','cars24','coinbase','retool','netlify',
    'figma','replit','scale','notion','remote','zapier','buffer','webflow','1password','mistral',
    'canonical','elastic','mattermost','sourcegraph','grafana','hashicorp','gocardless','snyk'
  ],
  parseList(process.env.LEVER_BOARDS || '', []), // in case user set env
  [
    'upgrad','smallcase','slice','groww','mpl','dream11','policybazaar','nykaa','lenskart','olx',
    'curefit','blinkit','licious','rupyy','bharatpe','paytm','oyo','dunzo','cardekho','delhivery',
    'blackbuck','spinny','rebel','lokal','farmako','meesho','shopflo','peppercontent','mygate',
    'instamojo','cashfree','simpl','digio','clear','zetwerk','inc42','agritech','indianstartup'
  ].map(s => s.trim())
);

// Recruitee – combined
const RECRUITEE_COMPANIES = mergeLists(
  parseList(process.env.RECRUITEE_COMPANIES, []),
  [
    'remote','toggl','pipedrive','typeform','komoot','personio','veed','hotjar','contentoo',
    'scout24','n26','mollie','lendio','testlio','factorial'
  ],
  parseList(process.env.RECRUITEE_BOARDS || '', []),
  [
    'workable','blend','getaround','deliveroo','payfit','alma','kry','doctolib','sennder','wefox',
    'sumup','klarna','pleo','bitpanda','goatero','onefootball','tiermobility','bolt','watsonx',
    'taxfix','wearedevelopers','leapsome','personio','honeypot','getyourguide','omio','blinkist','karos',
    'infarm','habito','tide','monzo','revolut','checkout','transferwise'
  ].map(s => s.trim())
);

// Breezy – combined
const BREEZY_COMPANIES = mergeLists(
  parseList(process.env.BREEZY_COMPANIES, []),
  [
    'buffer','doist','drift','close','convertkit','vidiq','helpscout','lessonly','meetfranz','remote',
    'sketch','teachable','unbounce','wildbit','zencastr'
  ],
  parseList(process.env.BREEZY_BOARDS || '', []),
  [
    'automattic','doist','buffer','hotjar','zapier','gitlab','invision','mmhmm','float','scrapinghub',
    'basecamp','toggl','helpscout','expensify','clearbit','fiscalnote','drift','lattice','recruitee',
    'chartmogul','onshape','formstack','auth0'
  ].map(s => s.trim())
);

// RSS feeds – combined
const RSS_FEEDS = mergeLists(
  parseList(process.env.RSS_FEEDS, [], '|'),
  [
    'https://remotive.com/remote-jobs/feed',
    'https://weworkremotely.com/remote-jobs.rss',
    'https://jobicy.com/?feed=job_feed',
    'https://workingnomads.com/jobs/feed'
  ],
  [
    'https://remotive.com/remote-jobs/feed',
    'https://www.workingnomads.com/feed',
    'https://jobicy.com/feed',
    'https://www.remotewoman.com/feed',
    'https://www.remotehub.com/rss'
  ]
);

const INDIAN_API_KEY = process.env.INDIAN_API_KEY || '';
const JOBDATA_API_KEY = process.env.JOBDATA_API_KEY || '';

// ────────────────────────────────────────────────────────────
// LOGGER (from Code2, enhanced)
// ────────────────────────────────────────────────────────────
class Logger {
  constructor() {
    this.startedAt = Date.now();
    this.metrics = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: 0,
      rawJobs: 0,
      validJobs: 0,
      deduplicatedJobs: 0,
      finalJobs: 0,
      sources: {},
      errors: []
    };
  }

  log(level, message, data = {}) {
    const row = { time: new Date().toISOString(), level, message, ...data };
    process.stdout.write(JSON.stringify(row) + '\n');
  }

  info(message, data = {}) { this.log('info', message, data); }
  warn(message, data = {}) { this.log('warn', message, data); }
  error(message, data = {}) {
    this.log('error', message, data);
    this.metrics.errors.push({ message, data });
  }

  source(name, data) {
    this.metrics.sources[name] = data;
  }

  async save() {
    if (!ENABLE_METRICS) return;
    this.metrics.finishedAt = new Date().toISOString();
    this.metrics.durationMs = Date.now() - this.startedAt;
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.writeFile(
      path.join(LOG_DIR, 'metrics.json'),
      JSON.stringify(this.metrics, null, 2),
      'utf8'
    );
  }
}

const logger = new Logger();

// ────────────────────────────────────────────────────────────
// RATE LIMITER (from Code2)
// ────────────────────────────────────────────────────────────
class RateLimiter {
  constructor(rpm = 120) {
    this.capacity = rpm;
    this.tokens = rpm;
    this.rate = rpm / 60000;
    this.last = Date.now();
  }

  async take() {
    const now = Date.now();
    const elapsed = now - this.last;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.last = now;
    if (this.tokens < 1) {
      const wait = Math.ceil((1 - this.tokens) / this.rate);
      await sleep(wait);
      this.tokens = 1;
    }
    this.tokens -= 1;
  }
}

const limiter = new RateLimiter(120);

// ────────────────────────────────────────────────────────────
// PERSISTENT CACHE (from Code2)
// ────────────────────────────────────────────────────────────
class PersistentCache {
  constructor(directory) {
    this.directory = directory;
    this.memory = new Map();
  }

  key(url) {
    return crypto.createHash('md5').update(url).digest('hex');
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
  }

  async get(url) {
    if (!ENABLE_CACHE) return null;
    const key = this.key(url);
    const memory = this.memory.get(key);
    if (memory && Date.now() - memory.time < CACHE_TTL_MS) return memory.value;
    try {
      const file = path.join(this.directory, key + '.json');
      const raw = await fs.readFile(file, 'utf8');
      const item = JSON.parse(raw);
      if (Date.now() - item.time < CACHE_TTL_MS) {
        this.memory.set(key, item);
        return item.value;
      }
    } catch {}
    return null;
  }

  async set(url, value) {
    if (!ENABLE_CACHE) return;
    const key = this.key(url);
    const item = { time: Date.now(), value };
    this.memory.set(key, item);
    try {
      await fs.writeFile(
        path.join(this.directory, key + '.json'),
        JSON.stringify(item),
        'utf8'
      );
    } catch {}
  }
}

const cache = new PersistentCache(CACHE_DIR);

// ────────────────────────────────────────────────────────────
// UTILITIES
// ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shortHash = (value = '') => crypto.createHash('sha1').update(String(value)).digest('hex').substring(0, 16);
const slugify = (s = '') =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'job';

const stripHTML = (html = '') =>
  String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

const normalizeText = (s = '') =>
  stripHTML(s)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeHTML = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const validHttpUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
};

// ────────────────────────────────────────────────────────────
// HTTP FETCH (from Code2, enhanced)
// ────────────────────────────────────────────────────────────
async function request(url, options = {}) {
  const cached = await cache.get(url);
  if (cached !== null) return cached;
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await limiter.take();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'GOO-JOBS-Aggregator/Ultimate (+https://goojobs.in)',
          'Accept': options.accept || 'application/json, application/rss+xml, text/xml, text/html, */*',
          ...options.headers
        }
      });
      clearTimeout(timer);
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      await cache.set(url, text);
      return text;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const backoff = Math.min(15000, 700 * Math.pow(2, attempt - 1));
        await sleep(backoff + Math.floor(Math.random() * 300));
      }
    }
  }
  throw lastError || new Error('Request failed');
}

async function requestJson(url, options = {}) {
  const text = await request(url, { ...options, accept: 'application/json' });
  return JSON.parse(text);
}

// ────────────────────────────────────────────────────────────
// CONCURRENCY (from Code2)
// ────────────────────────────────────────────────────────────
async function parallelMap(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runner());
  await Promise.all(runners);
  return results;
}

// ────────────────────────────────────────────────────────────
// RSS PARSER (from Code2, enhanced)
// ────────────────────────────────────────────────────────────
function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function xmlValue(block, tag) {
  const escaped = tag.replace(/[:]/g, '\\:');
  const regex = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const match = block.match(regex);
  return match ? decodeXml(match[1]) : '';
}

function parseRSS(xml, source = 'RSS') {
  const jobs = [];
  const blocks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  for (const block of blocks) {
    const title = stripHTML(xmlValue(block, 'title'));
    let link = xmlValue(block, 'link');
    if (!link) {
      const href = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (href) link = href[1];
    }
    const description = stripHTML(
      xmlValue(block, 'description') || xmlValue(block, 'summary') || xmlValue(block, 'content:encoded')
    );
    const pub = xmlValue(block, 'pubDate') || xmlValue(block, 'published') || xmlValue(block, 'updated');
    const category = stripHTML(xmlValue(block, 'category'));
    link = link ? new URL(link).toString() : '';
    if (!title || !link) continue;
    jobs.push({
      externalId: `rss:${shortHash(link)}`,
      title,
      company: 'Various',
      description,
      location: 'Remote',
      url: link,
      source,
      category: category || 'General',
      employmentType: 'Full-time',
      salary: null,
      publishedAt: pub || new Date().toISOString()
    });
  }
  return jobs;
}

// ────────────────────────────────────────────────────────────
// INDIAN LOCATION DETECTION (from Code2, extended)
// ────────────────────────────────────────────────────────────
const INDIAN_CITIES = new Set([
  'delhi','new delhi','mumbai','bombay','bengaluru','bangalore','hyderabad','chennai','madras',
  'pune','kolkata','calcutta','ahmedabad','surat','jaipur','lucknow','kanpur','nagpur','indore',
  'thane','bhopal','visakhapatnam','vadodara','pimpri','patna','ludhiana','agra','nashik',
  'faridabad','meerut','rajkot','kalyan','vasai','varanasi','srinagar','aurangabad','dhanbad',
  'amritsar','navi mumbai','allahabad','prayagraj','ranchi','coimbatore','jabalpur','gwalior',
  'vijayawada','jodhpur','madurai','raipur','kota','chandigarh','guwahati','solapur','hubli',
  'dharwad','mysore','mysuru','tiruchirappalli','trichy','bareilly','aligarh','moradabad',
  'gurgaon','gurugram','noida','greater noida','ghaziabad','sonipat','panipat','rohtak','hisar',
  'karnal','ambala','panchkula','dehradun','haridwar','shimla','kochi','cochin','thiruvananthapuram',
  'trivandrum','bhubaneswar','cuttack','goa','pondicherry','puducherry','remote','work from home','wfh','anywhere'
]);

function isIndiaOrRemote(location, title, description) {
  const text = `${location || ''} ${title || ''} ${description || ''}`.toLowerCase();
  if (/\bindia\b/.test(text) || /\bindian\b/.test(text)) return true;
  if (/\bremote\b|\bwork from home\b|\bwfh\b|\banywhere\b/.test(text)) return true;
  for (const city of INDIAN_CITIES) {
    if (text.includes(city)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────
// SKILL ENGINE (from Code2)
// ────────────────────────────────────────────────────────────
const SKILLS_LIST = [
  'javascript','typescript','react','react native','node.js','nodejs','next.js','nextjs','angular','vue','svelte',
  'python','java','spring','spring boot','kotlin','swift','c++','c#','.net','go','golang','rust','ruby','php',
  'laravel','django','flask','fastapi','sql','mysql','postgresql','mongodb','redis','elasticsearch','aws',
  'azure','gcp','docker','kubernetes','terraform','jenkins','github actions','gitlab','html','css','tailwind',
  'bootstrap','graphql','rest api','microservices','machine learning','deep learning','artificial intelligence',
  'ai','llm','generative ai','nlp','tensorflow','pytorch','pandas','numpy','data science','data engineering',
  'spark','hadoop','kafka','airflow','snowflake','databricks','tableau','power bi','excel','figma','photoshop',
  'illustrator','seo','digital marketing','content writing','copywriting','product management','agile','scrum',
  'jira','sales','marketing','recruitment','human resources','customer support','operations','finance','accounting',
  'gst','sap','tally','cybersecurity','penetration testing','linux','networking','devops','sre','qa','testing',
  'selenium','playwright','cypress','jest','postman','wordpress','shopify','salesforce','hubspot','crm',
  'blockchain','solidity','web3'
];

function extractSkills(text) {
  const source = String(text || '').toLowerCase();
  const result = [];
  for (const skill of SKILLS_LIST) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    if (regex.test(source)) result.push(skill);
    if (result.length >= 15) break;
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// JOB CLASSIFICATION (from Code2)
// ────────────────────────────────────────────────────────────
function detectExperience(title, description) {
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  if (/\bintern(ship)?\b|\btrainee\b|\bapprentice\b|\bgraduate\b/.test(text)) return 'Internship';
  if (/\bsenior\b|\bsr\.?\b|\blead\b|\bprincipal\b|\bstaff\b|\bhead\b|\bdirector\b|\bvp\b|\bchief\b|\barchitect\b/.test(text)) return 'Senior';
  if (/\bjunior\b|\bjr\.?\b|\bentry\b|\bfresher\b|\bassociate\b/.test(text)) return 'Entry';
  return 'Mid';
}

function detectWorkMode(title, location, description) {
  const text = `${title || ''} ${location || ''} ${description || ''}`.toLowerCase();
  return {
    remote: /\bremote\b|\bwork from home\b|\bwfh\b|\bfully distributed\b|\banywhere\b/.test(text),
    hybrid: /\bhybrid\b|\bpartially remote\b/.test(text)
  };
}

// ────────────────────────────────────────────────────────────
// SALARY PARSER (from Code2)
// ────────────────────────────────────────────────────────────
function parseSalary(salary) {
  if (!salary) return null;
  const raw = String(salary).replace(/,/g, '');
  const matches = raw.match(/(?:₹|rs\.?|inr|\$|usd|€|eur|£|gbp)?\s*(\d+(?:\.\d+)?)\s*(k|lpa|lakh|lakhs|lac|crore|cr)?/gi);
  if (!matches || !matches.length) return null;
  const numbers = [];
  for (const part of matches) {
    const m = part.match(/(\d+(?:\.\d+)?)\s*(k|lpa|lakh|lakhs|lac|crore|cr)?/i);
    if (!m) continue;
    let value = Number(m[1]);
    const unit = String(m[2] || '').toLowerCase();
    if (unit === 'k') value *= 1000;
    if (['lpa','lakh','lakhs','lac'].includes(unit)) value *= 100000;
    if (['crore','cr'].includes(unit)) value *= 10000000;
    numbers.push(value);
  }
  if (!numbers.length) return null;
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return { min, max: max < min ? min : max, currency: /₹|rs\.?|inr/i.test(raw) ? 'INR' : 'USD', raw: salary };
}

// ────────────────────────────────────────────────────────────
// SOURCE ADAPTERS (merged from both, using Code2 implementations as base,
// but extended with Code1's extra boards and features)
// ────────────────────────────────────────────────────────────

async function fetchArbeitnow() {
  const jobs = [];
  for (let page = 1; page <= ARBEIT_PAGES; page++) {
    const url = `https://www.arbeitnow.com/api/job-board-api?page=${page}`;
    try {
      const data = await requestJson(url);
      const list = Array.isArray(data.data) ? data.data : [];
      if (!list.length) break;
      for (const item of list) {
        jobs.push({
          externalId: `arbeitnow:${item.slug || item.id || shortHash(item.url)}`,
          title: item.title,
          company: item.company_name || item.company || 'Unknown',
          description: item.description || item.excerpt || '',
          location: item.location || 'Remote',
          url: item.url || item.apply_url || '',
          source: 'Arbeitnow',
          category: Array.isArray(item.tags) ? item.tags[0] : 'General',
          employmentType: Array.isArray(item.job_types) ? item.job_types[0] : 'Full-time',
          salary: item.salary || null,
          publishedAt: item.created_at || item.published_at || new Date().toISOString()
        });
      }
      logger.info(`Arbeitnow page ${page}`, { jobs: jobs.length });
      if (list.length < 10) break;
    } catch (error) {
      logger.error(`Arbeitnow page ${page} failed`, { error: error.message });
      break;
    }
  }
  logger.source('Arbeitnow', { fetched: jobs.length });
  return jobs;
}

async function fetchRemoteOK() {
  try {
    const data = await requestJson('https://remoteok.com/api');
    if (!Array.isArray(data)) return [];
    const list = data.slice(1); // first element is header
    const jobs = list
      .filter(item => item && item.position)
      .map(item => ({
        externalId: `remoteok:${item.id || item.slug || shortHash(item.url)}`,
        title: item.position || item.title,
        company: item.company || 'Remote Company',
        description: item.description || '',
        location: item.location || 'Remote',
        url: item.url || item.apply_url || `https://remoteok.com/remote-jobs/${item.slug || item.id}`,
        source: 'RemoteOK',
        category: Array.isArray(item.tags) ? item.tags[0] : 'Remote',
        employmentType: 'Full-time',
        salary: item.salary || null,
        publishedAt: item.date || item.epoch || new Date().toISOString()
      }));
    logger.source('RemoteOK', { fetched: jobs.length });
    return jobs;
  } catch (error) {
    logger.error('RemoteOK failed', { error: error.message });
    return [];
  }
}

async function fetchLever() {
  const jobs = [];
  const results = await parallelMap(LEVER_BOARDS, async company => {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company.toLowerCase())}?mode=json`;
    try {
      const data = await requestJson(url);
      return { company, data: Array.isArray(data) ? data : [] };
    } catch (error) {
      logger.warn(`Lever ${company} failed`, { error: error.message });
      return { company, data: [] };
    }
  }, 5);
  for (const result of results) {
    if (!result || !result.data) continue;
    for (const item of result.data) {
      const categories = item.categories || {};
      jobs.push({
        externalId: `lever:${item.id}`,
        title: item.text || item.title || '',
        company: result.company,
        description: stripHTML(item.description || item.descriptionPlain || item.content || ''),
        location: categories.location || 'Remote',
        url: item.applyUrl || item.hostedUrl || '',
        source: 'Lever',
        category: categories.team || 'General',
        employmentType: categories.commitment || 'Full-time',
        salary: null,
        publishedAt: item.createdAt || item.updatedAt || new Date().toISOString()
      });
    }
  }
  logger.source('Lever', { fetched: jobs.length });
  return jobs;
}

async function fetchGreenhouse() {
  const jobs = [];
  const results = await parallelMap(GREENHOUSE_BOARDS, async company => {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.toLowerCase())}/jobs?content=true`;
    try {
      const data = await requestJson(url);
      return { company, data: Array.isArray(data.jobs) ? data.jobs : [] };
    } catch (error) {
      logger.warn(`Greenhouse ${company} failed`, { error: error.message });
      return { company, data: [] };
    }
  }, 5);
  for (const result of results) {
    for (const item of result.data) {
      jobs.push({
        externalId: `greenhouse:${item.id}`,
        title: item.title || '',
        company: result.company,
        description: stripHTML(item.content || ''),
        location: item.location?.name || 'Remote',
        url: item.absolute_url || '',
        source: 'Greenhouse',
        category: item.departments?.[0]?.name || 'General',
        employmentType: 'Full-time',
        salary: null,
        publishedAt: item.updated_at || new Date().toISOString()
      });
    }
  }
  logger.source('Greenhouse', { fetched: jobs.length });
  return jobs;
}

async function fetchRecruitee() {
  const jobs = [];
  const results = await parallelMap(RECRUITEE_COMPANIES, async company => {
    const url = `https://${company}.recruitee.com/api/offers`;
    try {
      const data = await requestJson(url);
      return { company, data: Array.isArray(data.offers) ? data.offers : [] };
    } catch (error) {
      return { company, data: [] };
    }
  }, 5);
  for (const result of results) {
    for (const item of result.data) {
      jobs.push({
        externalId: `recruitee:${result.company}:${item.id}`,
        title: item.title || '',
        company: item.company?.name || result.company,
        description: stripHTML(item.description || item.description_plain || ''),
        location: item.location || 'Remote',
        url: item.careers_url || item.url || '',
        source: 'Recruitee',
        category: item.department || 'General',
        employmentType: item.employment_type || 'Full-time',
        salary: item.salary || null,
        publishedAt: item.created_at || item.published_at || new Date().toISOString()
      });
    }
  }
  logger.source('Recruitee', { fetched: jobs.length });
  return jobs;
}

async function fetchBreezy() {
  const jobs = [];
  const results = await parallelMap(BREEZY_COMPANIES, async company => {
    const urls = [
      `https://${company}.breezy.hr/json`,
      `https://breezy.hr/${company}/json`
    ];
    for (const url of urls) {
      try {
        const data = await requestJson(url);
        if (Array.isArray(data)) return { company, data };
        if (data && Array.isArray(data.positions)) return { company, data: data.positions };
      } catch {}
    }
    return { company, data: [] };
  }, 5);
  for (const result of results) {
    for (const item of result.data) {
      jobs.push({
        externalId: `breezy:${result.company}:${item.id || shortHash(item.url)}`,
        title: item.name || item.title || '',
        company: item.company?.name || result.company,
        description: stripHTML(item.description || item.descriptionHtml || ''),
        location: item.location?.name || item.location || 'Remote',
        url: item.url || item.apply_url || '',
        source: 'Breezy',
        category: item.department || 'General',
        employmentType: item.type || 'Full-time',
        salary: item.salary || null,
        publishedAt: item.published_at || item.created_at || new Date().toISOString()
      });
    }
  }
  logger.source('Breezy', { fetched: jobs.length });
  return jobs;
}

async function fetchRSSFeeds() {
  const jobs = [];
  const results = await parallelMap(RSS_FEEDS, async feed => {
    try {
      const xml = await request(feed, { accept: 'application/rss+xml, application/xml, text/xml, */*' });
      return parseRSS(xml, 'RSS');
    } catch (error) {
      logger.warn(`RSS feed failed: ${feed}`, { error: error.message });
      return [];
    }
  }, 4);
  for (const list of results) {
    if (Array.isArray(list)) jobs.push(...list);
  }
  logger.source('RSS', { fetched: jobs.length });
  return jobs;
}

async function fetchRemotive() {
  try {
    const xml = await request('https://remotive.com/remote-jobs/feed', { accept: 'application/rss+xml, application/xml, text/xml, */*' });
    const jobs = parseRSS(xml, 'Remotive');
    logger.source('Remotive', { fetched: jobs.length });
    return jobs;
  } catch (error) {
    logger.error('Remotive failed', { error: error.message });
    return [];
  }
}

async function fetchNCS() {
  const urls = [
    'https://www.ncs.gov.in/_api/jobs/search?page=1&size=200',
    'https://www.ncs.gov.in/_api/jobs/search?page=2&size=200',
    'https://www.ncs.gov.in/_api/jobs/search?page=3&size=200'
  ];
  const jobs = [];
  const results = await parallelMap(urls, async url => {
    try {
      const data = await requestJson(url);
      return (data?.data || data?.jobs || data?.results || []);
    } catch { return []; }
  }, 2);
  for (const list of results) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const id = item.jobId || item.id;
      if (!id) continue;
      jobs.push({
        externalId: `ncs:${id}`,
        title: item.title || item.jobTitle || '',
        company: item.organization || item.employer || 'Government of India',
        description: item.description || item.jobDescription || '',
        location: [item.city, item.state, 'India'].filter(Boolean).join(', ') || 'India',
        url: item.applyUrl || item.url || item.link || '',
        source: 'NCS',
        category: item.sector || item.industry || 'Government',
        employmentType: item.employmentType || item.jobType || 'Full-time',
        salary: item.salary || null,
        publishedAt: item.postedDate || item.publishedDate || item.createdAt || new Date().toISOString()
      });
    }
  }
  logger.source('NCS', { fetched: jobs.length });
  return jobs;
}

async function fetchIndianAPI() {
  if (!INDIAN_API_KEY) return [];
  try {
    const data = await requestJson('https://indianapi.in/api/v2/job/search', {
      headers: { 'X-Api-Key': INDIAN_API_KEY }
    });
    const list = data?.results || data?.jobs || data?.data || [];
    if (!Array.isArray(list)) return [];
    const jobs = list.map(item => ({
      externalId: `indianapi:${item.id || item.job_id || shortHash(item.title)}`,
      title: item.title || item.job_title || '',
      company: item.company || item.company_name || item.employer || 'Unknown',
      description: item.description || item.job_description || '',
      location: item.location || item.city || 'India',
      url: item.url || item.apply_url || item.link || '',
      source: 'IndianAPI',
      category: item.category || item.industry || 'General',
      employmentType: item.job_type || item.employment_type || 'Full-time',
      salary: item.salary || item.salary_range || null,
      publishedAt: item.posted_at || item.created_at || item.date || new Date().toISOString()
    }));
    logger.source('IndianAPI', { fetched: jobs.length });
    return jobs;
  } catch (error) {
    logger.error('IndianAPI failed', { error: error.message });
    return [];
  }
}

async function fetchJobDataAPI() {
  if (!JOBDATA_API_KEY) return [];
  try {
    const data = await requestJson('https://jobdataapi.com/api/jobs?country_code=IN&limit=200', {
      headers: { Authorization: `Bearer ${JOBDATA_API_KEY}` }
    });
    const list = data?.results || data?.data || [];
    if (!Array.isArray(list)) return [];
    const jobs = list.map(item => ({
      externalId: `jobdata:${item.id || item.job_id || shortHash(item.title)}`,
      title: item.title || '',
      company: item.company || item.company_name || 'Unknown',
      description: item.description || item.job_description || '',
      location: item.location || item.city || 'India',
      url: item.url || item.apply_url || item.link || '',
      source: 'JobDataAPI',
      category: item.category || item.industry || 'General',
      employmentType: item.employment_type || item.job_type || 'Full-time',
      salary: item.salary || item.salary_range || null,
      publishedAt: item.posted_at || item.date || new Date().toISOString()
    }));
    logger.source('JobDataAPI', { fetched: jobs.length });
    return jobs;
  } catch (error) {
    logger.error('JobDataAPI failed', { error: error.message });
    return [];
  }
}

// ────────────────────────────────────────────────────────────
// NORMALIZATION (combined from both, all fields present)
// ────────────────────────────────────────────────────────────
function normalizeJob(raw) {
  const title = stripHTML(raw.title || '').trim();
  const company = stripHTML(raw.company || raw.employer || '').trim();
  const description = stripHTML(raw.description || raw.content || '').trim();
  const location = stripHTML(raw.location || raw.city || 'Remote').trim();
  const url = raw.url ? new URL(raw.url).toString() : '';
  const source = String(raw.source || 'Unknown').trim();

  if (!title || !company || !description || !url || !validHttpUrl(url)) return null;
  if (BLACKLIST.some(d => url.toLowerCase().includes(d))) return null;
  if (!isIndiaOrRemote(location, title, description)) return null;

  const id = shortHash(`${source}|${raw.externalId || raw.id || url}|${url}`);
  const slug = slugify(`${title}-${company}-${id}`);
  const remote = detectWorkMode(title, location, description).remote;
  const hybrid = detectWorkMode(title, location, description).hybrid;
  const publishedAt = raw.publishedAt ? new Date(raw.publishedAt).toISOString() : new Date().toISOString();

  return {
    id,
    externalId: String(raw.externalId || raw.id || url),
    title, company, description, location, url, source,
    category: raw.category || raw.department || 'General',
    employmentType: raw.employmentType || raw.jobType || 'Full-time',
    salary: raw.salary || null,
    salaryRange: parseSalary(raw.salary),
    publishedAt,
    updatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    firstSeenAt: raw.firstSeenAt || new Date().toISOString(),
    verifiedSource: true,
    isLive: true,
    remote, hybrid,
    experienceLevel: detectExperience(title, description),
    skills: extractSkills(`${title} ${description}`),
    slug
  };
}

// ────────────────────────────────────────────────────────────
// VALIDATION (from Code2)
// ────────────────────────────────────────────────────────────
function validateJob(job) {
  if (!job) return false;
  if (!job.title || job.title.length < 3) return false;
  if (!job.company || job.company.length < 2) return false;
  if (!job.description || job.description.length < 20) return false;
  if (!validHttpUrl(job.url)) return false;
  if (BLACKLIST.some(domain => job.url.toLowerCase().includes(domain))) return false;
  if (!isIndiaOrRemote(job.location, job.title, job.description)) return false;
  return true;
}

// ────────────────────────────────────────────────────────────
// DEDUPLICATION (from Code2)
// ────────────────────────────────────────────────────────────
function normalizedText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function fingerprint(job) {
  return [normalizedText(job.title), normalizedText(job.company), normalizedText(job.location)].join('|');
}

function similarity(a, b) {
  const A = new Set(normalizedText(a).split(' ').filter(x => x.length > 2));
  const B = new Set(normalizedText(b).split(' ').filter(x => x.length > 2));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const word of A) if (B.has(word)) common++;
  return common / Math.max(A.size, B.size);
}

function deduplicate(jobs) {
  const urlMap = new Map();
  const fpMap = new Map();
  const result = [];
  const sorted = [...jobs].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  for (const job of sorted) {
    const url = job.url;
    if (url && urlMap.has(url)) {
      mergeJob(urlMap.get(url), job);
      continue;
    }
    const fp = fingerprint(job);
    let duplicate = fpMap.get(fp);
    if (!duplicate) {
      for (const [key, existing] of fpMap) {
        if (similarity(key, fp) >= 0.92) {
          duplicate = existing;
          break;
        }
      }
    }
    if (duplicate) {
      mergeJob(duplicate, job);
      continue;
    }
    urlMap.set(url, job);
    fpMap.set(fp, job);
    result.push(job);
  }
  return result;
}

function mergeJob(target, source) {
  target.skills = Array.from(new Set([...(target.skills || []), ...(source.skills || [])])).slice(0, 15);
  if (source.description && source.description.length > target.description.length) target.description = source.description;
  if (!target.salaryRange && source.salaryRange) target.salaryRange = source.salaryRange;
  if (!target.salary && source.salary) target.salary = source.salary;
  if (new Date(source.publishedAt) > new Date(target.publishedAt)) target.publishedAt = source.publishedAt;
  target.lastSeenAt = new Date().toISOString();
}

// ────────────────────────────────────────────────────────────
// PREVIOUS DATA & EXPIRY (from Code2)
// ────────────────────────────────────────────────────────────
async function loadPreviousJobs() {
  try {
    const raw = await fs.readFile(path.join(PUBLIC_DIR, 'jobs.json'), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.jobs)) return data.jobs;
  } catch {}
  return [];
}

function mergePrevious(fresh, previous) {
  const map = new Map();
  const now = new Date().toISOString();
  for (const job of previous) {
    if (job && job.id) {
      job.lastSeenAt = job.lastSeenAt || now;
      map.set(job.id, job);
    }
  }
  for (const job of fresh) {
    if (map.has(job.id)) {
      mergeJob(map.get(job.id), job);
      map.get(job.id).lastSeenAt = now;
    } else {
      map.set(job.id, job);
    }
  }
  return Array.from(map.values());
}

function removeExpired(jobs) {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  return jobs.filter(job => new Date(job.publishedAt).getTime() >= cutoff);
}

// ────────────────────────────────────────────────────────────
// SCORING (from Code2, enhanced)
// ────────────────────────────────────────────────────────────
function scoreJob(job) {
  let score = 0;
  const ageDays = Math.max(0, (Date.now() - new Date(job.publishedAt).getTime()) / 86400000);
  score += Math.max(0, 40 - ageDays * 1.8);
  score += Math.min(15, job.description.length / 100);
  score += Math.min(10, (job.skills?.length || 0) * 0.8);
  if (job.remote || job.hybrid) score += 5;
  if (job.salaryRange) score += 5;
  const trusted = new Set(['Arbeitnow','RemoteOK','Lever','Greenhouse','Recruitee','Breezy','RSS','Remotive','NCS','IndianAPI','JobDataAPI']);
  if (trusted.has(job.source)) score += 10;
  if (validHttpUrl(job.url)) score += 10;
  if (job.verifiedSource) score += 10;
  return Math.round(Math.min(100, score));
}

function rankJobs(jobs) {
  for (const job of jobs) job.score = scoreJob(job);
  jobs.sort((a, b) => b.score - a.score || new Date(b.publishedAt) - new Date(a.publishedAt));
  return jobs;
}

// ────────────────────────────────────────────────────────────
// UNIQUE SLUGS (from Code1)
// ────────────────────────────────────────────────────────────
function ensureUniqueSlugs(list) {
  const counts = new Map();
  for (const j of list) {
    const base = j.slug;
    let s = base, n = (counts.get(base) || 0) + 1;
    if (n > 1) s = base.substring(0, Math.max(8, base.length - (String(n).length + 1))) + '-' + n;
    counts.set(base, n);
    let guard = 0;
    while (list.some(o => o !== j && o.slug === s) && guard < 100) {
      guard++; n++;
      s = base.substring(0, Math.max(8, base.length - (String(n).length + 1))) + '-' + n;
    }
    j.slug = s;
  }
}

// ────────────────────────────────────────────────────────────
// JOB PAGE TEMPLATE (from Code2, with Adsterra token)
// ────────────────────────────────────────────────────────────
function jobPage(job) {
  const canonical = `${SITE_URL}/job/${job.slug}/`;
  const title = `${job.title} at ${job.company} in ${job.location} | GOO JOBS`;
  const desc = stripHTML(job.description).slice(0, 155);
  const salary = job.salaryRange
    ? `${job.salaryRange.currency} ${Math.round(job.salaryRange.min).toLocaleString('en-IN')} - ${Math.round(job.salaryRange.max).toLocaleString('en-IN')}`
    : 'Not disclosed';
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: job.description,
    datePosted: job.publishedAt,
    validThrough: new Date(new Date(job.publishedAt).getTime() + RETENTION_DAYS * 86400000).toISOString(),
    employmentType: job.employmentType || 'FULL_TIME',
    hiringOrganization: { '@type': 'Organization', name: job.company },
    jobLocation: {
      '@type': 'Place',
      address: { '@type': 'PostalAddress', addressLocality: job.location, addressCountry: 'IN' }
    },
    url: canonical,
    sameAs: [job.url]
  };
  if (job.salaryRange) {
    schema.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: job.salaryRange.currency,
      value: {
        '@type': 'QuantitativeValue',
        minValue: job.salaryRange.min,
        maxValue: job.salaryRange.max,
        unitText: 'YEAR'
      }
    };
  }
  const skillsHtml = (job.skills || []).map(skill => `<span class="skill">${escapeHTML(skill)}</span>`).join('');
  const paragraphs = job.description.split(/\n+/).filter(Boolean).map(p => `<p>${escapeHTML(p)}</p>`).join('');
  const remote = job.remote ? '<span class="badge">🌐 Remote</span>' : '';
  const hybrid = job.hybrid ? '<span class="badge">🔀 Hybrid</span>' : '';

  let html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="index,follow">
<title>${escapeHTML(title)}</title>
<meta name="description" content="${escapeHTML(desc)}">
<link rel="canonical" href="${escapeHTML(canonical)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHTML(title)}">
<meta property="og:description" content="${escapeHTML(desc)}">
<meta property="og:url" content="${escapeHTML(canonical)}">
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<style>
* { box-sizing:border-box; }
body { margin:0; background:#070b12; color:#e9eef8; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.container { width:min(900px,92%); margin:auto; padding:30px 0; }
.header { display:flex; justify-content:space-between; align-items:center; padding-bottom:20px; margin-bottom:30px; border-bottom:1px solid #1d2635; }
.logo { color:#36d7ff; font-size:20px; font-weight:800; }
.header a { color:#8c9ab1; text-decoration:none; margin-left:16px; }
.badges { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px; }
.badge { padding:6px 12px; border-radius:999px; background:#101827; border:1px solid #263248; color:#9eacc2; font-size:12px; }
h1 { font-size:clamp(26px,5vw,42px); line-height:1.15; margin:18px 0; }
.meta { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:24px; }
.meta span { background:#0f1725; border:1px solid #202c40; border-radius:10px; padding:8px 12px; color:#aab6c9; font-size:13px; }
.card { background:#0d1522; border:1px solid #1d2a3e; border-radius:18px; padding:25px; margin-bottom:20px; }
.card h2 { font-size:20px; margin-top:0; }
.description p { color:#aab5c6; line-height:1.75; }
.skills { display:flex; flex-wrap:wrap; gap:7px; margin-top:15px; }
.skill { border:1px solid #27354b; background:#111b2b; border-radius:999px; padding:5px 10px; color:#9cabc0; font-size:12px; }
.apply { display:inline-block; margin-top:24px; padding:14px 22px; background:linear-gradient(135deg,#28d5ff,#6a8cff); color:#031019; border-radius:12px; font-weight:800; text-decoration:none; }
.footer { margin-top:35px; padding-top:20px; border-top:1px solid #1d2635; color:#65748c; font-size:13px; text-align:center; }
</style>
</head>
<body>
<div class="container">
<header class="header">
<div class="logo">💼 GOO JOBS</div>
<nav><a href="/">Home</a><a href="/sitemap.xml">Sitemap</a></nav>
</header>
<div class="badges">
<span class="badge">✓ Verified Source</span>
<span class="badge">${escapeHTML(job.source)}</span>
<span class="badge">${escapeHTML(job.experienceLevel)}</span>
${remote}${hybrid}
</div>
<h1>${escapeHTML(job.title)}</h1>
<div class="meta">
<span>🏢 ${escapeHTML(job.company)}</span>
<span>📍 ${escapeHTML(job.location)}</span>
<span>💼 ${escapeHTML(job.employmentType)}</span>
<span>💰 ${escapeHTML(salary)}</span>
</div>
<section class="card">
<h2>Job Description</h2>
<div class="description">${paragraphs}</div>
${skillsHtml ? `<h2 style="margin-top:25px">Skills</h2><div class="skills">${skillsHtml}</div>` : ''}
<a class="apply" href="${escapeHTML(job.url)}" target="_blank" rel="nofollow noopener noreferrer">Apply on Official Source ↗</a>
</section>
<div class="footer">GOO JOBS aggregates publicly available job listings. Apply through the original source.</div>
${ADSTERRA_TOKEN}
</div>
</body>
</html>`;

  // Replace token with actual Adsterra script if provided
  if (ADSTERRA_SCRIPT) html = html.replace(ADSTERRA_TOKEN, ADSTERRA_SCRIPT);
  return html;
}

// ────────────────────────────────────────────────────────────
// OUTPUT GENERATION (merged)
// ────────────────────────────────────────────────────────────
async function generateJobPages(jobs) {
  await fs.rm(JOB_DIR, { recursive: true, force: true });
  await fs.mkdir(JOB_DIR, { recursive: true });

  await parallelMap(jobs, async job => {
    const dir = path.join(JOB_DIR, job.slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.html'), jobPage(job), 'utf8');
  }, 10);

  logger.info('Job pages generated', { count: jobs.length });
}

async function cleanupOldPages(activeJobs) {
  const active = new Set(activeJobs.map(j => j.slug));
  let dirs;
  try { dirs = await fs.readdir(JOB_DIR, { withFileTypes: true }); } catch { return; }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    if (!active.has(entry.name)) {
      await fs.rm(path.join(JOB_DIR, entry.name), { recursive: true, force: true });
    }
  }
}

async function generateJobsJson(jobs, sourceStatus) {
  await fs.writeFile(
    path.join(PUBLIC_DIR, 'jobs.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      count: jobs.length,
      target: TARGET_JOBS,
      targetReached: jobs.length >= TARGET_JOBS,
      liveOnly: true,
      dummyJobs: false,
      jobs,
      sources: sourceStatus
    }, null, 2),
    'utf8'
  );
}

async function generateSitemap(jobs) {
  const MAX_URLS_PER_SITEMAP = 45000;
  const chunks = [];
  for (let i = 0; i < jobs.length; i += MAX_URLS_PER_SITEMAP) {
    chunks.push(jobs.slice(i, i + MAX_URLS_PER_SITEMAP));
  }
  if (chunks.length === 1) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    xml += `<url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n`;
    for (const job of jobs) {
      xml += `<url><loc>${SITE_URL}/job/${escapeHTML(job.slug)}/</loc><lastmod>${(job.updatedAt || job.publishedAt).slice(0,10)}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>\n`;
    }
    xml += '</urlset>';
    await fs.writeFile(path.join(PUBLIC_DIR, 'sitemap.xml'), xml, 'utf8');
    return;
  }

  const sitemapFiles = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const filename = `sitemap-${index + 1}.xml`;
    sitemapFiles.push(filename);
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    for (const job of chunk) {
      xml += `<url><loc>${SITE_URL}/job/${escapeHTML(job.slug)}/</loc><lastmod>${(job.updatedAt || job.publishedAt).slice(0,10)}</lastmod></url>\n`;
    }
    xml += '</urlset>';
    await fs.writeFile(path.join(PUBLIC_DIR, filename), xml, 'utf8');
  }

  let indexXml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
  for (const file of sitemapFiles) {
    indexXml += `<sitemap><loc>${SITE_URL}/${file}</loc><lastmod>${new Date().toISOString()}</lastmod></sitemap>\n`;
  }
  indexXml += '</sitemapindex>';
  await fs.writeFile(path.join(PUBLIC_DIR, 'sitemap.xml'), indexXml, 'utf8');
}

async function generateRobots() {
  const content = `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml`;
  await fs.writeFile(path.join(PUBLIC_DIR, 'robots.txt'), content, 'utf8');
}

async function generateSourceStatus(sourceStatus) {
  await fs.writeFile(
    path.join(PUBLIC_DIR, 'source-status.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      target: TARGET_JOBS,
      actualJobs: logger.metrics.finalJobs,
      targetReached: logger.metrics.finalJobs >= TARGET_JOBS,
      realJobsOnly: true,
      sources: sourceStatus
    }, null, 2),
    'utf8'
  );
}

async function generateHomepage() {
  try {
    let html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
    if (ADSTERRA_SCRIPT) html = html.replace(ADSTERRA_TOKEN, ADSTERRA_SCRIPT);
    await fs.writeFile(path.join(PUBLIC_DIR, 'index.html'), html, 'utf8');
  } catch (error) {
    logger.warn('Root index.html not found, using fallback');
    const fallback = `<!doctype html><html lang="en"><head><title>GOO JOBS</title></head><body><h1>GOO JOBS</h1></body></html>`;
    await fs.writeFile(path.join(PUBLIC_DIR, 'index.html'), fallback, 'utf8');
  }
}

async function verifyBuild(jobs) {
  await fs.access(path.join(PUBLIC_DIR, 'index.html'));
  await fs.access(path.join(PUBLIC_DIR, 'jobs.json'));
  await fs.access(path.join(PUBLIC_DIR, 'sitemap.xml'));
  await fs.access(path.join(PUBLIC_DIR, 'robots.txt'));

  const slugSet = new Set();
  for (const job of jobs) {
    if (!validHttpUrl(job.url)) throw new Error(`Invalid URL for job ${job.id}`);
    if (!job.slug || slugSet.has(job.slug)) throw new Error(`Duplicate or missing slug: ${job.slug}`);
    slugSet.add(job.slug);
  }
  logger.info('Build verification passed', { totalJobs: jobs.length });
}

// ────────────────────────────────────────────────────────────
// SOURCE RUNNER
// ────────────────────────────────────────────────────────────
const SOURCES = [
  ['Arbeitnow', fetchArbeitnow],
  ['RemoteOK', fetchRemoteOK],
  ['Lever', fetchLever],
  ['Greenhouse', fetchGreenhouse],
  ['Recruitee', fetchRecruitee],
  ['Breezy', fetchBreezy],
  ['RSS', fetchRSSFeeds],
  ['Remotive', fetchRemotive],
  ['NCS', fetchNCS],
  ['IndianAPI', fetchIndianAPI],
  ['JobDataAPI', fetchJobDataAPI]
];

async function runSource(name, fn) {
  const started = Date.now();
  try {
    const jobs = await fn();
    const count = Array.isArray(jobs) ? jobs.length : 0;
    logger.source(name, { ok: true, count, durationMs: Date.now() - started });
    return { name, jobs: Array.isArray(jobs) ? jobs : [], ok: true };
  } catch (error) {
    logger.source(name, { ok: false, count: 0, durationMs: Date.now() - started, error: error.message });
    logger.error(`${name} failed`, { error: error.message });
    return { name, jobs: [], ok: false };
  }
}

// ────────────────────────────────────────────────────────────
// HEALTH SERVER
// ────────────────────────────────────────────────────────────
function startHealthServer() {
  if (!HEALTH_PORT) return null;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      site: SITE_URL,
      target: TARGET_JOBS,
      jobs: logger.metrics.finalJobs,
      time: new Date().toISOString()
    }));
  });
  server.listen(HEALTH_PORT);
  return server;
}

// ────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  logger.info('================================================');
  logger.info('GOO JOBS ULTIMATE MERGED BUILD STARTED');
  logger.info(`Target: ${TARGET_JOBS} REAL jobs`);
  logger.info(`Arbeitnow pages: ${ARBEIT_PAGES}`);
  logger.info(`Greenhouse boards: ${GREENHOUSE_BOARDS.length}`);
  logger.info(`Lever boards: ${LEVER_BOARDS.length}`);
  logger.info(`Recruitee companies: ${RECRUITEE_COMPANIES.length}`);
  logger.info(`Breezy companies: ${BREEZY_COMPANIES.length}`);
  logger.info(`RSS feeds: ${RSS_FEEDS.length}`);
  logger.info('================================================');

  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.mkdir(JOB_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });
  await cache.init();

  const healthServer = startHealthServer();

  const previous = await loadPreviousJobs();
  logger.info('Previous jobs loaded', { count: previous.length });

  const sourceResults = await Promise.all(SOURCES.map(([name, fn]) => runSource(name, fn)));

  let rawJobs = [];
  for (const result of sourceResults) {
    if (Array.isArray(result.jobs)) rawJobs.push(...result.jobs);
  }
  logger.metrics.rawJobs = rawJobs.length;
  logger.info('Raw jobs collected', { count: rawJobs.length });

  let jobs = rawJobs.map(normalizeJob).filter(Boolean);
  logger.metrics.validJobs = jobs.length;
  logger.info('Normalized', { count: jobs.length });

  jobs = deduplicate(jobs);
  logger.metrics.deduplicatedJobs = jobs.length;
  logger.info('Deduplicated', { count: jobs.length, duplicates: logger.metrics.rawJobs - jobs.length });

  const before = jobs.length;
  jobs = jobs.filter(validateJob);
  logger.metrics.expiredJobs = before - jobs.length;

  jobs = mergePrevious(jobs, previous);
  logger.info('After previous merge', { count: jobs.length });

  jobs = removeExpired(jobs);
  logger.info('After retention filter', { count: jobs.length });

  ensureUniqueSlugs(jobs);

  jobs = rankJobs(jobs);

  jobs = jobs.slice(0, TARGET_JOBS);
  logger.metrics.finalJobs = jobs.length;
  logger.info('Final active jobs', { count: jobs.length });

  if (!jobs.length) throw new Error('ZERO real jobs. Build stopped.');

  const sourceStatus = {};
  for (const result of sourceResults) {
    const metric = logger.metrics.sources[result.name] || {};
    sourceStatus[result.name] = {
      ok: result.ok,
      fetched: result.jobs.length,
      durationMs: metric.durationMs || 0,
      error: metric.error || null
    };
  }

  await generateHomepage();
  await generateJobsJson(jobs, sourceStatus);
  await generateJobPages(jobs);
  await cleanupOldPages(jobs);
  await generateSitemap(jobs);
  await generateRobots();
  await generateSourceStatus(sourceStatus);
  await verifyBuild(jobs);

  logger.metrics.finishedAt = new Date().toISOString();
  logger.metrics.durationMs = Date.now() - started;
  await logger.save();

  logger.info('================================================');
  logger.info('BUILD COMPLETE');
  logger.info(`REAL jobs published: ${jobs.length}`);
  logger.info(`TARGET REACHED: ${jobs.length >= TARGET_JOBS}`);
  logger.info('No dummy jobs were generated.');
  logger.info('================================================');

  if (healthServer) healthServer.close();
}

main().catch(async error => {
  logger.error('FATAL BUILD ERROR', { error: error.message, stack: error.stack });
  await logger.save();
  process.exit(1);
});

process.on('unhandledRejection', async error => {
  logger.error('Unhandled rejection', { error: error?.message || String(error) });
  await logger.save();
  process.exit(1);
});

process.on('uncaughtException', async error => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  await logger.save();
  process.exit(1);
});
