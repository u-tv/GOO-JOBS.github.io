#!/usr/bin/env node
/**
 * GOO-JOBS v4 — ADVANCED BUILD ENGINE
 * ------------------------------------
 * Multi-source Job Aggregator
 *
 * Features:
 * - 8+ job sources
 * - Persistent HTTP cache
 * - Retry + exponential backoff + jitter
 * - Per-source timeout
 * - Concurrency control
 * - Rate limiting
 * - Smart deduplication
 * - Previous-data preservation
 * - Job expiry / retention
 * - Job scoring
 * - Indian + Remote filtering
 * - SEO JobPosting JSON-LD
 * - Individual static job pages
 * - Chunked sitemap generation
 * - robots.txt
 * - source-status.json
 * - build manifest
 * - metrics
 * - atomic writes
 * - stale-data protection
 * - graceful shutdown
 *
 * Node.js: 18+
 * Run:
 *   node generate.js
 */

'use strict';

const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

/* ============================================================
   1. CONFIGURATION
============================================================ */

const ROOT = path.resolve(__dirname);

const PUBLIC = path.join(ROOT, 'public');
const JOBS_DIR = path.join(PUBLIC, 'job');

const CACHE_DIR = path.join(ROOT, '.cache');
const HTTP_CACHE_DIR = path.join(CACHE_DIR, 'http');

const LOG_DIR = path.join(ROOT, 'logs');

const DATA_FILE = path.join(PUBLIC, 'jobs.json');
const MANIFEST_FILE = path.join(PUBLIC, 'build-manifest.json');
const STATUS_FILE = path.join(PUBLIC, 'source-status.json');

const SITE_URL =
  (process.env.SITE_URL || 'https://goojobs.in').replace(/\/+$/, '');

const SITE_NAME =
  process.env.SITE_NAME || 'GOO JOBS';

const TARGET =
  Math.max(1, parseInt(process.env.TARGET_JOBS || '5000', 10));

const RETENTION_DAYS =
  Math.max(1, parseInt(process.env.RETENTION_DAYS || '45', 10));

const TIMEOUT =
  Math.max(3000, parseInt(process.env.TIMEOUT_MS || '30000', 10));

const MAX_RETRY =
  Math.max(1, parseInt(process.env.MAX_RETRIES || '5', 10));

const CONCURRENCY =
  Math.max(1, parseInt(process.env.CONCURRENCY || '10', 10));

const SOURCE_CONCURRENCY =
  Math.max(
    1,
    parseInt(process.env.SOURCE_CONCURRENCY || '8', 10)
  );

const RPM =
  Math.max(1, parseInt(process.env.RATE_LIMIT_RPM || '60', 10));

const CACHE_TTL =
  Math.max(
    1000,
    parseInt(process.env.CACHE_TTL_MS || '300000', 10)
  );

const HTTP_CACHE_TTL =
  Math.max(
    1000,
    parseInt(
      process.env.HTTP_CACHE_TTL_MS || String(6 * 60 * 60 * 1000),
      10
    )
  );

const ARBEIT_PAGES =
  Math.max(1, parseInt(process.env.ARBEIT_PAGES || '50', 10));

const SITEMAP_CHUNK_SIZE =
  Math.max(
    100,
    parseInt(process.env.SITEMAP_CHUNK_SIZE || '45000', 10)
  );

const MIN_DESCRIPTION =
  Math.max(
    0,
    parseInt(process.env.MIN_DESCRIPTION_LENGTH || '20', 10)
  );

const ENABLE_CACHE =
  process.env.ENABLE_CACHE !== 'false';

const ENABLE_METRICS =
  process.env.ENABLE_METRICS !== 'false';

const ENABLE_PERSISTENT_CACHE =
  process.env.ENABLE_PERSISTENT_CACHE !== 'false';

const ENABLE_SITEMAP_INDEX =
  process.env.ENABLE_SITEMAP_INDEX !== 'false';

const ENABLE_JOB_PAGES =
  process.env.ENABLE_JOB_PAGES !== 'false';

const ENABLE_ROBOTS =
  process.env.ENABLE_ROBOTS !== 'false';

const ENABLE_HEALTH =
  process.env.HEALTH_CHECK_PORT &&
  parseInt(process.env.HEALTH_CHECK_PORT, 10) > 0;

const HEALTH_PORT =
  parseInt(process.env.HEALTH_CHECK_PORT || '0', 10);

const KEEP_PREVIOUS_ON_FAILURE =
  process.env.KEEP_PREVIOUS_ON_FAILURE !== 'false';

const ALLOW_REMOTE =
  process.env.ALLOW_REMOTE !== 'false';

const BLACKLIST = (
  process.env.BLACKLISTED_DOMAINS || ''
)
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const ADSTERRA =
  process.env.ADSTERRA_SMARTLINK_SCRIPT || '';

const ADSTERRA_TOKEN =
  '<!--ADSTERRA_SMARTLINK-->';

/* ============================================================
   2. SOURCE CONFIG
============================================================ */

const INDIAN_API_KEY =
  process.env.INDIAN_API_KEY || '';

const JOBDATA_KEY =
  process.env.JOBDATA_API_KEY || '';

const GH_BOARDS = (
  process.env.GREENHOUSE_BOARDS ||
  [
    'stripe',
    'airbnb',
    'netflix',
    'spotify',
    'uber',
    'lyft',
    'slack',
    'discord',
    'notion',
    'figma'
  ].join(',')
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const LEVER_BOARDS = (
  process.env.LEVER_BOARDS ||
  [
    'flipkart',
    'swiggy',
    'razorpay',
    'zerodha',
    'phonepe',
    'cred',
    'meesho',
    'unacademy',
    'vedantu'
  ].join(',')
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const RSS_FEEDS = (
  process.env.RSS_FEEDS ||
  'https://remotive.com/remote-jobs/feed'
)
  .split('|')
  .map(s => s.trim())
  .filter(Boolean);

/* ============================================================
   3. GLOBAL STATE
============================================================ */

const BUILD_ID =
  crypto.randomBytes(8).toString('hex');

const BUILD_STARTED_AT =
  new Date().toISOString();

const metrics = {
  buildId: BUILD_ID,
  startedAt: BUILD_STARTED_AT,
  finishedAt: null,
  durationMs: 0,

  rawJobs: 0,
  validJobs: 0,
  duplicateJobs: 0,
  finalJobs: 0,

  pagesGenerated: 0,

  sources: {},
  errors: [],
  warnings: []
};

/* ============================================================
   4. UTILITY FUNCTIONS
============================================================ */

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function nowIso() {
  return new Date().toISOString();
}

function safeDate(value, fallback = new Date()) {
  if (!value) return fallback;

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return fallback;
  }

  return d;
}

function esc(value) {
  if (value == null) return '';

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(html) {
  if (!html) return '';

  return String(html)
    .replace(
      /<script[\s\S]*?<\/script>/gi,
      ' '
    )
    .replace(
      /<style[\s\S]*?<\/style>/gi,
      ' '
    )
    .replace(
      /<noscript[\s\S]*?<\/noscript>/gi,
      ' '
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  return stripHtml(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 90) || 'job';
}

function hashId(seed) {
  return crypto
    .createHash('sha256')
    .update(String(seed || '').toLowerCase())
    .digest('hex')
    .substring(0, 20);
}

function normalizeUrl(url) {
  if (!url) return '';

  try {
    const u = new URL(String(url));

    u.hash = '';

    [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid'
    ].forEach(k => u.searchParams.delete(k));

    return u.toString();
  } catch (_) {
    return String(url).trim();
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function timeAgo(iso) {
  const d = safeDate(iso);

  const diff =
    Math.max(0, Date.now() - d.getTime()) / 1000;

  if (diff < 60) {
    return `${Math.floor(diff)}s ago`;
  }

  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m ago`;
  }

  if (diff < 86400) {
    return `${Math.floor(diff / 3600)}h ago`;
  }

  if (diff < 30 * 86400) {
    return `${Math.floor(diff / 86400)}d ago`;
  }

  return d.toISOString().substring(0, 10);
}

function unique(array) {
  return [...new Set(array.filter(Boolean))];
}

function chunk(array, size) {
  const result = [];

  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }

  return result;
}

/* ============================================================
   5. INDIAN LOCATION DETECTION
============================================================ */

const INDIAN_LOCATIONS = [
  'india',
  'remote',
  'wfh',
  'work from home',
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
  'thane',
  'bhopal',
  'visakhapatnam',
  'patna',
  'vadodara',
  'coimbatore',
  'kochi',
  'cochin',
  'mysore',
  'mysuru',
  'chandigarh',
  'nashik',
  'rajkot',
  'goa',
  'trivandrum',
  'thiruvananthapuram',
  'mangalore',
  'madurai',
  'salem',
  'trichy',
  'tiruchirappalli',
  'puducherry',
  'shillong',
  'guwahati',
  'ranchi',
  'jamshedpur',
  'bhubaneswar',
  'cuttack',
  'dehradun',
  'haridwar',
  'ludhiana',
  'amritsar',
  'jalandhar',
  'patiala',
  'bathinda',
  'gwalior',
  'jabalpur',
  'ujjain',
  'raipur',
  'bilaspur',
  'durg',
  'bhilai',
  'siliguri',
  'asansol',
  'durgapur',
  'howrah',
  'dhanbad',
  'bokaro',
  'gorakhpur',
  'varanasi',
  'prayagraj',
  'allahabad',
  'agra',
  'meerut',
  'aligarh',
  'bareilly',
  'moradabad',
  'saharanpur',
  'nainital',
  'haldwani',
  'roorkee',
  'rishikesh',
  'mussoorie',
  'shimla',
  'manali',
  'dharamshala',
  'solan',
  'mandi',
  'una',
  'hamirpur',
  'kangra',
  'panchkula',
  'ambala',
  'karnal',
  'panipat',
  'sonipat',
  'rohtak',
  'jhajjar',
  'rewari',
  'mahendragarh',
  'bhiwani',
  'hisar',
  'fatehabad',
  'sirsa',
  'jind',
  'kaithal',
  'yamunanagar',
  'kurukshetra',
  'thanesar'
];

function isIndianLocation(location) {
  if (!location) return false;

  const text =
    String(location).toLowerCase();

  return INDIAN_LOCATIONS.some(
    city => text.includes(city)
  );
}

/* ============================================================
   6. SKILL ENGINE
============================================================ */

const SKILLS = [
  'javascript',
  'typescript',
  'react',
  'react native',
  'node',
  'nodejs',
  'angular',
  'vue',
  'nextjs',
  'nuxt',
  'svelte',
  'python',
  'django',
  'flask',
  'fastapi',
  'java',
  'spring',
  'springboot',
  'kotlin',
  'swift',
  'objective-c',
  'c++',
  'c#',
  '.net',
  'dotnet',
  'go',
  'golang',
  'rust',
  'ruby',
  'rails',
  'php',
  'laravel',
  'symfony',
  'sql',
  'mysql',
  'postgresql',
  'mongodb',
  'redis',
  'elasticsearch',
  'kafka',
  'aws',
  'azure',
  'gcp',
  'docker',
  'kubernetes',
  'terraform',
  'ansible',
  'jenkins',
  'github actions',
  'gitlab',
  'html',
  'css',
  'sass',
  'scss',
  'tailwind',
  'bootstrap',
  'graphql',
  'rest api',
  'microservices',
  'machine learning',
  'deep learning',
  'nlp',
  'data science',
  'tensorflow',
  'pytorch',
  'pandas',
  'numpy',
  'scikit-learn',
  'power bi',
  'tableau',
  'excel',
  'powerpoint',
  'figma',
  'adobe',
  'photoshop',
  'illustrator',
  'canva',
  'seo',
  'sem',
  'google ads',
  'digital marketing',
  'content writing',
  'copywriting',
  'product management',
  'agile',
  'scrum',
  'jira',
  'confluence',
  'notion',
  'slack',
  'teams',
  'zoom',
  'ios',
  'android',
  'flutter',
  'devops',
  'sre',
  'security',
  'cybersecurity',
  'linux',
  'ubuntu',
  'sap',
  'oracle',
  'tally',
  'accounting',
  'taxation',
  'gst',
  'banking',
  'finance',
  'investment',
  'hr',
  'recruitment',
  'talent acquisition',
  'payroll',
  'sales',
  'marketing',
  'business development',
  'customer support',
  'operations',
  'supply chain',
  'logistics',
  'procurement',
  'warehouse',
  'data entry',
  'typing',
  'ms office',
  'word',
  'outlook',
  'crm',
  'salesforce',
  'hubspot',
  'zoho',
  'blockchain',
  'web3',
  'solidity',
  'ethereum',
  'bitcoin',
  'nft',
  'smart contracts',
  'defi',
  'ai',
  'generative ai',
  'llm',
  'openai',
  'chatgpt',
  'claude',
  'gemini',
  'midjourney',
  'data engineering',
  'etl',
  'airflow',
  'dbt',
  'snowflake',
  'bigquery',
  'redshift',
  'databricks',
  'spark',
  'hadoop',
  'hive',
  'streaming',
  'analytics',
  'ui/ux',
  'user research',
  'wireframing',
  'prototyping',
  'design systems',
  'accessibility',
  'qa',
  'testing',
  'automation',
  'selenium',
  'cypress',
  'playwright',
  'junit',
  'jest',
  'mocha',
  'api testing',
  'postman',
  'swagger',
  'openapi',
  'grpc',
  'protobuf',
  'websocket',
  'socket.io',
  'git',
  'github',
  'gitlab',
  'bitbucket',
  'ci/cd',
  'devsecops',
  'observability',
  'prometheus',
  'grafana',
  'splunk',
  'datadog',
  'networking',
  'tcp/ip',
  'dns',
  'dhcp',
  'vpn',
  'firewall',
  'load balancer',
  'cdn',
  'cloudflare',
  'vercel',
  'netlify',
  'firebase',
  'supabase',
  'appwrite',
  'strapi',
  'contentful',
  'wordpress',
  'drupal',
  'joomla',
  'magento',
  'shopify',
  'woocommerce',
  'express',
  'koa',
  'fastify',
  'nestjs',
  'jquery',
  'redux',
  'mobx',
  'zustand',
  'prisma',
  'sequelize',
  'mongoose',
  'typeorm',
  'graphql'
];

function extractSkills(text) {
  if (!text) return [];

  const source =
    String(text)
      .toLowerCase()
      .replace(/[^\w+#./\s-]/g, ' ');

  const found = [];

  for (const skill of SKILLS) {
    const escaped =
      skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const regex =
      new RegExp(
        `(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`,
        'i'
      );

    if (regex.test(source)) {
      found.push(
        skill.charAt(0).toUpperCase() +
        skill.slice(1)
      );
    }
  }

  return unique(found).slice(0, 15);
}

/* ============================================================
   7. JOB CLASSIFICATION
============================================================ */

function detectExperience(title, description = '') {
  const text =
    `${title} ${description}`.toLowerCase();

  if (
    /\b(intern|internship|trainee|apprentice|graduate)\b/
      .test(text)
  ) {
    return 'Internship';
  }

  if (
    /\b(senior|sr\.?|lead|principal|staff|head|director|vp|chief|architect|cto|ceo)\b/
      .test(text)
  ) {
    return 'Senior';
  }

  if (
    /\b(junior|jr\.?|associate|entry|fresher|beginner|starter)\b/
      .test(text)
  ) {
    return 'Entry';
  }

  return 'Mid';
}

function detectCategory(title, description) {
  const text =
    `${title} ${description}`.toLowerCase();

  const categories = [
    ['Software & IT', [
      'developer',
      'software',
      'engineer',
      'frontend',
      'backend',
      'full stack',
      'devops',
      'programmer'
    ]],

    ['Data & AI', [
      'data scientist',
      'data analyst',
      'machine learning',
      'artificial intelligence',
      'ai engineer',
      'data engineer'
    ]],

    ['Finance', [
      'accountant',
      'finance',
      'banking',
      'financial',
      'tax',
      'audit'
    ]],

    ['Sales & Marketing', [
      'sales',
      'marketing',
      'seo',
      'business development',
      'growth'
    ]],

    ['HR & Recruitment', [
      'human resources',
      'hr ',
      'recruiter',
      'recruitment',
      'talent acquisition'
    ]],

    ['Design', [
      'designer',
      'ui/ux',
      'ux designer',
      'graphic designer',
      'product designer'
    ]],

    ['Customer Support', [
      'customer support',
      'customer service',
      'support executive'
    ]],

    ['Operations', [
      'operations',
      'logistics',
      'supply chain',
      'procurement'
    ]]
  ];

  for (const [name, words] of categories) {
    if (words.some(word => text.includes(word))) {
      return name;
    }
  }

  return 'General';
}

function detectEmploymentType(text) {
  const t = String(text || '').toLowerCase();

  if (/\binternship\b|\bintern\b/.test(t)) {
    return 'Internship';
  }

  if (/\bpart[- ]?time\b/.test(t)) {
    return 'Part-time';
  }

  if (/\bcontract\b|\bfreelance\b/.test(t)) {
    return 'Contract';
  }

  if (/\btemporary\b/.test(t)) {
    return 'Temporary';
  }

  return 'Full-time';
}

function detectRemote(text) {
  const t =
    String(text || '').toLowerCase();

  return {
    remote:
      /\bremote\b|\bwfh\b|work from home|work-from-home|distributed team|anywhere/.test(t),

    hybrid:
      /\bhybrid\b|partially remote|flexible.*office/.test(t)
  };
}

/* ============================================================
   8. SALARY PARSER
============================================================ */

function parseSalary(value) {
  if (!value) return null;

  const raw =
    String(value).trim();

  const normalized =
    raw
      .replace(/,/g, '')
      .replace(/\s+/g, ' ');

  const matches = [
    ...normalized.matchAll(
      /(?:₹|rs\.?|inr|\$)?\s*(\d+(?:\.\d+)?)\s*(k|l|lakh|lac|lakhs|lpa|cr|crore)?/gi
    )
  ];

  if (!matches.length) {
    return null;
  }

  const numbers = [];

  for (const match of matches) {
    let number =
      parseFloat(match[1]);

    const unit =
      String(match[2] || '')
        .toLowerCase();

    if (unit === 'k') {
      number *= 1000;
    } else if (
      ['l', 'lakh', 'lac', 'lakhs', 'lpa']
        .includes(unit)
    ) {
      number *= 100000;
    } else if (
      ['cr', 'crore'].includes(unit)
    ) {
      number *= 10000000;
    }

    if (Number.isFinite(number)) {
      numbers.push(number);
    }
  }

  if (!numbers.length) {
    return null;
  }

  const min =
    Math.min(...numbers);

  const max =
    numbers.length > 1
      ? Math.max(...numbers)
      : min * 1.2;

  return {
    min,
    max,
    currency:
      raw.includes('$') ? 'USD' : 'INR',
    raw
  };
}

/* ============================================================
   9. LOGGER
============================================================ */

class Logger {
  constructor() {
    this.errors = [];
  }

  log(level, message, extra = {}) {
    const entry = {
      time: nowIso(),
      level,
      message,
      ...extra
    };

    try {
      process.stdout.write(
        JSON.stringify(entry) + '\n'
      );
    } catch (_) {}

    if (level === 'error') {
      this.errors.push(entry);
    }
  }

  info(message, extra) {
    this.log('info', message, extra);
  }

  warn(message, extra) {
    this.log('warn', message, extra);
  }

  error(message, extra) {
    this.log('error', message, extra);
  }

  async save() {
    if (!ENABLE_METRICS) return;

    await fs.mkdir(
      LOG_DIR,
      { recursive: true }
    );

    const file =
      path.join(
        LOG_DIR,
        `build-${BUILD_ID}.json`
      );

    await atomicWrite(
      file,
      {
        ...metrics,
        errors: this.errors
      },
      true
    );

    await atomicWrite(
      path.join(LOG_DIR, 'metrics.json'),
      {
        ...metrics,
        errors: this.errors
      },
      true
    );
  }
}

const logger = new Logger();

/* ============================================================
   10. RATE LIMITER
============================================================ */

class RateLimiter {
  constructor(rpm) {
    this.rpm = rpm;
    this.capacity = rpm;
    this.tokens = rpm;
    this.last = Date.now();
  }

  async take() {
    while (true) {
      const now = Date.now();

      const elapsed =
        (now - this.last) / 60000;

      this.tokens =
        Math.min(
          this.capacity,
          this.tokens +
          elapsed * this.rpm
        );

      this.last = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const wait =
        ((1 - this.tokens) /
          this.rpm) *
        60000;

      await sleep(
        Math.max(50, wait)
      );
    }
  }
}

const rateLimiter =
  new RateLimiter(RPM);

/* ============================================================
   11. MEMORY CACHE
============================================================ */

class MemoryCache {
  constructor() {
    this.map = new Map();
  }

  key(url) {
    return crypto
      .createHash('md5')
      .update(url)
      .digest('hex');
  }

  get(url) {
    if (!ENABLE_CACHE) return null;

    const item =
      this.map.get(this.key(url));

    if (!item) return null;

    if (
      Date.now() - item.time >
      CACHE_TTL
    ) {
      this.map.delete(this.key(url));
      return null;
    }

    return item.value;
  }

  set(url, value) {
    if (!ENABLE_CACHE) return;

    this.map.set(
      this.key(url),
      {
        time: Date.now(),
        value
      }
    );
  }
}

const memoryCache =
  new MemoryCache();

/* ============================================================
   12. PERSISTENT HTTP CACHE
============================================================ */

async function persistentCachePath(url) {
  const hash =
    crypto
      .createHash('sha256')
      .update(url)
      .digest('hex');

  return path.join(
    HTTP_CACHE_DIR,
    `${hash}.json`
  );
}

async function persistentCacheGet(url) {
  if (
    !ENABLE_CACHE ||
    !ENABLE_PERSISTENT_CACHE
  ) {
    return null;
  }

  try {
    const file =
      await persistentCachePath(url);

    const text =
      await fs.readFile(
        file,
        'utf8'
      );

    const data =
      JSON.parse(text);

    if (
      Date.now() - data.time >
      HTTP_CACHE_TTL
    ) {
      return null;
    }

    return data.value;
  } catch (_) {
    return null;
  }
}

async function persistentCacheSet(url, value) {
  if (
    !ENABLE_CACHE ||
    !ENABLE_PERSISTENT_CACHE
  ) {
    return;
  }

  try {
    await fs.mkdir(
      HTTP_CACHE_DIR,
      { recursive: true }
    );

    const file =
      await persistentCachePath(url);

    await atomicWrite(
      file,
      {
        time: Date.now(),
        value
      },
      true
    );
  } catch (e) {
    logger.warn(
      'Persistent cache write failed',
      { error: e.message }
    );
  }
}

/* ============================================================
   13. HTTP FETCH ENGINE
============================================================ */

async function fetchRetry(url, options = {}) {
  const normalized =
    normalizeUrl(url);

  const memoryHit =
    memoryCache.get(normalized);

  if (memoryHit !== null) {
    return memoryHit;
  }

  const diskHit =
    await persistentCacheGet(
      normalized
    );

  if (diskHit !== null) {
    memoryCache.set(
      normalized,
      diskHit
    );

    return diskHit;
  }

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MAX_RETRY;
    attempt++
  ) {
    await rateLimiter.take();

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        TIMEOUT
      );

    try {
      const response =
        await fetch(
          normalized,
          {
            ...options,
            signal:
              controller.signal,

            headers: {
              'Accept':
                'application/json, application/rss+xml, text/xml, text/html, */*',

              'Accept-Encoding':
                'gzip, deflate',

              'User-Agent':
                'GOO-JOBS/4.0 (+https://goojobs.in)',

              ...(options.headers || {})
            }
          }
        );

      clearTimeout(timeout);

      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;

        if (!retryable) {
          throw new Error(
            `HTTP ${response.status}`
          );
        }

        throw new Error(
          `RETRYABLE_HTTP_${response.status}`
        );
      }

      const text =
        await response.text();

      memoryCache.set(
        normalized,
        text
      );

      await persistentCacheSet(
        normalized,
        text
      );

      return text;

    } catch (error) {
      clearTimeout(timeout);

      lastError = error;

      if (
        attempt >= MAX_RETRY
      ) {
        break;
      }

      const exponential =
        Math.min(
          10000,
          500 *
          Math.pow(2, attempt - 1)
        );

      const jitter =
        Math.floor(
          Math.random() * 400
        );

      await sleep(
        exponential + jitter
      );
    }
  }

  throw lastError ||
    new Error(
      `Request failed: ${normalized}`
    );
}

/* ============================================================
   14. BATCH FETCH
============================================================ */

async function fetchBatch(
  urls,
  limit = CONCURRENCY,
  options = {}
) {
  const output =
    new Array(urls.length);

  let cursor = 0;

  const workers =
    Array.from(
      {
        length:
          Math.min(
            limit,
            urls.length
          )
      },
      async () => {
        while (true) {
          const index =
            cursor++;

          if (
            index >= urls.length
          ) {
            return;
          }

          try {
            output[index] = {
              ok: true,
              data:
                await fetchRetry(
                  urls[index],
                  options
                )
            };
          } catch (error) {
            output[index] = {
              ok: false,
              error:
                error.message
            };
          }
        }
      }
    );

  await Promise.all(workers);

  return output;
}

/* ============================================================
   15. XML/RSS HELPERS
============================================================ */

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function rssTag(item, tag) {
  const escaped =
    tag.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

  const match =
    item.match(
      new RegExp(
        `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`,
        'i'
      )
    );

  return match
    ? decodeXml(match[1])
    : '';
}

function parseRSS(text, sourceName) {
  const jobs = [];

  const items =
    text.match(
      /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    ) || [];

  for (const item of items) {
    const title =
      cleanText(
        rssTag(item, 'title')
      );

    const link =
      normalizeUrl(
        rssTag(item, 'link') ||
        rssTag(item, 'guid')
      );

    const description =
      cleanText(
        rssTag(item, 'description') ||
        rssTag(item, 'summary') ||
        rssTag(item, 'content:encoded')
      );

    const published =
      rssTag(item, 'pubDate') ||
      rssTag(item, 'published') ||
      rssTag(item, 'dc:date');

    const category =
      cleanText(
        rssTag(item, 'category')
      );

    if (!title || !link) {
      continue;
    }

    jobs.push({
      externalId:
        `${sourceName}-${hashId(link)}`,

      title,

      company:
        'Various',

      description,

      location:
        'India',

      url:
        link,

      source:
        sourceName,

      category:
        category || 'General',

      employmentType:
        '',

      salary:
        null,

      publishedAt:
        safeDate(
          published,
          new Date()
        ).toISOString()
    });
  }

  return jobs;
}

/* ============================================================
   16. SOURCE ADAPTER — ARBEITNOW
============================================================ */

async function fetchArbeitnow() {
  const jobs = [];

  try {
    for (
      let page = 1;
      page <= ARBEIT_PAGES;
      page++
    ) {
      const url =
        `https://www.arbeitnow.com/api/job-board-api?page=${page}`;

      const text =
        await fetchRetry(url);

      const data =
        JSON.parse(text);

      const list =
        Array.isArray(data.data)
          ? data.data
          : [];

      if (!list.length) {
        break;
      }

      for (const item of list) {
        jobs.push({
          externalId:
            `arbeit-${item.slug || item.id || hashId(item.title)}`,

          title:
            item.title,

          company:
            item.company_name ||
            item.company ||
            'Unknown',

          description:
            item.description ||
            item.excerpt ||
            '',

          location:
            item.location ||
            'Remote',

          url:
            item.url ||
            item.apply_url ||
            '',

          source:
            'Arbeitnow',

          category:
            item.tags?.[0] ||
            'IT',

          employmentType:
            item.job_types?.[0] ||
            'Full-time',

          salary:
            item.salary ||
            null,

          publishedAt:
            item.created_at ||
            item.published_at ||
            nowIso()
        });
      }

      if (
        page % 5 === 0
      ) {
        logger.info(
          'Arbeitnow progress',
          {
            page,
            jobs: jobs.length
          }
        );
      }

      await sleep(150);
    }
  } catch (error) {
    logger.error(
      'Arbeitnow failed',
      {
        error: error.message
      }
    );
  }

  return jobs;
}

/* ============================================================
   17. SOURCE ADAPTER — LEVER
============================================================ */

async function fetchLever() {
  const jobs = [];

  const urls =
    LEVER_BOARDS.map(
      company =>
        `https://api.lever.co/v0/postings/${encodeURIComponent(
          company.toLowerCase()
        )}?mode=json`
    );

  const results =
    await fetchBatch(
      urls,
      5
    );

  for (
    let i = 0;
    i < results.length;
    i++
  ) {
    const result =
      results[i];

    const company =
      LEVER_BOARDS[i];

    if (!result.ok) {
      logger.warn(
        `Lever ${company} failed`,
        {
          error:
            result.error
        }
      );

      continue;
    }

    try {
      const data =
        JSON.parse(
          result.data
        );

      for (const item of data || []) {
        const location =
          item.categories?.location ||
          'India';

        jobs.push({
          externalId:
            `lev-${item.id || hashId(item.text + company)}`,

          title:
            item.text ||
            item.title ||
            '',

          company:
            company
              .charAt(0)
              .toUpperCase() +
            company.slice(1),

          description:
            cleanText(
              item.description ||
              item.content ||
              ''
            ),

          location:
            Array.isArray(location)
              ? location.join(', ')
              : location,

          url:
            item.applyUrl ||
            item.hostedUrl ||
            item.url ||
            '',

          source:
            'Lever',

          category:
            item.categories?.team ||
            'IT',

          employmentType:
            item.categories?.commitment ||
            'Full-time',

          salary:
            null,

          publishedAt:
            item.createdAt ||
            item.updatedAt ||
            item.postedAt ||
            nowIso()
        });
      }

    } catch (error) {
      logger.warn(
        `Lever ${company} parse failed`,
        {
          error: error.message
        }
      );
    }
  }

  return jobs;
}

/* ============================================================
   18. SOURCE ADAPTER — GREENHOUSE
============================================================ */

async function fetchGreenhouse() {
  const jobs = [];

  const urls =
    GH_BOARDS.map(
      company =>
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
          company.toLowerCase()
        )}/jobs?content=true`
    );

  const results =
    await fetchBatch(
      urls,
      5
    );

  for (
    let i = 0;
    i < results.length;
    i++
  ) {
    const result =
      results[i];

    const company =
      GH_BOARDS[i];

    if (!result.ok) {
      logger.warn(
        `Greenhouse ${company} failed`,
        {
          error:
            result.error
        }
      );

      continue;
    }

    try {
      const data =
        JSON.parse(
          result.data
        );

      for (
        const item of
        data.jobs || []
      ) {
        jobs.push({
          externalId:
            `gh-${item.id}`,

          title:
            item.title || '',

          company:
            company
              .charAt(0)
              .toUpperCase() +
            company.slice(1),

          description:
            cleanText(
              item.content ||
              item.description ||
              ''
            ),

          location:
            item.location?.name ||
            'Remote',

          url:
            item.absolute_url ||
            '',

          source:
            'Greenhouse',

          category:
            item.departments?.[0]?.name ||
            'IT',

          employmentType:
            'Full-time',

          salary:
            null,

          publishedAt:
            item.updated_at ||
            item.created_at ||
            nowIso()
        });
      }

    } catch (error) {
      logger.warn(
        `Greenhouse ${company} parse failed`,
        {
          error: error.message
        }
      );
    }
  }

  return jobs;
}

/* ============================================================
   19. SOURCE ADAPTER — RSS
============================================================ */

async function fetchRSS() {
  const jobs = [];

  for (const feed of RSS_FEEDS) {
    try {
      const text =
        await fetchRetry(feed);

      jobs.push(
        ...parseRSS(
          text,
          'RSS'
        )
      );
    } catch (error) {
      logger.warn(
        'RSS feed failed',
        {
          feed,
          error:
            error.message
        }
      );
    }
  }

  return jobs;
}

/* ============================================================
   20. SOURCE ADAPTER — REMOTIVE
============================================================ */

async function fetchRemotive() {
  try {
    const text =
      await fetchRetry(
        'https://remotive.com/remote-jobs/feed'
      );

    const parsed =
      parseRSS(
        text,
        'Remotive'
      );

    return parsed.map(job => ({
      ...job,

      location:
        job.location || 'Remote',

      category:
        'Remote',

      employmentType:
        job.employmentType ||
        'Full-time'
    }));
  } catch (error) {
    logger.warn(
      'Remotive failed',
      {
        error:
          error.message
      }
    );

    return [];
  }
}

/* ============================================================
   21. SOURCE ADAPTER — NCS
============================================================ */

async function fetchNCS() {
  const jobs = [];

  try {
    const url =
      'https://www.ncs.gov.in/_api/jobs/search?page=1&size=100';

    const text =
      await fetchRetry(
        url,
        {
          headers: {
            Accept:
              'application/json'
          }
        }
      );

    const data =
      JSON.parse(text);

    const list =
      data.data ||
      data.jobs ||
      data.results ||
      [];

    for (const item of list) {
      jobs.push({
        externalId:
          `ncs-${item.jobId || item.id || hashId(item.title)}`,

        title:
          item.title ||
          item.jobTitle ||
          '',

        company:
          item.organization ||
          item.employer ||
          'Government of India',

        description:
          item.description ||
          item.jobDescription ||
          'Government position in India',

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
          (
            item.jobId || item.id
              ? `https://www.ncs.gov.in/job-posts/${item.jobId || item.id}`
              : ''
          ),

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
          item.salary ||
          null,

        publishedAt:
          item.postedDate ||
          item.publishedDate ||
          item.createdAt ||
          nowIso()
      });
    }
  } catch (error) {
    logger.warn(
      'NCS failed',
      {
        error:
          error.message
      }
    );
  }

  return jobs;
}

/* ============================================================
   22. SOURCE ADAPTER — INDIAN API
============================================================ */

async function fetchIndianAPI() {
  if (!INDIAN_API_KEY) {
    logger.info(
      'IndianAPI skipped: no API key'
    );

    return [];
  }

  try {
    const text =
      await fetchRetry(
        'https://indianapi.in/api/v2/job/search',
        {
          headers: {
            'X-Api-Key':
              INDIAN_API_KEY
          }
        }
      );

    const data =
      JSON.parse(text);

    const list =
      data.results ||
      data.jobs ||
      data.data ||
      [];

    return list.map(item => ({
      externalId:
        `ind-${item.id || item.job_id || hashId(item.title)}`,

      title:
        item.title ||
        item.job_title ||
        '',

      company:
        item.company ||
        item.company_name ||
        item.employer ||
        'Unknown',

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
        item.salary_range ||
        null,

      publishedAt:
        item.posted_at ||
        item.created_at ||
        item.date ||
        nowIso()
    }));
  } catch (error) {
    logger.warn(
      'IndianAPI failed',
      {
        error:
          error.message
      }
    );

    return [];
  }
}

/* ============================================================
   23. SOURCE ADAPTER — JOBDATA API
============================================================ */

async function fetchJobDataAPI() {
  if (!JOBDATA_KEY) {
    logger.info(
      'JobDataAPI skipped: no API key'
    );

    return [];
  }

  try {
    const text =
      await fetchRetry(
        'https://jobdataapi.com/api/jobs?country_code=IN&limit=100',
        {
          headers: {
            Authorization:
              `Bearer ${JOBDATA_KEY}`
          }
        }
      );

    const data =
      JSON.parse(text);

    const list =
      data.results ||
      data.data ||
      [];

    return list.map(item => ({
      externalId:
        `jd-${item.id || item.job_id || hashId(item.title)}`,

      title:
        item.title || '',

      company:
        item.company ||
        item.company_name ||
        'Unknown',

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
        item.salary_range ||
        null,

      publishedAt:
        item.posted_at ||
        item.date ||
        nowIso()
    }));
  } catch (error) {
    logger.warn(
      'JobDataAPI failed',
      {
        error:
          error.message
      }
    );

    return [];
  }
}

/* ============================================================
   24. NORMALIZATION
============================================================ */

function normalizeJob(raw) {
  const title =
    cleanText(
      raw.title
    );

  const company =
    cleanText(
      raw.company ||
      raw.employer ||
      'Unknown'
    );

  const description =
    cleanText(
      raw.description
    );

  const location =
    cleanText(
      raw.location ||
      'India'
    ) || 'India';

  const url =
    normalizeUrl(
      raw.url
    );

  const published =
    safeDate(
      raw.publishedAt,
      new Date()
    );

  const id =
    hashId(
      raw.externalId ||
      url ||
      `${title}|${company}|${location}`
    );

  const fullText =
    `${title} ${description}`;

  const remote =
    detectRemote(fullText);

  const salary =
    parseSalary(
      raw.salary
    );

  const slugBase =
    slugify(
      `${title}-${company}`
    );

  return {
    id,

    externalId:
      raw.externalId ||
      id,

    title,

    company,

    description,

    location,

    url,

    source:
      raw.source ||
      'Unknown',

    category:
      raw.category ||
      detectCategory(
        title,
        description
      ),

    employmentType:
      raw.employmentType ||
      detectEmploymentType(
        fullText
      ),

    salary:
      raw.salary ||
      null,

    salaryRange:
      salary,

    publishedAt:
      published.toISOString(),

    updatedAt:
      nowIso(),

    verifiedSource:
      true,

    isLive:
      true,

    skills:
      extractSkills(
        fullText
      ),

    experienceLevel:
      detectExperience(
        title,
        description
      ),

    remote:
      remote.remote,

    hybrid:
      remote.hybrid,

    slug:
      slugBase,

    lastSeenAt:
      nowIso(),

    sourceDomain:
      domainOf(url)
  };
}

/* ============================================================
   25. VALIDATION
============================================================ */

function isValid(job) {
  if (!job) return false;

  if (!job.id) return false;

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
    !job.url ||
    !/^https?:\/\//i.test(
      job.url
    )
  ) {
    return false;
  }

  if (
    job.description.length <
    MIN_DESCRIPTION
  ) {
    return false;
  }

  if (
    BLACKLIST.length &&
    BLACKLIST.some(
      domain =>
        job.url
          .toLowerCase()
          .includes(domain)
    )
  ) {
    return false;
  }

  const indian =
    isIndianLocation(
      job.location
    );

  if (
    !indian &&
    !(ALLOW_REMOTE && job.remote)
  ) {
    return false;
  }

  return true;
}

/* ============================================================
   26. DUPLICATE DETECTION
============================================================ */

function fingerprint(job) {
  return [
    job.title,
    job.company,
    job.location
  ]
    .join('|')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/\W+/)
      .filter(
        word => word.length > 2
      )
  );
}

function similarity(a, b) {
  const A =
    tokenSet(a);

  const B =
    tokenSet(b);

  if (!A.size || !B.size) {
    return 0;
  }

  let intersection = 0;

  for (const token of A) {
    if (B.has(token)) {
      intersection++;
    }
  }

  return (
    intersection /
    Math.max(
      A.size,
      B.size
    )
  );
}

function mergeInto(target, source) {
  target.skills =
    unique([
      ...(target.skills || []),
      ...(source.skills || [])
    ]).slice(0, 15);

  if (
    source.description &&
    source.description.length >
    (target.description || '').length
  ) {
    target.description =
      source.description;
  }

  if (
    !target.salaryRange &&
    source.salaryRange
  ) {
    target.salaryRange =
      source.salaryRange;
  }

  if (
    source.salary &&
    !target.salary
  ) {
    target.salary =
      source.salary;
  }

  if (
    source.remote
  ) {
    target.remote = true;
  }

  if (
    source.hybrid
  ) {
    target.hybrid = true;
  }

  if (
    source.publishedAt &&
    (
      !target.publishedAt ||
      source.publishedAt >
      target.publishedAt
    )
  ) {
    target.publishedAt =
      source.publishedAt;
  }

  target.updatedAt =
    nowIso();

  target.lastSeenAt =
    nowIso();

  return target;
}

function dedupe(list) {
  const byUrl =
    new Map();

  const byFingerprint =
    new Map();

  const output = [];

  const sorted =
    [...list].sort(
      (a, b) =>
        b.publishedAt.localeCompare(
          a.publishedAt
        )
    );

  for (const job of sorted) {
    const url =
      normalizeUrl(job.url);

    if (
      url &&
      byUrl.has(url)
    ) {
      mergeInto(
        byUrl.get(url),
        job
      );

      metrics.duplicateJobs++;

      continue;
    }

    const fp =
      fingerprint(job);

    let duplicate =
      byFingerprint.get(fp);

    if (!duplicate) {
      for (
        const [
          existingFp,
          existingJob
        ] of byFingerprint
      ) {
        if (
          similarity(
            existingFp,
            fp
          ) >= 0.88
        ) {
          duplicate =
            existingJob;

          break;
        }
      }
    }

    if (duplicate) {
      mergeInto(
        duplicate,
        job
      );

      metrics.duplicateJobs++;

      continue;
    }

    if (url) {
      byUrl.set(
        url,
        job
      );
    }

    byFingerprint.set(
      fp,
      job
    );

    output.push(job);
  }

  return output;
}

/* ============================================================
   27. PREVIOUS DATA
============================================================ */

async function loadPrevious() {
  try {
    const text =
      await fs.readFile(
        DATA_FILE,
        'utf8'
      );

    const data =
      JSON.parse(text);

    if (
      Array.isArray(
        data.jobs
      )
    ) {
      return data.jobs;
    }
  } catch (_) {}

  return [];
}

function mergePrevious(
  fresh,
  previous
) {
  const map =
    new Map();

  const now =
    nowIso();

  for (const job of previous) {
    if (!job?.id) continue;

    job.lastSeenAt =
      job.lastSeenAt ||
      now;

    map.set(
      job.id,
      job
    );
  }

  for (const job of fresh) {
    job.lastSeenAt =
      now;

    if (
      map.has(job.id)
    ) {
      mergeInto(
        map.get(job.id),
        job
      );
    } else {
      map.set(
        job.id,
        job
      );
    }
  }

  return dedupe(
    [...map.values()]
  );
}

/* ============================================================
   28. EXPIRY
============================================================ */

function removeExpired(jobs) {
  const cutoff =
    Date.now() -
    RETENTION_DAYS *
    86400000;

  return jobs.filter(
    job => {
      const published =
        safeDate(
          job.publishedAt,
          new Date(0)
        ).getTime();

      return (
        published >= cutoff
      );
    }
  );
}

/* ============================================================
   29. JOB SCORING
============================================================ */

function scoreJob(job) {
  let score = 0;

  const published =
    safeDate(
      job.publishedAt,
      new Date()
    );

  const ageDays =
    Math.max(
      0,
      (
        Date.now() -
        published.getTime()
      ) / 86400000
    );

  score +=
    Math.max(
      0,
      50 -
      ageDays * 2
    );

  score += Math.min(
    15,
    (job.description || '').length /
    80
  );

  score += Math.min(
    12,
    (job.skills || []).length *
    1.5
  );

  if (job.remote) {
    score += 5;
  }

  if (job.hybrid) {
    score += 3;
  }

  if (
    job.salaryRange &&
    job.salaryRange.min
  ) {
    score += 6;
  }

  if (
    job.company &&
    ![
      'Unknown',
      'Various',
      'RSS'
    ].includes(job.company)
  ) {
    score += 4;
  }

  if (job.verifiedSource) {
    score += 5;
  }

  if (
    job.sourceDomain
  ) {
    score += 2;
  }

  return Math.round(
    Math.min(
      100,
      score
    )
  );
}

function scoreSort(jobs) {
  for (const job of jobs) {
    job.score =
      scoreJob(job);
  }

  jobs.sort(
    (a, b) =>
      (b.score - a.score) ||
      (
        b.publishedAt ||
        ''
      ).localeCompare(
        a.publishedAt ||
        ''
      )
  );

  return jobs;
}

/* ============================================================
   30. SAFE FILE WRITER
============================================================ */

async function atomicWrite(
  file,
  data,
  json = false
) {
  await fs.mkdir(
    path.dirname(file),
    {
      recursive: true
    }
  );

  const temp =
    `${file}.${BUILD_ID}.tmp`;

  const content =
    json
      ? JSON.stringify(
          data,
          null,
          2
        )
      : String(data);

  await fs.writeFile(
    temp,
    content,
    'utf8'
  );

  if (json) {
    JSON.parse(
      await fs.readFile(
        temp,
        'utf8'
      )
    );
  }

  await fs.rename(
    temp,
    file
  );
}

/* ============================================================
   31. SEO JOB PAGE
============================================================ */

function jobPageTemplate(job) {
  const url =
    `${SITE_URL}/job/${job.slug}/`;

  const title =
    `${job.title} at ${job.company} in ${job.location} – Apply Now | GOO JOBS`;

  const description =
    cleanText(
      job.description
    ).substring(
      0,
      155
    );

  const datePosted =
    safeDate(
      job.publishedAt,
      new Date()
    ).toISOString();

  const validThrough =
    new Date(
      safeDate(
        job.publishedAt,
        new Date()
      ).getTime() +
      RETENTION_DAYS *
      86400000
    ).toISOString();

  const ld = {
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
      normalizeEmploymentType(
        job.employmentType
      ),

    hiringOrganization: {
      '@type':
        'Organization',

      name:
        job.company,

      sameAs:
        job.url
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

    url,

    directApply:
      false,

    sameAs: [
      job.url
    ]
  };

  if (
    job.salaryRange &&
    job.salaryRange.min
  ) {
    ld.baseSalary = {
      '@type':
        'MonetaryAmount',

      currency:
        job.salaryRange.currency ||
        'INR',

      value: {
        '@type':
          'QuantitativeValue',

        minValue:
          job.salaryRange.min,

        maxValue:
          job.salaryRange.max,

        unitText:
          'YEAR'
      }
    };
  }

  if (
    job.skills?.length
  ) {
    ld.skills =
      job.skills;
  }

  const skills =
    (job.skills || [])
      .map(
        skill =>
          `<span class="skill">${esc(skill)}</span>`
      )
      .join('');

  const remoteBadge =
    job.remote
      ? '<span class="badge remote">🌐 Remote</span>'
      : '';

  const hybridBadge =
    job.hybrid
      ? '<span class="badge hybrid">🔀 Hybrid</span>'
      : '';

  const salary =
    job.salaryRange?.min
      ? `₹${Math.round(job.salaryRange.min).toLocaleString('en-IN')} - ₹${Math.round(job.salaryRange.max).toLocaleString('en-IN')} / year`
      : (
          job.salary ||
          'Not Disclosed'
        );

  const descriptionHtml =
    (job.description ||
      'No description available.')
      .split(/\n+/)
      .map(
        paragraph =>
          `<p>${esc(paragraph)}</p>`
      )
      .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="theme-color" content="#070b14">

<title>${esc(title)}</title>

<meta
  name="description"
  content="${esc(
    `Apply for ${job.title} at ${job.company} in ${job.location}. ${description}`
  )}"
>

<link
  rel="canonical"
  href="${esc(url)}"
>

<meta
  property="og:type"
  content="website"
>

<meta
  property="og:title"
  content="${esc(title)}"
>

<meta
  property="og:description"
  content="${esc(description)}"
>

<meta
  property="og:url"
  content="${esc(url)}"
>

<meta
  property="og:image"
  content="${SITE_URL}/og.svg"
>

<meta
  name="twitter:card"
  content="summary_large_image"
>

<script type="application/ld+json">
${JSON.stringify(ld)}
</script>

<style>
:root{
  --bg:#070b14;
  --panel:#0d1424;
  --panel2:#111b2f;
  --line:#1d2a43;
  --text:#eef4ff;
  --muted:#91a0bb;
  --brand:#38bdf8;
  --brand2:#22d3ee;
  --green:#34d399;
  --purple:#a78bfa;
  --danger:#fb7185;
  --radius:22px;
  --shadow:0 20px 60px rgba(0,0,0,.38);
}

*{
  box-sizing:border-box;
}

html{
  scroll-behavior:smooth;
}

body{
  margin:0;
  background:
    radial-gradient(
      circle at top right,
      rgba(56,189,248,.08),
      transparent 35%
    ),
    var(--bg);
  color:var(--text);
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  line-height:1.65;
}

a{
  color:inherit;
  text-decoration:none;
}

.container{
  width:min(900px,calc(100% - 30px));
  margin:auto;
}

.header{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:15px;
  padding:22px 0;
  border-bottom:1px solid var(--line);
}

.logo{
  font-size:19px;
  font-weight:900;
  letter-spacing:.4px;
}

.logo span{
  color:var(--brand);
}

.nav{
  display:flex;
  gap:16px;
  flex-wrap:wrap;
}

.nav a{
  color:var(--muted);
  font-size:13px;
}

.nav a:hover{
  color:var(--text);
}

.hero{
  padding:38px 0 20px;
}

.source-row{
  display:flex;
  flex-wrap:wrap;
  gap:7px;
  margin-bottom:16px;
}

.badge{
  display:inline-flex;
  align-items:center;
  border:1px solid var(--line);
  background:#0b1322;
  color:var(--muted);
  padding:5px 10px;
  border-radius:999px;
  font-size:12px;
}

.badge.remote{
  color:var(--green);
  border-color:rgba(52,211,153,.28);
}

.badge.hybrid{
  color:var(--purple);
  border-color:rgba(167,139,250,.28);
}

h1{
  font-size:clamp(27px,5vw,42px);
  line-height:1.15;
  margin:0 0 20px;
  letter-spacing:-.8px;
}

.meta{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
}

.meta-item{
  padding:8px 12px;
  border:1px solid var(--line);
  border-radius:999px;
  background:#0b1322;
  color:var(--muted);
  font-size:13px;
}

.card{
  background:
    linear-gradient(
      145deg,
      rgba(255,255,255,.025),
      transparent
    ),
    var(--panel);
  border:1px solid var(--line);
  border-radius:var(--radius);
  padding:26px;
  margin:18px 0;
  box-shadow:var(--shadow);
}

.card h2{
  margin:0 0 15px;
  font-size:19px;
}

.description p{
  color:var(--muted);
  margin:0 0 13px;
}

.skills{
  display:flex;
  flex-wrap:wrap;
  gap:7px;
  margin-top:18px;
}

.skill{
  padding:6px 10px;
  border:1px solid var(--line);
  background:#0a1322;
  color:#aab8d0;
  border-radius:999px;
  font-size:12px;
}

.apply{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:100%;
  margin-top:25px;
  padding:15px 20px;
  border-radius:15px;
  background:
    linear-gradient(
      135deg,
      var(--brand2),
      var(--brand)
    );
  color:#03121c;
  font-weight:900;
  transition:
    transform .2s,
    box-shadow .2s;
}

.apply:hover{
  transform:translateY(-2px);
  box-shadow:
    0 15px 35px
    rgba(34,211,238,.2);
}

.note{
  color:var(--muted);
  font-size:12px;
  margin-top:10px;
  text-align:center;
}

.back{
  display:inline-flex;
  margin:4px 0 30px;
  padding:9px 14px;
  border:1px solid var(--line);
  border-radius:12px;
  color:var(--muted);
  font-size:13px;
}

.back:hover{
  color:var(--text);
  border-color:var(--brand);
}

.footer{
  border-top:1px solid var(--line);
  padding:28px 0 45px;
  color:var(--muted);
  font-size:12px;
  text-align:center;
}

@media(max-width:600px){
  .header{
    align-items:flex-start;
    flex-direction:column;
  }

  .nav{
    gap:10px;
  }

  .card{
    padding:20px;
  }
}
</style>
</head>

<body>

<div class="container">

<header class="header">
  <a class="logo" href="/">
    💼 <span>GOO</span> JOBS
  </a>

  <nav class="nav">
    <a href="/">Home</a>
    <a href="/sitemap.xml">Sitemap</a>
    <a href="/source-status.json">Status</a>
  </nav>
</header>

<main>

<section class="hero">

<div class="source-row">

<span class="badge">
  ✓ Verified
</span>

<span class="badge">
  ${esc(job.source)}
</span>

<span class="badge">
  ${esc(
    safeDate(
      job.publishedAt
    ).toISOString().substring(0,10)
  )}
</span>

${remoteBadge}
${hybridBadge}

</div>

<h1>
${esc(job.title)}
at
${esc(job.company)}
</h1>

<div class="meta">

<span class="meta-item">
📍 ${esc(job.location)}
</span>

<span class="meta-item">
🕒 ${esc(job.employmentType)}
</span>

<span class="meta-item">
🎯 ${esc(job.experienceLevel)}
</span>

<span class="meta-item">
💰 ${esc(salary)}
</span>

</div>

</section>

<section class="card">

<h2>
Job Description
</h2>

<div class="description">
${descriptionHtml}
</div>

${
  skills
    ? `
<h2 style="margin-top:25px">
Required Skills
</h2>

<div class="skills">
${skills}
</div>
`
    : ''
}

<a
  class="apply"
  href="${esc(job.url)}"
  target="_blank"
  rel="nofollow noopener noreferrer"
>
  Apply on Official Site ↗
</a>

<div class="note">
You will be redirected to the company's official careers page.
</div>

</section>

<a
  class="back"
  href="/"
>
← Back to all jobs
</a>

</main>

<footer class="footer">
© ${new Date().getFullYear()}
GOO JOBS · Job information belongs to respective sources.
</footer>

</div>

${ADSTERRA || ADSTERRA_TOKEN}

</body>
</html>`;
}

function normalizeEmploymentType(type) {
  const value =
    String(type || '')
      .toLowerCase();

  if (
    value.includes('part')
  ) {
    return 'PART_TIME';
  }

  if (
    value.includes('intern')
  ) {
    return 'INTERN';
  }

  if (
    value.includes('contract')
  ) {
    return 'CONTRACTOR';
  }

  if (
    value.includes('temporary')
  ) {
    return 'TEMPORARY';
  }

  return 'FULL_TIME';
}

/* ============================================================
   32. GENERATE JOB PAGES
============================================================ */

async function generateJobPages(
  jobs
) {
  if (!ENABLE_JOB_PAGES) {
    return 0;
  }

  let generated = 0;

  for (const job of jobs) {
    const directory =
      path.join(
        JOBS_DIR,
        job.slug
      );

    await fs.mkdir(
      directory,
      {
        recursive: true
      }
    );

    const html =
      jobPageTemplate(job);

    await atomicWrite(
      path.join(
        directory,
        'index.html'
      ),
      html
    );

    generated++;

    if (
      generated % 500 === 0
    ) {
      logger.info(
        'Job pages generated',
        {
          generated
        }
      );
    }
  }

  return generated;
}

/* ============================================================
   33. JOB JSON
============================================================ */

async function generateJobsJson(
  jobs,
  sourceStatus
) {
  await atomicWrite(
    DATA_FILE,
    {
      schemaVersion:
        '4.0',

      generatedAt:
        nowIso(),

      buildId:
        BUILD_ID,

      count:
        jobs.length,

      jobs,

      sources:
        sourceStatus
    },
    true
  );
}

/* ============================================================
   34. HOMEPAGE
============================================================ */

async function generateHomepage() {
  const source =
    path.join(
      ROOT,
      'index.html'
    );

  if (
    !fss.existsSync(source)
  ) {
    logger.warn(
      'Root index.html not found'
    );

    return;
  }

  let html =
    await fs.readFile(
      source,
      'utf8'
    );

  if (ADSTERRA) {
    html =
      html.split(
        ADSTERRA_TOKEN
      ).join(
        ADSTERRA
      );
  }

  await atomicWrite(
    path.join(
      PUBLIC,
      'index.html'
    ),
    html
  );
}

/* ============================================================
   35. SITEMAP
============================================================ */

function sitemapXml(
  urls
) {
  let xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n`;

  xml +=
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

  for (const item of urls) {
    xml +=
      `  <url>\n`;

    xml +=
      `    <loc>${esc(item.loc)}</loc>\n`;

    if (item.lastmod) {
      xml +=
        `    <lastmod>${esc(item.lastmod)}</lastmod>\n`;
    }

    if (item.changefreq) {
      xml +=
        `    <changefreq>${esc(item.changefreq)}</changefreq>\n`;
    }

    if (item.priority) {
      xml +=
        `    <priority>${esc(item.priority)}</priority>\n`;
    }

    xml +=
      `  </url>\n`;
  }

  xml +=
    `</urlset>`;

  return xml;
}

function sitemapIndexXml(
  files
) {
  let xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n`;

  xml +=
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

  for (const file of files) {
    xml +=
      `  <sitemap>\n`;

    xml +=
      `    <loc>${esc(
        `${SITE_URL}/${file}`
      )}</loc>\n`;

    xml +=
      `  </sitemap>\n`;
  }

  xml +=
    `</sitemapindex>`;

  return xml;
}

async function generateSitemap(
  jobs
) {
  const urls = [
    {
      loc:
        `${SITE_URL}/`,

      lastmod:
        nowIso().substring(
          0,
          10
        ),

      changefreq:
        'daily',

      priority:
        '1.0'
    },

    ...jobs.map(job => ({
      loc:
        `${SITE_URL}/job/${job.slug}/`,

      lastmod:
        safeDate(
          job.updatedAt,
          new Date()
        )
          .toISOString()
          .substring(
            0,
            10
          ),

      changefreq:
        'weekly',

      priority:
        '0.8'
    }))
  ];

  const parts =
    chunk(
      urls,
      SITEMAP_CHUNK_SIZE
    );

  const files = [];

  for (
    let i = 0;
    i < parts.length;
    i++
  ) {
    const filename =
      `sitemap-${i + 1}.xml`;

    await atomicWrite(
      path.join(
        PUBLIC,
        filename
      ),
      sitemapXml(
        parts[i]
      )
    );

    files.push(filename);
  }

  if (
    ENABLE_SITEMAP_INDEX &&
    files.length > 1
  ) {
    await atomicWrite(
      path.join(
        PUBLIC,
        'sitemap.xml'
      ),
      sitemapIndexXml(
        files
      )
    );
  } else if (
    files.length === 1
  ) {
    await atomicWrite(
      path.join(
        PUBLIC,
        'sitemap.xml'
      ),
      sitemapXml(
        urls
      )
    );
  }

  logger.info(
    'Sitemap generated',
    {
      urls:
        urls.length,

      files:
        files.length
    }
  );

  return files;
}

/* ============================================================
   36. ROBOTS
============================================================ */

async function generateRobots() {
  if (!ENABLE_ROBOTS) {
    return;
  }

  const content =
`User-agent: *
Allow: /

Disallow: /jobs.json
Disallow: /source-status.json
Disallow: /build-manifest.json

Sitemap: ${SITE_URL}/sitemap.xml
`;

  await atomicWrite(
    path.join(
      PUBLIC,
      'robots.txt'
    ),
    content
  );
}

/* ============================================================
   37. SOURCE STATUS
============================================================ */

async function generateSourceStatus(
  status
) {
  await atomicWrite(
    STATUS_FILE,
    {
      schemaVersion:
        '4.0',

      generatedAt:
        nowIso(),

      buildId:
        BUILD_ID,

      sources:
        status
    },
    true
  );
}

/* ============================================================
   38. BUILD MANIFEST
============================================================ */

async function generateManifest(
  jobs,
  sources
) {
  const categories = {};

  const companies = {};

  const locations = {};

  for (const job of jobs) {
    categories[job.category] =
      (categories[job.category] || 0) +
      1;

    companies[job.company] =
      (companies[job.company] || 0) +
      1;

    locations[job.location] =
      (locations[job.location] || 0) +
      1;
  }

  await atomicWrite(
    MANIFEST_FILE,
    {
      schemaVersion:
        '4.0',

      buildId:
        BUILD_ID,

      generatedAt:
        nowIso(),

      site:
        SITE_URL,

      jobs:
        jobs.length,

      sources,

      categories,

      topCompanies:
        Object.entries(
          companies
        )
          .sort(
            (a, b) =>
              b[1] - a[1]
          )
          .slice(0, 50),

      topLocations:
        Object.entries(
          locations
        )
          .sort(
            (a, b) =>
              b[1] - a[1]
          )
          .slice(0, 50)
    },
    true
  );
}

/* ============================================================
   39. VERIFICATION
============================================================ */

async function verifyBuild(
  jobs
) {
  const requiredFiles = [
    path.join(
      PUBLIC,
      'index.html'
    ),

    path.join(
      PUBLIC,
      'jobs.json'
    ),

    path.join(
      PUBLIC,
      'sitemap.xml'
    )
  ];

  for (
    const file of requiredFiles
  ) {
    await fs.access(
      file
    );
  }

  const slugSet =
    new Set();

  for (const job of jobs) {
    if (
      !job.slug
    ) {
      throw new Error(
        `Missing slug: ${job.id}`
      );
    }

    if (
      slugSet.has(
        job.slug
      )
    ) {
      throw new Error(
        `Duplicate slug: ${job.slug}`
      );
    }

    slugSet.add(
      job.slug
    );

    if (
      !/^https?:\/\//i.test(
        job.url || ''
      )
    ) {
      throw new Error(
        `Invalid URL: ${job.url}`
      );
    }
  }

  const json =
    JSON.parse(
      await fs.readFile(
        DATA_FILE,
        'utf8'
      )
    );

  if (
    !Array.isArray(
      json.jobs
    )
  ) {
    throw new Error(
      'jobs.json jobs array missing'
    );
  }

  if (
    json.jobs.length !==
    jobs.length
  ) {
    throw new Error(
      'jobs.json count mismatch'
    );
  }

  logger.info(
    'Build verification passed',
    {
      jobs:
        jobs.length
    }
  );
}

/* ============================================================
   40. SOURCE RUNNER
============================================================ */

const SOURCES = [
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

async function runSource(
  name,
  fn
) {
  const started =
    Date.now();

  try {
    const jobs =
      await fn();

    const duration =
      Date.now() -
      started;

    metrics.sources[name] = {
      ok: true,

      count:
        jobs.length,

      durationMs:
        duration,

      error:
        null
    };

    logger.info(
      `Source completed: ${name}`,
      {
        count:
          jobs.length,

        durationMs:
          duration
      }
    );

    return {
      name,
      ok: true,
      count: jobs.length,
      items: jobs,
      durationMs: duration,
      error: null
    };

  } catch (error) {
    const duration =
      Date.now() -
      started;

    metrics.sources[name] = {
      ok: false,

      count:
        0,

      durationMs:
        duration,

      error:
        error.message
    };

    logger.error(
      `Source failed: ${name}`,
      {
        error:
          error.message
      }
    );

    return {
      name,
      ok: false,
      count: 0,
      items: [],
      durationMs: duration,
      error:
        error.message
    };
  }
}

/* ============================================================
   41. SOURCE CONCURRENCY
============================================================ */

async function runSources() {
  const results =
    new Array(
      SOURCES.length
    );

  let cursor = 0;

  const workers =
    Array.from(
      {
        length:
          Math.min(
            SOURCE_CONCURRENCY,
            SOURCES.length
          )
      },
      async () => {
        while (true) {
          const index =
            cursor++;

          if (
            index >=
            SOURCES.length
          ) {
            return;
          }

          const [
            name,
            fn
          ] =
            SOURCES[index];

          results[index] =
            await runSource(
              name,
              fn
            );
        }
      }
    );

  await Promise.all(
    workers
  );

  return results;
}

/* ============================================================
   42. MAIN BUILD
============================================================ */

async function main() {
  logger.info(
    '========================================'
  );

  logger.info(
    'GOO JOBS v4 BUILD START'
  );

  logger.info(
    '========================================',
    {
      buildId:
        BUILD_ID,

      target:
        TARGET,

      retentionDays:
        RETENTION_DAYS,

      concurrency:
        CONCURRENCY,

      rpm:
        RPM
    }
  );

  await fs.mkdir(
    PUBLIC,
    {
      recursive: true
    }
  );

  await fs.mkdir(
    JOBS_DIR,
    {
      recursive: true
    }
  );

  await fs.mkdir(
    CACHE_DIR,
    {
      recursive: true
    }
  );

  await fs.mkdir(
    LOG_DIR,
    {
      recursive: true
    }
  );

  const previous =
    await loadPrevious();

  logger.info(
    'Previous jobs loaded',
    {
      count:
        previous.length
    }
  );

  const sourceResults =
    await runSources();

  let rawJobs = [];

  const sourceStatus = {};

  for (
    const result of
    sourceResults
  ) {
    sourceStatus[result.name] = {
      ok:
        result.ok,

      count:
        result.count,

      durationMs:
        result.durationMs,

      error:
        result.error
    };

    if (
      result.items?.length
    ) {
      rawJobs.push(
        ...result.items
      );
    }
  }

  metrics.rawJobs =
    rawJobs.length;

  logger.info(
    'Raw jobs collected',
    {
      count:
        rawJobs.length
    }
  );

  let normalized =
    rawJobs
      .map(
        normalizeJob
      )
      .filter(
        isValid
      );

  metrics.validJobs =
    normalized.length;

  logger.info(
    'Validation complete',
    {
      valid:
        normalized.length
    }
  );

  normalized =
    dedupe(
      normalized
    );

  logger.info(
    'Deduplication complete',
    {
      unique:
        normalized.length,

      duplicates:
        metrics.duplicateJobs
    }
  );

  let merged =
    mergePrevious(
      normalized,
      previous
    );

  logger.info(
    'Previous data merged',
    {
      total:
        merged.length
    }
  );

  merged =
    removeExpired(
      merged
    );

  logger.info(
    'Expired jobs removed',
    {
      remaining:
        merged.length
    }
  );

  merged =
    scoreSort(
      merged
    );

  let active =
    merged.slice(
      0,
      TARGET
    );

  /*
   * IMPORTANT:
   * If every live source fails but previous data exists,
   * preserve previous jobs instead of publishing an empty site.
   */

  const successfulSources =
    sourceResults.filter(
      r => r.ok && r.count > 0
    );

  if (
    active.length === 0 &&
    previous.length > 0 &&
    KEEP_PREVIOUS_ON_FAILURE
  ) {
    logger.warn(
      'No usable fresh jobs. Preserving previous dataset.'
    );

    active =
      scoreSort(
        removeExpired(
          previous
        )
      ).slice(
        0,
        TARGET
      );
  }

  metrics.finalJobs =
    active.length;

  if (
    active.length === 0
  ) {
    throw new Error(
      'Build produced zero jobs.'
    );
  }

  await generateJobPages(
    active
  )
    .then(
      count => {
        metrics.pagesGenerated =
          count;
      }
    );

  await generateJobsJson(
    active,
    sourceStatus
  );

  await generateHomepage();

  await generateSitemap(
    active
  );

  await generateRobots();

  await generateSourceStatus(
    sourceStatus
  );

  await generateManifest(
    active,
    sourceStatus
  );

  await verifyBuild(
    active
  );

  metrics.finishedAt =
    nowIso();

  metrics.durationMs =
    Date.now() -
    new Date(
      BUILD_STARTED_AT
    ).getTime();

  await logger.save();

  logger.info(
    '========================================'
  );

  logger.info(
    'GOO JOBS v4 BUILD COMPLETE',
    {
      buildId:
        BUILD_ID,

      jobs:
        active.length,

      pages:
        metrics.pagesGenerated,

      durationMs:
        metrics.durationMs,

      successfulSources:
        successfulSources.length,

      totalSources:
        SOURCES.length
    }
  );

  logger.info(
    '========================================'
  );
}

/* ============================================================
   43. HEALTH SERVER
============================================================ */

let healthServer = null;

function startHealthServer() {
  if (!ENABLE_HEALTH) {
    return;
  }

  healthServer =
    http.createServer(
      (_, response) => {
        response.writeHead(
          200,
          {
            'Content-Type':
              'application/json; charset=utf-8',

            'Cache-Control':
              'no-store'
          }
        );

        response.end(
          JSON.stringify(
            {
              ok: true,

              service:
                'goo-jobs-generator',

              version:
                '4.0',

              buildId:
                BUILD_ID,

              time:
                nowIso()
            }
          )
        );
      }
    );

  healthServer.listen(
    HEALTH_PORT,
    () => {
      logger.info(
        'Health server started',
        {
          port:
            HEALTH_PORT
        }
      );
    }
  );
}

/* ============================================================
   44. SHUTDOWN
============================================================ */

let shuttingDown =
  false;

async function shutdown(
  code
) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  try {
    if (healthServer) {
      healthServer.close();
    }
  } catch (_) {}

  try {
    await logger.save();
  } catch (_) {}

  process.exit(
    code
  );
}

process.on(
  'SIGINT',
  () => {
    logger.warn(
      'SIGINT received'
    );

    shutdown(130);
  }
);

process.on(
  'SIGTERM',
  () => {
    logger.warn(
      'SIGTERM received'
    );

    shutdown(143);
  }
);

process.on(
  'uncaughtException',
  async error => {
    logger.error(
      'Uncaught exception',
      {
        error:
          error.message,

        stack:
          error.stack
      }
    );

    await logger.save();

    process.exit(1);
  }
);

process.on(
  'unhandledRejection',
  async error => {
    logger.error(
      'Unhandled rejection',
      {
        error:
          error?.message ||
          String(error)
      }
    );

    await logger.save();

    process.exit(1);
  }
);

/* ============================================================
   45. START
============================================================ */

startHealthServer();

main()
  .catch(
    async error => {
      logger.error(
        'BUILD FAILED',
        {
          error:
            error.message,

          stack:
            error.stack
        }
      );

      metrics.finishedAt =
        nowIso();

      metrics.durationMs =
        Date.now() -
        new Date(
          BUILD_STARTED_AT
        ).getTime();

      await logger.save();

      process.exit(1);
    }
  );
