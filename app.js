import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import slugify from 'slugify';
import { OpenAI } from 'openai';
import { convert } from 'html-to-text';
import cron from 'node-cron';
import crypto from 'node:crypto';
import sax from 'sax';
import fetch from 'node-fetch';

// ========================================
// ENVIRONMENT VARIABLES
// ========================================
const PORT = Number(process.env.PORT || 3000);
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const SITE_NAME = process.env.SITE_NAME || 'Job Board';
const FAVICON_URL = process.env.FAVICON_URL || '';
const SITE_LOGO = process.env.SITE_LOGO || '';
const SITE_SAMEAS = process.env.SITE_SAMEAS || ''; // Comma-separated social URLs
const TARGET_LANG = process.env.TARGET_LANG || 'en';
const FEED_URL = process.env.FEED_URL || '';
const MAX_JOBS = Number(process.env.MAX_JOBS || 50000);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 */6 * * *';
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const CLICK_SECRET = process.env.CLICK_SECRET || crypto.randomBytes(16).toString('hex');
const TARGET_PROFESSION = process.env.TARGET_PROFESSION || 'lkw-fahrer';
const AI_PROCESS_LIMIT = Number(process.env.AI_PROCESS_LIMIT || 0); // 0 = unlimited

// Keywords for profession matching (lowercase)
const PROFESSION_KEYWORDS = (process.env.PROFESSION_KEYWORDS || 'lkw-fahrer,lkw fahrer,berufskraftfahrer,fernfahrer,lastwagenfahrer')
  .toLowerCase()
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ========================================
// DATABASE SETUP
// ========================================
const db = new Database('jobs.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE,
    source TEXT,
    title TEXT,
    company TEXT,
    description_html TEXT,
    description_short TEXT,
    url TEXT,
    published_at INTEGER,
    slug TEXT UNIQUE,
    tags_csv TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_published ON jobs(published_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_slug ON jobs(slug);
  CREATE INDEX IF NOT EXISTS idx_jobs_guid ON jobs(guid);

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    slug TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);
  CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

  CREATE TABLE IF NOT EXISTS job_tags (
    job_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    UNIQUE(job_id, tag_id) ON CONFLICT IGNORE
  );
  CREATE INDEX IF NOT EXISTS idx_job_tags_job_id ON job_tags(job_id);
  CREATE INDEX IF NOT EXISTS idx_job_tags_tag_id ON job_tags(tag_id);

  CREATE TABLE IF NOT EXISTS stats_cache (
    key TEXT PRIMARY KEY,
    value INTEGER,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ========================================
// PREPARED STATEMENTS
// ========================================
const stmtInsertJob = db.prepare(`
  INSERT OR IGNORE INTO jobs
  (guid, source, title, company, description_html, description_short, url, published_at, slug, tags_csv)
  VALUES
  (@guid, @source, @title, @company, @description_html, @description_short, @url, @published_at, @slug, @tags_csv)
`);
const stmtHasGuid = db.prepare(`SELECT id FROM jobs WHERE guid=? LIMIT 1`);
const stmtBySlug = db.prepare(`SELECT * FROM jobs WHERE slug=? LIMIT 1`);
const stmtById = db.prepare(`SELECT * FROM jobs WHERE id=? LIMIT 1`);

// Cursor-based pagination
const stmtPageCursor = db.prepare(`
  SELECT id, title, company, description_short, slug, published_at
  FROM jobs
  WHERE published_at < ? OR (published_at = ? AND id < ?)
  ORDER BY published_at DESC, id DESC
  LIMIT ?
`);
const stmtPageFirst = db.prepare(`
  SELECT id, title, company, description_short, slug, published_at
  FROM jobs
  ORDER BY published_at DESC, id DESC
  LIMIT ?
`);

// Search
const stmtSearch = db.prepare(`
  SELECT id, title, company, description_short, slug, published_at
  FROM jobs
  WHERE title LIKE ? OR company LIKE ?
  ORDER BY published_at DESC, id DESC
  LIMIT 100
`);

// Tag queries
const stmtGetTagBySlug = db.prepare(`SELECT * FROM tags WHERE slug=? LIMIT 1`);
const stmtGetTagByName = db.prepare(`SELECT * FROM tags WHERE name=? LIMIT 1`);
const stmtInsertTag = db.prepare(`INSERT OR IGNORE INTO tags (name, slug) VALUES (?, ?)`);
const stmtInsertJobTag = db.prepare(`INSERT OR IGNORE INTO job_tags (job_id, tag_id) VALUES (?, ?)`);
const stmtCountJobsByTagId = db.prepare(`SELECT COUNT(*) AS c FROM job_tags WHERE tag_id=?`);
const stmtJobsByTagCursor = db.prepare(`
  SELECT j.id, j.title, j.company, j.description_short, j.slug, j.published_at
  FROM jobs j
  JOIN job_tags jt ON jt.job_id = j.id
  JOIN tags t ON t.id = jt.tag_id
  WHERE t.slug = ? AND (j.published_at < ? OR (j.published_at = ? AND j.id < ?))
  ORDER BY j.published_at DESC, j.id DESC
  LIMIT ?
`);
const stmtJobsByTagFirst = db.prepare(`
  SELECT j.id, j.title, j.company, j.description_short, j.slug, j.published_at
  FROM jobs j
  JOIN job_tags jt ON jt.job_id = j.id
  JOIN tags t ON t.id = jt.tag_id
  WHERE t.slug = ?
  ORDER BY j.published_at DESC, j.id DESC
  LIMIT ?
`);

const stmtPopularTags = db.prepare(`
  SELECT t.name, t.slug, COUNT(*) AS cnt
  FROM tags t
  JOIN job_tags jt ON jt.tag_id = t.id
  GROUP BY t.id
  HAVING cnt >= ?
  ORDER BY cnt DESC, t.name ASC
  LIMIT ?
`);

const stmtRecent = db.prepare(`
  SELECT title, slug, published_at FROM jobs
  ORDER BY published_at DESC, id DESC
  LIMIT ?
`);

// Stats cache
const stmtGetCache = db.prepare(`SELECT value FROM stats_cache WHERE key=? AND updated_at > ?`);
const stmtSetCache = db.prepare(`
  INSERT OR REPLACE INTO stats_cache (key, value, updated_at) 
  VALUES (?, ?, strftime('%s','now'))
`);

function getCachedCount(ttlSeconds = 300) {
  const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;
  const cached = stmtGetCache.get('total_jobs', cutoff);
  if (cached) return cached.value;
  
  const count = db.prepare(`SELECT COUNT(*) as c FROM jobs`).get().c;
  stmtSetCache.run('total_jobs', count);
  return count;
}

const stmtDeleteOld = db.prepare(`
  DELETE FROM jobs WHERE id IN (
    SELECT id FROM jobs ORDER BY published_at DESC, id DESC LIMIT -1 OFFSET ?
  )
`);

// ========================================
// HELPER FUNCTIONS
// ========================================
const openai = HAS_OPENAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const mkSlug = (s) => slugify(String(s || 'job'), { lower: true, strict: true }).slice(0, 120);
const unixtime = (d) => Math.floor(new Date(d).getTime() / 1000);

function truncateWords(txt, n = 60) {
  const words = (txt || '').split(/\s+/);
  if (words.length <= n) return txt || '';
  return words.slice(0, n).join(' ') + '…';
}

function uniqNormTags(tags = []) {
  const seen = new Set();
  const out = [];
  for (let t of tags) {
    if (!t) continue;
    t = String(t).trim().toLowerCase();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 8);
}

function tagSlug(t) { return mkSlug(t); }

// Security: Sanitize HTML to prevent XSS
function sanitizeHtml(html = '') {
  if (!html) return '';
  // Remove script tags and event handlers
  return String(html)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]*/gi, '');
}

// HTML escaping for text content
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

// Canonical URL helper
function canonical(path = '') {
  return `${SITE_URL}${path}`;
}

// Check if job matches target profession
function matchesProfession(title = '', company = '', description = '') {
  const text = `${title} ${company} ${description}`.toLowerCase();
  return PROFESSION_KEYWORDS.some(keyword => text.includes(keyword));
}

// Extract tags related to profession
const PROFESSION_TAGS = {
  'lkw-fahrer': [
    'führerschein ce', 'führerschein c', 'führerschein c1', 'führerschein c1e', 'klasse ce', 'klasse c',
    'berufskraftfahrerqualifikation', 'bkf', 'beschleunigte grundqualifikation', 'adr-schein', 'adr', 
    'gefahrgut', 'gabelstaplerschein', 'ladungssicherung', 'digitaler tachograph',
    'sattelzug', 'sattelschlepper', 'solo', 'gliederzug', 'kipper', 'pritsche', 'plane',
    'kühlfahrzeug', 'tiefkühler', 'tankwagen', 'silo', 'wechselbrücke', 'container',
    'fernverkehr', 'fernfahrer', 'nahverkehr', 'regional', 'national', 'international',
    'werksverkehr', 'baustellenverkehr', 'distribution', 'spedition',
    '40-tonner', '7.5-tonner', '12-tonner', 'schwerlast', 'überbreite', 'überlänge',
    'nachtfahrten', 'wochenendarbeit', 'schichtarbeit', 'tourplanung'
  ],
  'truck driver': ['class 1', 'class a', 'cdl', 'long haul', 'regional', 'local', 'tanker', 'flatbed', 'otr', 'hazmat'],
  'software engineer': ['javascript', 'python', 'java', 'react', 'node', 'backend', 'frontend', 'full stack', 'devops'],
  'nurse': ['rn', 'lpn', 'icu', 'emergency', 'pediatric', 'surgical', 'critical care', 'oncology'],
  'electrician': ['commercial', 'residential', 'industrial', 'apprentice', 'journeyman', 'master electrician'],
  'mechanic': ['automotive', 'diesel', 'heavy equipment', 'marine', 'aircraft', 'ase certified'],
  'welder': ['mig', 'tig', 'stick', 'flux core', 'pipe welding', 'structural', 'stainless steel'],
  'warehouse': ['forklift', 'reach truck', 'picker', 'packer', 'shipping', 'receiving', 'inventory'],
};

function extractTags({ title = '', company = '', html = '' }) {
  const text = `${title} ${company} ${convert(html || '', { wordwrap: 120 }).slice(0, 1000)}`.toLowerCase();
  
  const profKey = TARGET_PROFESSION.toLowerCase();
  const profTags = PROFESSION_TAGS[profKey] || PROFESSION_TAGS['truck driver'] || [];
  const found = profTags.filter(tag => text.includes(tag));
  
  if (/(remote|homeoffice|home office)/i.test(text)) found.push('remote');
  if (/(vollzeit|full time|full-time)/i.test(text)) found.push('vollzeit');
  if (/(teilzeit|part time|part-time)/i.test(text)) found.push('teilzeit');
  if (/(festanstellung|unbefristet|permanent)/i.test(text)) found.push('festanstellung');
  if (/(befristet|temporary|zeitarbeit)/i.test(text)) found.push('befristet');
  
  found.push(TARGET_PROFESSION.toLowerCase());
  
  return uniqNormTags(found);
}

function parseMeta(textHTML = '', title = '') {
  const text = (convert(textHTML, { wordwrap: 1000 }) + ' ' + title).toLowerCase();

  let employmentType = 'FULL_TIME';
  if (/(teilzeit|part[-\s]?time)\b/i.test(text)) employmentType = 'PART_TIME';
  else if (/(zeitarbeit|befristet|contract)\b/i.test(text)) employmentType = 'CONTRACTOR';
  else if (/(praktikum|intern|ausbildung)\b/i.test(text)) employmentType = 'INTERN';
  else if (/(temporary|seasonal|saisonarbeit)\b/i.test(text)) employmentType = 'TEMPORARY';

  const isRemote = /(remote|homeoffice|home office|work from home|telecommute)/i.test(text);

  let currency = null, min = null, max = null, unit = 'HOUR';
  if (/\b(jahr|jährlich|year|yearly|per year|annually)\b/i.test(text)) unit = 'YEAR';
  else if (/\b(monat|monthly|per month|pro monat)\b/i.test(text)) unit = 'MONTH';
  else if (/\b(woche|week|weekly|pro woche)\b/i.test(text)) unit = 'WEEK';
  else if (/\b(tag|day|daily|pro tag)\b/i.test(text)) unit = 'DAY';
  else if (/\b(stunde|hour|hourly|pro stunde)\b/i.test(text)) unit = 'HOUR';

  const cMatch = text.match(/\b(eur|euro|usd|chf|gbp)\b|[€$£]/i);
  if (cMatch) {
    const c = cMatch[0].toUpperCase();
    currency = (c === '€' || c === 'EUR' || c === 'EURO') ? 'EUR'
      : (c === '$' || c === 'USD') ? 'USD'
      : (c === '£' || c === 'GBP') ? 'GBP'
      : c === 'CHF' ? 'CHF' : null;
  }

  const range = text.match(/(\d{1,2}[.,]?\d{3,6})\s*[-–—bis]\s*(\d{1,2}[.,]?\d{3,6})/i);
  if (range) {
    min = Number(range[1].replace(/[.,]/g, '')); 
    max = Number(range[2].replace(/[.,]/g, ''));
  } else {
    const one = text.match(/(?:ab|from|von)\s*(\d{1,2}[.,]?\d{3,6})|(\d{1,2}[.,]?\d{3,6})\s*(?:\+|bis)/i);
    if (one) { 
      const val = one[1] || one[2];
      min = Number(val.replace(/[.,]/g, '')); 
    }
  }

  return { employmentType, isRemote, salary: (currency && (min || max)) ? { currency, min, max, unit } : null };
}

// AI rewriting with fallback (used for both feed and manual posts)
async function rewriteJobRich({ title, company, html }, forceAI = false) {
  const plain = convert(html || '', {
    wordwrap: 120,
    selectors: [{ selector: 'a', options: { ignoreHref: true } }]
  }).slice(0, 9000);

  const fallback = () => {
    const paragraphs = plain.split(/\n+/).filter(Boolean).slice(0, 6).map(p => `<p>${escapeHtml(p)}</p>`).join('\n');
    const fallbackHTML = `
<section><h2>About the role</h2>${paragraphs || '<p>Details provided by the employer.</p>'}</section>
<section><h2>Responsibilities</h2><ul><li>Perform core duties as described.</li></ul></section>
<section><h2>Requirements</h2><ul><li>Relevant experience or willingness to learn.</li></ul></section>
<section><h2>How to apply</h2><p>Use the Apply button to proceed.</p></section>`.trim();

    return {
      short: truncateWords(plain, 45),
      html: sanitizeHtml(fallbackHTML),
      tags: extractTags({ title, company, html }),
      usedAI: false
    };
  };

  if (!HAS_OPENAI || (!forceAI && !openai)) {
    return fallback();
  }

  const system = `You are a job content editor specializing in ${TARGET_PROFESSION} positions. Create structured HTML description.
Language: ${TARGET_LANG}. Output THREE sections:

SHORT: 35-60 words plain text summary

HTML: Well-structured with sections for: About the role, Responsibilities, Requirements, Benefits, Compensation, Location & Schedule, How to apply

TAGS: JSON array of 3-8 relevant lowercase tags specific to ${TARGET_PROFESSION} work`;

  const user = `Job: ${title || 'N/A'}\nCompany: ${company || 'N/A'}\nText:\n${plain}`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const out = resp.choices?.[0]?.message?.content || '';
    const shortMatch = out.match(/SHORT[\s\S]*?:([\s\S]*?)HTML/i);
    const htmlMatch = out.match(/HTML[\s\S]*?:([\s\S]*?)TAGS/i);
    const tagsMatch = out.match(/TAGS[\s\S]*?:([\s\S]*)$/i);

    const short = (shortMatch?.[1] || out).trim().slice(0, 600);
    const htmlOut = (htmlMatch?.[1] || `<section><h2>About</h2><p>${escapeHtml(short)}</p></section>`).trim();
    
    let tagsParsed = null;
    try {
      const m = (tagsMatch?.[1] || '').match(/\[[\s\S]*\]/);
      if (m) tagsParsed = JSON.parse(m[0]);
    } catch {}
    
    const tags = uniqNormTags(tagsParsed || extractTags({ title, company, html }));

    return { 
      short, 
      html: sanitizeHtml(htmlOut), 
      tags,
      usedAI: true 
    };
  } catch (e) {
    console.error('OpenAI error:', e.message);
    return fallback();
  }
}

function upsertTagsForJob(jobId, tags = []) {
  const insertTag = db.transaction((names) => {
    for (const name of names) {
      const slug = tagSlug(name);
      stmtInsertTag.run(name, slug);
      const t = stmtGetTagByName.get(name);
      if (t) stmtInsertJobTag.run(jobId, t.id);
    }
  });
  insertTag(tags);
}

// ========================================
// FEED PROCESSING (with AI limit)
// ========================================
let FEED_RUNNING = false;

export async function processFeed() {
  if (FEED_RUNNING) {
    console.log('Feed processing already running, skipping...');
    return;
  }

  if (!FEED_URL) {
    console.log('No FEED_URL configured');
    return;
  }

  FEED_RUNNING = true;

  try {
    console.log(`\n🔄 Fetching XML feed: ${FEED_URL}`);
    console.log(`🎯 Filtering for profession: ${TARGET_PROFESSION}`);
    console.log(`🔑 Keywords: ${PROFESSION_KEYWORDS.join(', ')}`);
    console.log(`🤖 AI Processing: ${AI_PROCESS_LIMIT === 0 ? 'Unlimited' : `First ${AI_PROCESS_LIMIT} jobs`}`);
    console.log('📡 Starting streaming XML parser...\n');

    const response = await fetch(FEED_URL);
    const stream = response.body;

    let matched = 0;
    let processed = 0;
    let skipped = 0;
    let aiEnhanced = 0;
    let fallbackUsed = 0;

    const batchSize = 100;
    const insertBatch = db.transaction((jobs) => {
      for (const job of jobs) {
        stmtInsertJob.run(job);
        const inserted = stmtHasGuid.get(job.guid);
        if (inserted) {
          upsertTagsForJob(inserted.id, job.tags_csv.split(', ').filter(Boolean));
        }
      }
    });

    let batch = [];
    let currentItem = null;
    let currentTag = '';
    let currentText = '';

    const parser = sax.createStream(true, { 
      trim: true,
      normalize: true 
    });

    parser.on('opentag', (node) => {
      currentTag = node.name.toLowerCase();
      currentText = '';
      
      if (currentTag === 'job' || currentTag === 'item') {
        currentItem = {
          title: '',
          description: '',
          company: '',
          link: '',
          guid: '',
          pubDate: new Date().toISOString()
        };
      }
    });

    parser.on('text', (text) => {
      currentText += text;
    });
    
    parser.on('cdata', (text) => {
      currentText += text;
    });

    parser.on('closetag', (tagName) => {
      tagName = tagName.toLowerCase();
      
      if (!currentItem) return;

      switch (tagName) {
        case 'title':
          currentItem.title = currentText.trim();
          break;
        case 'description':
          currentItem.description = currentText.trim();
          break;
        case 'company':
          currentItem.company = currentText.trim();
          break;
        case 'url':
        case 'link':
          currentItem.link = currentText.trim();
          break;
        case 'guid':
        case 'referencenumber':
          if (!currentItem.guid) currentItem.guid = currentText.trim();
          break;
        case 'pubdate':
        case 'date_updated':
          currentItem.pubDate = currentText.trim();
          break;
      }

      if (tagName === 'job' || tagName === 'item') {
        processed++;
        
        if (processed % 10000 === 0) {
          console.log(`📊 Processed ${processed.toLocaleString()} items (matched: ${matched.toLocaleString()}, skipped: ${skipped.toLocaleString()})`);
        }

        const guid = currentItem.guid || currentItem.link || `job-${processed}`;

        if (stmtHasGuid.get(guid)) {
          skipped++;
          currentItem = null;
          return;
        }

        if (!matchesProfession(currentItem.title, currentItem.company, currentItem.description)) {
          skipped++;
          currentItem = null;
          return;
        }

        matched++;

        batch.push({
          rawTitle: currentItem.title,
          rawCompany: currentItem.company,
          rawDescription: currentItem.description,
          guid,
          source: new URL(FEED_URL).hostname,
          url: currentItem.link,
          published_at: unixtime(currentItem.pubDate)
        });

        currentItem = null;
      }
    });

    parser.on('error', (err) => {
      console.error('❌ SAX Parser Error:', err.message);
    });

    await new Promise((resolve, reject) => {
      stream.pipe(parser);
      
      parser.on('end', async () => {
        if (batch.length > 0) {
          console.log(`\n✨ Processing ${batch.length} matched jobs...`);
          
          const processedBatch = [];
          for (let i = 0; i < batch.length; i++) {
            const rawJob = batch[i];
            
            // Apply AI limit: only process first N jobs with AI, rest use fallback
            const shouldUseAI = AI_PROCESS_LIMIT === 0 || aiEnhanced < AI_PROCESS_LIMIT;
            
            const { short, html, tags, usedAI } = await rewriteJobRich({ 
              title: rawJob.rawTitle, 
              company: rawJob.rawCompany, 
              html: rawJob.rawDescription 
            }, shouldUseAI);
            
            if (usedAI) {
              aiEnhanced++;
              if (aiEnhanced % 10 === 0) {
                console.log(`🤖 AI-enhanced: ${aiEnhanced} jobs...`);
              }
            } else {
              fallbackUsed++;
            }
            
            const slug = mkSlug(`${rawJob.rawTitle}-${rawJob.rawCompany}`) || mkSlug(rawJob.rawTitle) || mkSlug(rawJob.guid);
            
            processedBatch.push({
              guid: rawJob.guid,
              source: rawJob.source,
              title: rawJob.rawTitle || 'Untitled',
              company: rawJob.rawCompany || '',
              description_html: html,
              description_short: truncateWords(short, 60),
              url: rawJob.url || '',
              published_at: rawJob.published_at,
              slug,
              tags_csv: tags.join(', ')
            });
            
            if (processedBatch.length >= batchSize) {
              insertBatch(processedBatch);
              processedBatch.length = 0;
            }
          }
          
          if (processedBatch.length > 0) {
            insertBatch(processedBatch);
          }
        }
        
        resolve();
      });
      
      parser.on('error', reject);
      stream.on('error', reject);
    });

    console.log(`\n✅ Feed processing complete!`);
    console.log(`📈 Total processed: ${processed.toLocaleString()} items`);
    console.log(`✨ Matched profession: ${matched.toLocaleString()} jobs`);
    console.log(`🤖 AI-enhanced: ${aiEnhanced.toLocaleString()} jobs`);
    console.log(`⚡ Fast fallback: ${fallbackUsed.toLocaleString()} jobs`);
    console.log(`⏭️  Skipped: ${skipped.toLocaleString()} (duplicates/non-matching)\n`);

    const total = getCachedCount(0);
    if (total > MAX_JOBS) {
      console.log(`🧹 Cleaning up: keeping ${MAX_JOBS.toLocaleString()} most recent jobs`);
      stmtDeleteOld.run(MAX_JOBS);
      stmtSetCache.run('total_jobs', MAX_JOBS);
    }
  } catch (error) {
    console.error('❌ Feed processing error:', error.message);
    throw error;
  } finally {
    FEED_RUNNING = false;
  }
}

// ========================================
// CSS STYLES (Modern blue theme)
// ========================================
const baseCss = `
:root {
  --primary: #2563eb;
  --primary-dark: #1e40af;
  --bg: #f8fafc;
  --card: #ffffff;
  --text: #1e293b;
  --text-muted: #64748b;
  --border: #e2e8f0;
  --shadow: 0 1px 3px rgba(0,0,0,0.1);
  --shadow-lg: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
  line-height: 1.6;
}

.wrap {
  max-width: 1000px;
  margin: 0 auto;
  padding: 20px;
}

header.wrap {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 24px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border);
  background: var(--card);
  flex-wrap: wrap;
  gap: 16px;
}

header h1 {
  margin: 0;
  font-size: 24px;
}

header h1 a {
  color: var(--text);
  text-decoration: none;
  font-weight: 700;
}

nav {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

nav a {
  color: var(--text-muted);
  text-decoration: none;
  padding: 8px 12px;
  border-radius: 6px;
  transition: all 0.2s;
}

nav a:hover {
  color: var(--primary);
  background: var(--bg);
}

.btn {
  display: inline-block;
  padding: 10px 18px;
  background: var(--text);
  color: white;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  transition: all 0.2s;
}

.btn:hover {
  background: var(--text-muted);
  transform: translateY(-1px);
}

.btn-primary {
  background: var(--primary);
  color: white;
  font-weight: 600;
}

.btn-primary:hover {
  background: var(--primary-dark);
}

.card {
  background: var(--card);
  border-radius: 12px;
  padding: 24px;
  margin: 16px 0;
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  transition: all 0.2s;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  border-color: var(--primary);
}

.list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.muted {
  color: var(--text-muted);
}

.small {
  font-size: 14px;
}

.search-form {
  margin: 24px 0;
}

.search-form input[type="search"] {
  width: 100%;
  max-width: 500px;
  padding: 12px 16px;
  border: 2px solid var(--border);
  border-radius: 8px;
  font-size: 16px;
  transition: all 0.2s;
}

.search-form input[type="search"]:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.pager {
  display: flex;
  gap: 12px;
  margin: 24px 0;
  flex-wrap: wrap;
}

.pager a, .pager .current {
  padding: 8px 16px;
  background: var(--card);
  border-radius: 8px;
  color: var(--text);
  text-decoration: none;
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  transition: all 0.2s;
}

.pager a:hover {
  background: var(--primary);
  color: white;
  border-color: var(--primary);
}

.pager .disabled {
  opacity: 0.5;
  pointer-events: none;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.tag {
  background: #eff6ff;
  color: var(--primary);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  text-decoration: none;
  transition: all 0.2s;
  border: 1px solid #dbeafe;
}

.tag:hover {
  background: var(--primary);
  color: white;
  border-color: var(--primary);
}

.content h2 {
  color: var(--text);
  margin-top: 24px;
  font-size: 20px;
}

.content p, .content ul, .content ol {
  line-height: 1.7;
  margin: 12px 0;
}

.content ul, .content ol {
  padding-left: 24px;
}

form label {
  display: block;
  margin-top: 16px;
  margin-bottom: 6px;
  font-weight: 500;
  color: var(--text);
}

form input[type="text"],
form input[type="url"],
form input[type="number"],
form select,
form textarea {
  width: 100%;
  padding: 10px 14px;
  border: 2px solid var(--border);
  border-radius: 8px;
  font-size: 15px;
  font-family: inherit;
  transition: all 0.2s;
}

form input:focus,
form select:focus,
form textarea:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

form textarea {
  min-height: 150px;
  resize: vertical;
}

form button[type="submit"] {
  margin-top: 20px;
}

.form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.help-text {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 4px;
}

footer {
  margin-top: 60px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}

@media (max-width: 768px) {
  header.wrap {
    flex-direction: column;
    align-items: flex-start;
  }
  
  nav {
    width: 100%;
    justify-content: flex-start;
  }
  
  .form-row {
    grid-template-columns: 1fr;
  }
}
`;

// ========================================
// HTML LAYOUT FUNCTION
// ========================================
function layout({ title, body, metaExtra = '', breadcrumbs = null }) {
  const faviconHtml = FAVICON_URL ? `<link rel="icon" href="${escapeHtml(FAVICON_URL)}"/>` : '';
  const canonicalUrl = canonical(breadcrumbs ? breadcrumbs[breadcrumbs.length - 1].url : '/');
  
  // Breadcrumb JSON-LD (if provided)
  let breadcrumbSchema = '';
  if (breadcrumbs && breadcrumbs.length > 1) {
    breadcrumbSchema = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": breadcrumbs.map((crumb, idx) => ({
        "@type": "ListItem",
        "position": idx + 1,
        "name": crumb.name,
        "item": canonical(crumb.url)
      }))
    })}</script>`;
  }
  
  return `<!doctype html>
<html lang="${TARGET_LANG}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title ? `${escapeHtml(title)} · ` : ''}${escapeHtml(SITE_NAME)}</title>
  <meta name="description" content="Find ${escapeHtml(TARGET_PROFESSION)} jobs and career opportunities at ${escapeHtml(SITE_NAME)}"/>
  <link rel="canonical" href="${canonicalUrl}"/>
  ${faviconHtml}
  <link rel="alternate" type="application/rss+xml" title="RSS Feed" href="${canonical('/feed.xml')}"/>
  
  <!-- Open Graph -->
  <meta property="og:title" content="${escapeHtml(title || SITE_NAME)}"/>
  <meta property="og:description" content="Find ${escapeHtml(TARGET_PROFESSION)} jobs and career opportunities"/>
  <meta property="og:url" content="${canonicalUrl}"/>
  <meta property="og:type" content="website"/>
  ${SITE_LOGO ? `<meta property="og:image" content="${escapeHtml(SITE_LOGO)}"/>` : ''}
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary"/>
  <meta name="twitter:title" content="${escapeHtml(title || SITE_NAME)}"/>
  <meta name="twitter:description" content="Find ${escapeHtml(TARGET_PROFESSION)} jobs"/>
  
  <style>${baseCss}</style>
  ${breadcrumbSchema}
  ${metaExtra}
</head>
<body>
  <header class="wrap">
    <h1><a href="/">${escapeHtml(SITE_NAME)}</a></h1>
    <nav>
      <a href="/post-job" class="btn btn-primary">Post a Job</a>
      <a href="/tags">Tags</a>
      <a href="/feed.xml">RSS</a>
      <a href="/rules">Rules</a>
    </nav>
  </header>
  <main class="wrap">
    ${body}
  </main>
  <footer class="wrap">
    <p class="muted small">© ${new Date().getFullYear()} ${escapeHtml(SITE_NAME)} · ${escapeHtml(TARGET_PROFESSION)} positions</p>
  </footer>
</body>
</html>`;
}

// ========================================
// HTTP SERVER
// ========================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public')); 

// Health check endpoint
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    jobs: getCachedCount(),
    feedRunning: FEED_RUNNING,
    aiEnabled: HAS_OPENAI
  });
});

// HOME PAGE with search form
app.get('/', (req, res) => {
  const pageSize = 50;
  const cursor = req.query.cursor || '';
  
  let rows;
  if (!cursor) {
    rows = stmtPageFirst.all(pageSize);
  } else {
    const [pub, id] = cursor.split('-').map(Number);
    if (!pub || !id) return res.status(400).send('Invalid cursor');
    rows = stmtPageCursor.all(pub, pub, id, pageSize);
  }

  const total = getCachedCount();
  const hasMore = rows.length === pageSize;
  const nextCursor = hasMore ? `${rows[rows.length - 1].published_at}-${rows[rows.length - 1].id}` : null;

  const items = rows.map(r => `
    <li class="card">
      <h2><a href="/job/${r.slug}">${escapeHtml(r.title)}</a></h2>
      ${r.company ? `<div class="muted">${escapeHtml(r.company)}</div>` : ''}
      <p>${escapeHtml(r.description_short)}</p>
      <div class="muted small">${new Date(r.published_at * 1000).toLocaleDateString()}</div>
    </li>`).join('');

  const popular = stmtPopularTags.all(5, 50);
  const tagsBlock = popular.length ? `
    <section>
      <h3>Popular tags</h3>
      <div class="tags">
        ${popular.map(t => `<a class="tag" href="/tag/${t.slug}">${escapeHtml(t.name)} (${t.cnt})</a>`).join('')}
      </div>
    </section>` : '';

  // Pagination with rel attributes
  const pagerLinks = [];
  if (nextCursor) {
    res.setHeader('Link', `<${canonical('/?cursor=' + nextCursor)}>; rel="next"`);
    pagerLinks.push(`<a href="/?cursor=${nextCursor}" rel="next">Next →</a>`);
  }
  if (cursor) {
    pagerLinks.unshift(`<a href="/" rel="prev">← First</a>`);
  }

  const pager = pagerLinks.length ? `<div class="pager">${pagerLinks.join('')}</div>` : '';

  // Organization JSON-LD (only on homepage)
  const orgSchema = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": SITE_NAME,
    "url": SITE_URL,
    ...(SITE_LOGO ? { "logo": SITE_LOGO } : {}),
    ...(SITE_SAMEAS ? { "sameAs": SITE_SAMEAS.split(',').map(s => s.trim()).filter(Boolean) } : {})
  })}</script>`;

  // WebSite JSON-LD with SearchAction
  const websiteSchema = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": SITE_NAME,
    "url": SITE_URL,
    "potentialAction": {
      "@type": "SearchAction",
      "target": {
        "@type": "EntryPoint",
        "urlTemplate": `${SITE_URL}/search?q={search_term_string}`
      },
      "query-input": "required name=search_term_string"
    }
  })}</script>`;

  res.send(layout({
    title: 'Latest Jobs',
    body: `
      <section class="card search-form">
        <form method="GET" action="/search">
          <label for="q">Search jobs</label>
          <input type="search" id="q" name="q" placeholder="Search by title or company..." required/>
          <button type="submit" class="btn" style="margin-top:12px">Search</button>
        </form>
      </section>
      
      <p class="muted">Showing ${escapeHtml(TARGET_PROFESSION)} positions · ${total.toLocaleString()} total jobs</p>
      ${tagsBlock}
      <ul class="list">${items || '<li class="card">No jobs yet. Visit /fetch to import.</li>'}</ul>
      ${pager}`,
    metaExtra: orgSchema + websiteSchema
  }));
});

// SEARCH PAGE
app.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  
  if (!q) {
    return res.redirect('/');
  }

  const searchPattern = `%${q}%`;
  const rows = stmtSearch.all(searchPattern, searchPattern);

  const items = rows.map(r => `
    <li class="card">
      <h2><a href="/job/${r.slug}">${escapeHtml(r.title)}</a></h2>
      ${r.company ? `<div class="muted">${escapeHtml(r.company)}</div>` : ''}
      <p>${escapeHtml(r.description_short)}</p>
      <div class="muted small">${new Date(r.published_at * 1000).toLocaleDateString()}</div>
    </li>`).join('');

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: 'Search', url: `/search?q=${encodeURIComponent(q)}` }
  ];

  res.send(layout({
    title: `Search: ${q}`,
    body: `
      <nav class="muted small"><a href="/">Home</a> › Search</nav>
      <h1>Search: "${escapeHtml(q)}"</h1>
      <p class="muted">${rows.length} results</p>
      <ul class="list">${items || '<li class="card">No results found.</li>'}</ul>
      <p><a href="/">← Back to all jobs</a></p>`,
    breadcrumbs
  }));
});

// POST A JOB (GET - form)
app.get('/post-job', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  
  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: 'Post a Job', url: '/post-job' }
  ];

  res.send(layout({
    title: 'Post a Job',
    body: `
      <nav class="muted small"><a href="/">Home</a> › Post a Job</nav>
      <article class="card">
        <h1>Post a Job</h1>
        <p>Submit your ${escapeHtml(TARGET_PROFESSION)} job posting. All fields marked with * are required.</p>
        
        <form method="POST" action="/post-job">
          <label for="title">Job Title *</label>
          <input type="text" id="title" name="title" required placeholder="e.g. Senior Truck Driver"/>
          
          <label for="company">Company Name *</label>
          <input type="text" id="company" name="company" required placeholder="e.g. ABC Logistics"/>
          
          <label for="url">Application URL *</label>
          <input type="url" id="url" name="url" required placeholder="https://..."/>
          <div class="help-text">Where candidates should apply</div>
          
          <label for="description">Job Description (optional)</label>
          <textarea id="description" name="description" placeholder="If left empty, AI will generate a structured description..."></textarea>
          <div class="help-text">Leave empty for AI-generated content, or provide your own HTML/text</div>
          
          <label for="tags">Tags (optional)</label>
          <input type="text" id="tags" name="tags" placeholder="e.g. remote, full-time, cdl"/>
          <div class="help-text">Comma-separated tags</div>
          
          <div class="form-row">
            <div>
              <label for="employmentType">Employment Type</label>
              <select id="employmentType" name="employmentType">
                <option value="FULL_TIME">Full Time</option>
                <option value="PART_TIME">Part Time</option>
                <option value="CONTRACTOR">Contractor</option>
                <option value="TEMPORARY">Temporary</option>
                <option value="INTERN">Intern</option>
              </select>
            </div>
            
            <div>
              <label for="isRemote">Remote Work</label>
              <select id="isRemote" name="isRemote">
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
          </div>
          
          <h3 style="margin-top:24px">Salary Information (optional)</h3>
          
          <div class="form-row">
            <div>
              <label for="currency">Currency</label>
              <select id="currency" name="currency">
                <option value="">None</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="CHF">CHF</option>
              </select>
            </div>
            
            <div>
              <label for="salaryMin">Minimum</label>
              <input type="number" id="salaryMin" name="salaryMin" placeholder="e.g. 50000"/>
            </div>
            
            <div>
              <label for="salaryMax">Maximum</label>
              <input type="number" id="salaryMax" name="salaryMax" placeholder="e.g. 70000"/>
            </div>
            
            <div>
              <label for="salaryUnit">Per</label>
              <select id="salaryUnit" name="salaryUnit">
                <option value="YEAR">Year</option>
                <option value="MONTH">Month</option>
                <option value="WEEK">Week</option>
                <option value="DAY">Day</option>
                <option value="HOUR">Hour</option>
              </select>
            </div>
          </div>
          
          <button type="submit" class="btn btn-primary">Submit Job</button>
        </form>
      </article>`,
    breadcrumbs
  }));
});

// POST A JOB (POST - submission)
app.post('/post-job', async (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  
  try {
    const {
      title,
      company,
      url,
      description = '',
      tags = '',
      employmentType = 'FULL_TIME',
      isRemote = 'no',
      currency = '',
      salaryMin = '',
      salaryMax = '',
      salaryUnit = 'YEAR'
    } = req.body;

    // Validation
    if (!title || !company || !url) {
      return res.status(400).send('Missing required fields');
    }

    const guid = `manual-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const published_at = Math.floor(Date.now() / 1000);

    // Parse tags
    const userTags = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    
    // If description is empty, always use AI (ignore AI_PROCESS_LIMIT for manual posts)
    // If description provided, use as-is
    let finalHtml, finalShort, finalTags;
    
    if (!description.trim()) {
      // Generate with AI (always for manual posts)
      console.log('🤖 Generating AI content for manual post:', title);
      const result = await rewriteJobRich({
        title,
        company,
        html: `<p>Position at ${company}</p>`
      }, true); // Force AI
      
      finalHtml = result.html;
      finalShort = result.short;
      finalTags = [...new Set([...result.tags, ...userTags])];
    } else {
      // Use provided description
      finalHtml = sanitizeHtml(description);
      finalShort = truncateWords(convert(description, { wordwrap: 120 }), 45);
      finalTags = [...new Set([...extractTags({ title, company, html: description }), ...userTags])];
    }

    // Build salary info string for metadata (optional)
    let salaryInfo = '';
    if (currency && (salaryMin || salaryMax)) {
      salaryInfo = `\n<p><strong>Salary:</strong> ${currency} ${salaryMin ? salaryMin : ''}${salaryMin && salaryMax ? '-' : ''}${salaryMax ? salaryMax : ''} per ${salaryUnit.toLowerCase()}</p>`;
    }

    const enrichedHtml = finalHtml + salaryInfo;

    const slug = mkSlug(`${title}-${company}-${Date.now()}`) || mkSlug(guid);

    // Insert job
    stmtInsertJob.run({
      guid,
      source: 'manual',
      title,
      company,
      description_html: enrichedHtml,
      description_short: finalShort,
      url,
      published_at,
      slug,
      tags_csv: uniqNormTags(finalTags).join(', ')
    });

    const inserted = stmtHasGuid.get(guid);
    if (inserted) {
      upsertTagsForJob(inserted.id, finalTags);
    }

    // Clear cache
    stmtSetCache.run('total_jobs', getCachedCount(0));

    console.log(`✅ Manual job posted: ${title} at ${company}`);

    // Redirect to the new job
    res.redirect(`/job/${slug}`);
  } catch (error) {
    console.error('Error posting job:', error);
    res.status(500).send('Error posting job. Please try again.');
  }
});

// RULES PAGE (with FAQ schema)
app.get('/rules', (req, res) => {
  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: 'Rules', url: '/rules' }
  ];

  // FAQ Schema
  const faqSchema = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "How do I post a job?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": `Click the "Post a Job" button in the header and fill out the form. All ${TARGET_PROFESSION} positions are welcome.`
        }
      },
      {
        "@type": "Question",
        "name": "Is posting jobs free?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Yes, posting jobs is completely free on our platform."
        }
      },
      {
        "@type": "Question",
        "name": "How long do jobs stay posted?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Jobs remain active for 30 days and are included in our sitemap and RSS feed."
        }
      }
    ]
  })}</script>`;

  // Organization schema (also on rules page)
  const orgSchema = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": SITE_NAME,
    "url": SITE_URL,
    ...(SITE_LOGO ? { "logo": SITE_LOGO } : {}),
    ...(SITE_SAMEAS ? { "sameAs": SITE_SAMEAS.split(',').map(s => s.trim()).filter(Boolean) } : {})
  })}</script>`;

  res.send(layout({
    title: 'Rules & FAQ',
    body: `
      <nav class="muted small"><a href="/">Home</a> › Rules</nav>
      <article class="card">
        <h1>Rules & FAQ</h1>
        
        <h2>Posting Guidelines</h2>
        <ul>
          <li>Only ${escapeHtml(TARGET_PROFESSION)} positions should be posted</li>
          <li>All job postings must be legitimate opportunities</li>
          <li>Provide accurate company information and application URLs</li>
          <li>No discriminatory content or requirements</li>
        </ul>
        
        <h2>Frequently Asked Questions</h2>
        
        <h3>How do I post a job?</h3>
        <p>Click the "Post a Job" button in the header and fill out the form. All ${escapeHtml(TARGET_PROFESSION)} positions are welcome.</p>
        
        <h3>Is posting jobs free?</h3>
        <p>Yes, posting jobs is completely free on our platform.</p>
        
        <h3>How long do jobs stay posted?</h3>
        <p>Jobs remain active for 30 days and are included in our sitemap and RSS feed.</p>
        
        <h3>Can I edit or remove my job posting?</h3>
        <p>Please contact us if you need to modify or remove a posting.</p>
        
        <h3>How are jobs processed?</h3>
        <p>We use AI to structure and enhance job descriptions for better readability. If you provide your own description, we'll use it as-is.</p>
      </article>`,
    breadcrumbs,
    metaExtra: faqSchema + orgSchema
  }));
});

// TAG PAGE with cursor pagination
app.get('/tag/:slug', (req, res) => {
  const slug = req.params.slug;
  const tag = stmtGetTagBySlug.get(slug);
  if (!tag) return res.status(404).send('Not found');

  const pageSize = 50;
  const cursor = req.query.cursor || '';

  let rows;
  if (!cursor) {
    rows = stmtJobsByTagFirst.all(slug, pageSize);
  } else {
    const [pub, id] = cursor.split('-').map(Number);
    if (!pub || !id) return res.status(400).send('Invalid cursor');
    rows = stmtJobsByTagCursor.all(slug, pub, pub, id, pageSize);
  }

  const cnt = stmtCountJobsByTagId.get(tag.id).c;
  const hasMore = rows.length === pageSize;
  const nextCursor = hasMore ? `${rows[rows.length - 1].published_at}-${rows[rows.length - 1].id}` : null;

  const items = rows.map(r => `
    <li class="card">
      <h2><a href="/job/${r.slug}">${escapeHtml(r.title)}</a></h2>
      ${r.company ? `<div class="muted">${escapeHtml(r.company)}</div>` : ''}
      <p>${escapeHtml(r.description_short)}</p>
      <div class="muted small">${new Date(r.published_at * 1000).toLocaleDateString()}</div>
    </li>`).join('');

  // Pagination links
  const pagerLinks = [];
  if (nextCursor) {
    res.setHeader('Link', `<${canonical(`/tag/${slug}?cursor=${nextCursor}`)}>; rel="next"`);
    pagerLinks.push(`<a href="/tag/${slug}?cursor=${nextCursor}" rel="next">Next →</a>`);
  }
  if (cursor) {
    pagerLinks.unshift(`<a href="/tag/${slug}" rel="prev">← First</a>`);
  }

  const pager = pagerLinks.length ? `<div class="pager">${pagerLinks.join('')}</div>` : '';

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: 'Tags', url: '/tags' },
    { name: tag.name, url: `/tag/${slug}` }
  ];

  res.send(layout({
    title: `Tag: ${tag.name}`,
    body: `
      <nav class="muted small"><a href="/">Home</a> › <a href="/tags">Tags</a> › ${escapeHtml(tag.name)}</nav>
      <h1>Tag: ${escapeHtml(tag.name)}</h1>
      <p class="muted">${cnt} jobs</p>
      <ul class="list">${items || '<li class="card">No jobs yet.</li>'}</ul>
      ${pager}`,
    breadcrumbs
  }));
});

// ALL TAGS
app.get('/tags', (req, res) => {
  const popular = stmtPopularTags.all(1, 500);
  
  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: 'Tags', url: '/tags' }
  ];

  const body = popular.length ? `
    <nav class="muted small"><a href="/">Home</a> › Tags</nav>
    <h1>All tags</h1>
    <div class="tags">
      ${popular.map(t => `<a class="tag" href="/tag/${t.slug}">${escapeHtml(t.name)} (${t.cnt})</a>`).join('')}
    </div>` : `
    <nav class="muted small"><a href="/">Home</a> › Tags</nav>
    <h1>Tags</h1>
    <p class="muted">No tags yet.</p>`;

  res.send(layout({ title: 'Tags', body, breadcrumbs }));
});

// JOB PAGE (with enhanced metadata and structured data)
app.get('/job/:slug', (req, res) => {
  const job = stmtBySlug.get(req.params.slug);
  if (!job) return res.status(404).send('Not found');

  const token = crypto.createHmac('sha256', CLICK_SECRET).update(String(job.id)).digest('hex').slice(0, 16);

  const tags = (job.tags_csv || '').split(',').map(s => s.trim()).filter(Boolean);
  const tagsHtml = tags.length ? `
    <div class="tags">
      ${tags.map(name => `<a class="tag" href="/tag/${tagSlug(name)}">${escapeHtml(name)}</a>`).join('')}
    </div>` : '';

  const meta = parseMeta(job.description_html || '', job.title || '');
  const datePostedISO = new Date(job.published_at * 1000).toISOString();
  const validThrough = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  // JobPosting JSON-LD
  const jobPostingJson = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": job.title,
    "description": job.description_html,
    "datePosted": datePostedISO,
    "validThrough": validThrough,
    "employmentType": meta.employmentType,
    "hiringOrganization": {
      "@type": "Organization",
      "name": job.company || "Unknown"
    },
    ...(meta.isRemote ? { "jobLocationType": "TELECOMMUTE" } : {}),
    ...(meta.salary ? {
      "baseSalary": {
        "@type": "MonetaryAmount",
        "currency": meta.salary.currency,
        "value": {
          "@type": "QuantitativeValue",
          ...(meta.salary.min ? { "minValue": meta.salary.min } : {}),
          ...(meta.salary.max ? { "maxValue": meta.salary.max } : {})
        }
      }
    } : {})
  };

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: job.title, url: `/job/${job.slug}` }
  ];

  const metaExtra = `
    <script type="application/ld+json">${JSON.stringify(jobPostingJson)}</script>
    <meta name="robots" content="index, follow"/>
  `;

  const body = `
  <nav class="muted small"><a href="/">Home</a> › ${escapeHtml(job.title)}</nav>
  <article class="card">
    <h1>${escapeHtml(job.title)}</h1>
    ${job.company ? `<div class="muted">${escapeHtml(job.company)}</div>` : ''}
    <div class="muted small">${new Date(job.published_at * 1000).toLocaleDateString()}</div>
    ${tagsHtml}
    <div class="content">${job.description_html || ''}</div>
    <form method="POST" action="/go" style="margin-top:24px">
      <input type="hidden" name="id" value="${job.id}"/>
      <input type="hidden" name="t" value="${token}"/>
      <button class="btn btn-primary" type="submit">Apply Now / View Source</button>
    </form>
  </article>`;

  res.send(layout({ title: job.title, body, metaExtra, breadcrumbs }));
});

// /go - redirect to source (with security token)
app.post('/go', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const id = Number(req.body?.id || 0);
  const t = String(req.body?.t || '');
  if (!id || !t) return res.status(400).send('Bad request');

  const expect = crypto.createHmac('sha256', CLICK_SECRET).update(String(id)).digest('hex').slice(0, 16);
  if (t !== expect) return res.status(403).send('Forbidden');

  const job = stmtById.get(id);
  if (!job || !job.url) return res.status(404).send('Not found');
  return res.redirect(302, job.url);
});

app.get('/go', (_req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(405).send('Method Not Allowed');
});

// robots.txt (updated)
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *
Disallow: /go
Disallow: /post-job
Disallow: /fetch
Sitemap: ${SITE_URL}/sitemap.xml
`);
});

// sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  const recent = stmtRecent.all(10000);
  const urls = recent.map(r => `
    <url>
      <loc>${canonical(`/job/${r.slug}`)}</loc>
      <lastmod>${new Date(r.published_at * 1000).toISOString()}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.8</priority>
    </url>`).join('');
  
  res.set('Content-Type', 'application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_URL}/tags</loc>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>
  ${urls}
</urlset>`);
});

// RSS feed
app.get('/feed.xml', (req, res) => {
  const recent = stmtRecent.all(100);
  const items = recent.map(r => `
    <item>
      <title><![CDATA[${r.title}]]></title>
      <link>${canonical(`/job/${r.slug}`)}</link>
      <guid>${canonical(`/job/${r.slug}`)}</guid>
      <pubDate>${new Date(r.published_at * 1000).toUTCString()}</pubDate>
    </item>`).join('');
  
  res.set('Content-Type', 'application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(SITE_NAME)}</title>
    <link>${SITE_URL}</link>
    <description>Latest ${escapeHtml(TARGET_PROFESSION.toLowerCase())} job opportunities</description>
    <language>${TARGET_LANG}</language>
    <atom:link href="${canonical('/feed.xml')}" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`);
});

// Manual feed fetch (for testing/admin)
app.get('/fetch', async (_req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.write('Processing feed...\n\n');
  try {
    await processFeed();
    res.end('✅ Done! Check console for details.\n');
  } catch (e) {
    res.end(`❌ Error: ${e.message}\n`);
  }
});

// ========================================
// STARTUP
// ========================================
// Initial fetch on boot (non-blocking)
if (FEED_URL) {
  processFeed().catch(console.error);
}

// Cron job
if (FEED_URL && CRON_SCHEDULE) {
  cron.schedule(CRON_SCHEDULE, () => {
    console.log(`\n⏰ CRON: Starting scheduled feed processing...`);
    processFeed().catch(console.error);
  });
}

// Start server
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 ${SITE_NAME}`);
  console.log('='.repeat(60));
  console.log(`📍 Server:       ${SITE_URL}`);
  console.log(`👔 Profession:   ${TARGET_PROFESSION}`);
  console.log(`🔑 Keywords:     ${PROFESSION_KEYWORDS.join(', ')}`);
  console.log(`🤖 AI Enabled:   ${HAS_OPENAI ? 'Yes' : 'No'}`);
  console.log(`📊 AI Limit:     ${AI_PROCESS_LIMIT === 0 ? 'Unlimited' : `${AI_PROCESS_LIMIT} jobs per feed`}`);
  console.log(`📡 Feed URL:     ${FEED_URL || 'Not configured'}`);
  console.log(`⏰ Cron:         ${CRON_SCHEDULE}`);
  console.log(`🎨 Favicon:      ${FAVICON_URL || 'None'}`);
  console.log(`📈 Total Jobs:   ${getCachedCount().toLocaleString()}`);
  console.log('='.repeat(60) + '\n');
});

