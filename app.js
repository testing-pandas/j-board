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
// UMGEBUNGSVARIABLEN
// ========================================
const PORT = Number(process.env.PORT || 3000);
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/+$/,'');
const SITE_NAME = process.env.SITE_NAME || 'LKW Fahrer Jobs Deutschland';
const FAVICON_URL = process.env.FAVICON_URL || '';
const SITE_LOGO = process.env.SITE_LOGO || '';
const SITE_SAMEAS = process.env.SITE_SAMEAS || ''; // Kommagetrennte Social-URLs
const TARGET_LANG = process.env.TARGET_LANG || 'de';
const FEED_URL = process.env.FEED_URL || '';
const MAX_JOBS = Number(process.env.MAX_JOBS || 50000);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 */6 * * *';
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const CLICK_SECRET = process.env.CLICK_SECRET || crypto.randomBytes(16).toString('hex');
const TARGET_PROFESSION = process.env.TARGET_PROFESSION || 'lkw-fahrer';
const AI_PROCESS_LIMIT = Number(process.env.AI_PROCESS_LIMIT || 0); // 0 = unbegrenzt

// Such-Keywords (kleinbuchstaben)
const PROFESSION_KEYWORDS = (process.env.PROFESSION_KEYWORDS || 'lkw-fahrer,lkw fahrer,berufskraftfahrer,fernfahrer,lastwagenfahrer,sattelzugfahrer,ce-fahrer')
  .toLowerCase()
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ========================================
// DATENBANK
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

// Cursor-Pagination
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

// Suche
const stmtSearch = db.prepare(`
  SELECT id, title, company, description_short, slug, published_at
  FROM jobs
  WHERE title LIKE ? OR company LIKE ?
  ORDER BY published_at DESC, id DESC
  LIMIT 100
`);

// Tags
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

// Cache
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
// HELFER
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

// Leichtes Sanitizing
function sanitizeHtml(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<\/?(?:iframe|object|embed|link|style|noscript)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s(href|src)\s*=\s*["']\s*javascript:[^"']*["']/gi, '')
    .replace(/\s(href|src)\s*=\s*javascript:[^\s>]+/gi, '');
}

function stripDocumentTags(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<\/?head[^>]*>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/<title[^>]*>.*?<\/title>/gi, '')
    .trim();
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function canonical(path = '') {
  const p = String(path || '');
  if (/^https?:\/\//i.test(p)) return p;
  return `${SITE_URL}${p.startsWith('/') ? '' : '/'}${p}`;
}

// Profession-Match
function matchesProfession(title = '', company = '', description = '') {
  const text = `${title} ${company} ${description}`.toLowerCase();
  return PROFESSION_KEYWORDS.some(keyword => text.includes(keyword));
}

// Tag-Extraktion
const PROFESSION_TAGS = {
  'lkw-fahrer': [
    'führerschein ce','führerschein c','führerschein c1','führerschein c1e','klasse ce','klasse c',
    'berufskraftfahrerqualifikation','bkf','beschleunigte grundqualifikation','adr-schein','adr',
    'gefahrgut','gabelstaplerschein','ladungssicherung','digitaler tachograph',
    'sattelzug','sattelschlepper','solo','gliederzug','kipper','pritsche','plane',
    'kühlfahrzeug','tiefkühler','tankwagen','silo','wechselbrücke','container',
    'fernverkehr','fernfahrer','nahverkehr','regional','national','international',
    'werksverkehr','baustellenverkehr','distribution','spedition',
    '40-tonner','7.5-tonner','12-tonner','schwerlast','überbreite','überlänge',
    'nachtfahrten','wochenendarbeit','schichtarbeit','tourplanung'
  ],
  'truck driver': ['class 1','class a','cdl','long haul','regional','local','tanker','flatbed','otr','hazmat'],
  'software engineer': ['javascript','python','java','react','node','backend','frontend','full stack','devops'],
  'nurse': ['rn','lpn','icu','emergency','pediatric','surgical','critical care','oncology'],
  'electrician': ['commercial','residential','industrial','apprentice','journeyman','master electrician'],
  'mechanic': ['automotive','diesel','heavy equipment','marine','aircraft','ase certified'],
  'welder': ['mig','tig','stick','flux core','pipe welding','structural','stainless steel'],
  'warehouse': ['forklift','reach truck','picker','packer','shipping','receiving','inventory'],
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
      : (c === 'CHF') ? 'CHF' : null;
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

// KI-Umtextung / Fallback
async function rewriteJobRich({ title, company, html }, useAI = false) {
  const plain = convert(html || '', {
    wordwrap: 120,
    selectors: [{ selector: 'a', options: { ignoreHref: true } }]
  }).slice(0, 9000);

  const fallback = () => {
    const paragraphs = plain.split(/\n+/).filter(Boolean).slice(0, 6).map(p => `<p>${escapeHtml(p)}</p>`).join('\n');
    const fallbackHTML = `
<section><h2>Über die Stelle</h2>${paragraphs || '<p>Details vom Arbeitgeber bereitgestellt.</p>'}</section>
<section><h2>Aufgaben</h2><ul><li>Kernaufgaben wie beschrieben durchführen.</li></ul></section>
<section><h2>Anforderungen</h2><ul><li>Relevante Erfahrung oder Lernbereitschaft.</li></ul></section>
<section><h2>Vorteile</h2><ul><li>Leistungen gemäß Stellenbeschreibung.</li></ul></section>
<section><h2>Vergütung</h2><p>Wird im Gespräch besprochen.</p></section>
<section><h2>Standort & Arbeitszeit</h2><p>Details gemäß Stellenbeschreibung.</p></section>
<section><h2>Wie bewerben</h2><p>Nutzen Sie die Schaltfläche „Jetzt bewerben“.</p></section>`.trim();

    return {
      short: truncateWords(plain, 45),
      html: sanitizeHtml(fallbackHTML),
      tags: extractTags({ title, company, html }),
      usedAI: false
    };
  };

  if (!HAS_OPENAI || !useAI || !openai) {
    return fallback();
  }

  const system = `
You are a senior job-content editor for ${TARGET_PROFESSION} roles. Write naturally in ${TARGET_LANG}.

OUTPUT CONTRACT — return EXACTLY these three blocks in this order:
===DESCRIPTION===
[35–60 words of plain text. No HTML, quotes, emojis.]
===HTML===
[Only clean HTML fragments; NEVER include <!DOCTYPE>, <html>, <head>, or <body>.]
===TAGS===
[Valid JSON array (3–8 items), all lowercase, in ${TARGET_LANG}, relevant to ${TARGET_PROFESSION}.]

HTML SECTIONS (localize headers into ${TARGET_LANG}; keep this order):
1) About the Role
2) Responsibilities
3) Requirements
4) Benefits
5) Compensation
6) Location & Schedule
7) How to Apply

HTML RULES:
- Use semantic, minimal, valid markup: <section>, <h2>, <p>, <ul>, <li>, <strong>, <em>, <time>, <address>.
- Wrap each logical block in <section> with the localized <h2> headers above (order fixed).
- Lists must be scannable: 5–8 bullets per list, 4–12 words per bullet.
- No inline styles, no scripts, no images, no tables.
- No external links unless an explicit application link is present in the user message; otherwise omit links entirely.
- Use metric units and locale-appropriate number/date formats for ${TARGET_LANG}.

CONTENT GUIDELINES:
- DESCRIPTION: 35–60 words, active voice, concrete value proposition, zero fluff.
- Responsibilities & Requirements: prioritize concrete outcomes, tools, and must-haves; avoid clichés.
- Benefits: list only realistic, generally applicable perks.
- Compensation: show a clear range when present; else “To be discussed”.
- Location & Schedule: reflect known facts; else generic.
- How to Apply: single plain sentence without a link unless one is explicitly provided.

STRICT VALIDATION BEFORE RETURN:
- DESCRIPTION length is 35–60 words and contains no HTML.
- HTML contains exactly seven <section> blocks with localized <h2> headers in the exact order listed; no empty sections.
- No full HTML documents; only fragments.
- TAGS is valid JSON, 3–8 lowercase items in ${TARGET_LANG}, all relevant to ${TARGET_PROFESSION}.
- Do not hallucinate employer-specific facts or links not provided by the user.
`;

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

    const descMatch = out.match(/===DESCRIPTION===\s*([\s\S]*?)\s*===HTML===/i);
    const htmlMatch = out.match(/===HTML===\s*([\s\S]*?)\s*===TAGS===/i);
    const tagsMatch = out.match(/===TAGS===\s*([\s\S]*)$/i);

    let short = (descMatch?.[1] || '').trim();
    if (!short) short = convert(out, { wordwrap: 120 }).slice(0, 300);
    short = convert(short, { wordwrap: 120 }).trim().slice(0, 600);

    let htmlOut = (htmlMatch?.[1] || '').trim();
    if (!htmlOut) {
      htmlOut = `<section><h2>Über die Stelle</h2><p>${escapeHtml(short)}</p></section>`;
    }
    htmlOut = stripDocumentTags(htmlOut);
    if (htmlOut.length < 50) {
      htmlOut = `<section><h2>Über die Stelle</h2><p>${escapeHtml(short)}</p></section>`;
    }

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
// FEED-VERARBEITUNG
// ========================================
let FEED_RUNNING = false;

export async function processFeed() {
  if (FEED_RUNNING) {
    console.log('Feed-Verarbeitung läuft bereits, übersprungen…');
    return;
  }
  if (!FEED_URL) {
    console.log('Keine FEED_URL konfiguriert');
    return;
  }

  FEED_RUNNING = true;

  try {
    console.log(`\nHole XML-Feed: ${FEED_URL}`);
    console.log(`Filter Profession: ${TARGET_PROFESSION}`);
    console.log(`Keywords: ${PROFESSION_KEYWORDS.join(', ')}`);
    console.log(`KI-Verarbeitung: ${AI_PROCESS_LIMIT === 0 ? 'Unbegrenzt' : `Erste ${AI_PROCESS_LIMIT} Jobs`}`);
    console.log('Starte Streaming-XML-Parser…\n');

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

    const parser = sax.createStream(true, { trim: true, normalize: true });

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

    parser.on('text', (text) => { currentText += text; });
    parser.on('cdata', (text) => { currentText += text; });

    parser.on('closetag', (tagName) => {
      tagName = tagName.toLowerCase();
      if (!currentItem) return;

      switch (tagName) {
        case 'title': currentItem.title = currentText.trim(); break;
        case 'description': currentItem.description = currentText.trim(); break;
        case 'company': currentItem.company = currentText.trim(); break;
        case 'url':
        case 'link': currentItem.link = currentText.trim(); break;
        case 'guid':
        case 'referencenumber':
          if (!currentItem.guid) currentItem.guid = currentText.trim();
          break;
        case 'pubdate':
        case 'date_updated': currentItem.pubDate = currentText.trim(); break;
      }

      if (tagName === 'job' || tagName === 'item') {
        processed++;
        if (processed % 10000 === 0) {
          console.log(`Verarbeitet: ${processed.toLocaleString()} (Match: ${matched.toLocaleString()}, Skip: ${skipped.toLocaleString()})`);
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
      console.error('SAX Parser Fehler:', err.message);
    });

    await new Promise((resolve, reject) => {
      stream.pipe(parser);
      parser.on('end', async () => {
        if (batch.length > 0) {
          console.log(`\nVerarbeite ${batch.length} gematchte Jobs…`);
          const processedBatch = [];
          for (let i = 0; i < batch.length; i++) {
            const rawJob = batch[i];

            const shouldUseAI = (AI_PROCESS_LIMIT === 0) || (aiEnhanced < AI_PROCESS_LIMIT);

            const { short, html, tags, usedAI } = await rewriteJobRich({
              title: rawJob.rawTitle,
              company: rawJob.rawCompany,
              html: rawJob.rawDescription
            }, shouldUseAI);

            if (usedAI) {
              aiEnhanced++;
              if (aiEnhanced % 10 === 0) console.log(`KI-veredelt: ${aiEnhanced} Jobs…`);
            } else {
              fallbackUsed++;
            }

            const slug = mkSlug(`${rawJob.rawTitle}-${rawJob.rawCompany}`) || mkSlug(rawJob.rawTitle) || mkSlug(rawJob.guid);

            processedBatch.push({
              guid: rawJob.guid,
              source: rawJob.source,
              title: rawJob.rawTitle || 'Ohne Titel',
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

    console.log(`\nFeed fertig!`);
    console.log(`Gesamt verarbeitet: ${processed.toLocaleString()}`);
    console.log(`Gematcht (Profession): ${matched.toLocaleString()}`);
    console.log(`KI-veredelt: ${aiEnhanced.toLocaleString()}`);
    console.log(`Schneller Fallback: ${fallbackUsed.toLocaleString()}`);
    console.log(`Übersprungen: ${skipped.toLocaleString()} (Duplikate/kein Match)\n`);

    const total = getCachedCount(0);
    if (total > MAX_JOBS) {
      console.log(`Aufräumen: nur die neuesten ${MAX_JOBS.toLocaleString()} Jobs behalten`);
      stmtDeleteOld.run(MAX_JOBS);
      stmtSetCache.run('total_jobs', MAX_JOBS);
    }
  } catch (error) {
    console.error('Feed-Fehler:', error.message);
    throw error;
  } finally {
    FEED_RUNNING = false;
  }
}

// ========================================
// CSS (modern, blau) + Cookie-Banner
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
.wrap { max-width: 1000px; margin: 0 auto; padding: 20px; }
header.wrap {
  display: flex; justify-content: space-between; align-items: center;
  padding-top: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--border);
  background: var(--card); flex-wrap: wrap; gap: 16px;
}
header h1 { margin: 0; font-size: 24px; }
header h1 a { color: var(--text); text-decoration: none; font-weight: 700; }
nav { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
nav a {
  color: var(--text-muted); text-decoration: none; padding: 8px 12px; border-radius: 6px; transition: all 0.2s;
}
nav a:hover { color: var(--primary); background: var(--bg); }
.btn {
  display: inline-block; padding: 10px 18px; background: var(--text); color: white; border-radius: 8px;
  border: none; cursor: pointer; font-size: 14px; font-weight: 500; text-decoration: none; transition: all 0.2s;
}
.btn:hover { background: var(--text-muted); transform: translateY(-1px); }
.btn-primary { background: var(--primary); color: white; font-weight: 600; }
.btn-primary:hover { background: var(--primary-dark); }
.card {
  background: var(--card); border-radius: 12px; padding: 24px; margin: 16px 0; box-shadow: var(--shadow);
  border: 1px solid var(--border); transition: all 0.2s;
}
.card:hover { box-shadow: var(--shadow-lg); border-color: var(--primary); }
.list { list-style: none; padding: 0; margin: 0; }
.muted { color: var(--text-muted); }
.small { font-size: 14px; }
.search-form { margin: 24px 0; }
.search-form input[type="search"] {
  width: 100%; max-width: 500px; padding: 12px 16px; border: 2px solid var(--border); border-radius: 8px; font-size: 16px; transition: all 0.2s;
}
.search-form input[type="search"]:focus {
  outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
}
.pager { display: flex; gap: 12px; margin: 24px 0; flex-wrap: wrap; }
.pager a, .pager .current {
  padding: 8px 16px; background: var(--card); border-radius: 8px; color: var(--text); text-decoration: none;
  box-shadow: var(--shadow); border: 1px solid var(--border); transition: all 0.2s;
}
.pager a:hover { background: var(--primary); color: white; border-color: var(--primary); }
.pager .disabled { opacity: 0.5; pointer-events: none; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.tag {
  background: #eff6ff; color: var(--primary); border-radius: 999px; padding: 6px 14px; font-size: 13px;
  text-decoration: none; transition: all 0.2s; border: 1px solid #dbeafe;
}
.tag:hover { background: var(--primary); color: white; border-color: var(--primary); }
.content h2 { color: var(--text); margin-top: 24px; font-size: 20px; }
.content p, .content ul, .content ol { line-height: 1.7; margin: 12px 0; }
.content ul, .content ol { padding-left: 24px; }
form label { display: block; margin-top: 16px; margin-bottom: 6px; font-weight: 500; color: var(--text); }
form input[type="text"], form input[type="url"], form input[type="number"], form select, form textarea {
  width: 100%; padding: 10px 14px; border: 2px solid var(--border); border-radius: 8px; font-size: 15px; font-family: inherit; transition: all 0.2s;
}
form input:focus, form select:focus, form textarea:focus {
  outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
}
form textarea { min-height: 150px; resize: vertical; }
form button[type="submit"] { margin-top: 20px; }
.form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
.help-text { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
footer { margin-top: 60px; padding-top: 24px; border-top: 1px solid var(--border); }
/* Cookie-Banner */
.cookie-banner {
  position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 9999; background: var(--card); color: var(--text);
  border: 1px solid var(--border); box-shadow: var(--shadow-lg); border-radius: 12px; padding: 16px; display: none;
}
.cookie-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.cookie-link { color: var(--primary); text-decoration: none; }
.cookie-link:hover { text-decoration: underline; }
@media (max-width: 768px) {
  header.wrap { flex-direction: column; align-items: flex-start; }
  nav { width: 100%; justify-content: flex-start; }
  .form-row { grid-template-columns: 1fr; }
}
`;

// ========================================
// HTML-GRUNDLAYOUT
// ========================================
function layout({ title, body, metaExtra = '', breadcrumbs = null }) {
  const faviconHtml = FAVICON_URL ? `<link rel="icon" href="${escapeHtml(FAVICON_URL)}"/>` : '';
  const canonicalUrl = canonical(breadcrumbs ? breadcrumbs[breadcrumbs.length - 1].url : '/');

  // Breadcrumb JSON-LD
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

  // Cookie-Banner (de)
  const cookieBanner = `
<div id="cookie-banner" class="cookie-banner" role="dialog" aria-live="polite" aria-label="Cookie-Einwilligung">
  <div>
    <strong>Wir verwenden Cookies</strong>
    <p class="small muted" style="margin:6px 0 0 0;">
      Wir setzen essenzielle Cookies ein, um ${escapeHtml(SITE_NAME)} zu betreiben und Ihr Nutzungserlebnis zu verbessern.
      Mehr dazu in unserer <a class="cookie-link" href="/cookies">Cookie-Richtlinie</a> und <a class="cookie-link" href="/privacy">Datenschutzerklärung</a>.
    </p>
    <div class="cookie-actions">
      <button id="cookie-accept" class="btn btn-primary">Alle akzeptieren</button>
      <a class="cookie-link" href="/cookies">Einstellungen verwalten</a>
    </div>
  </div>
</div>
<script>
(function(){
  function getCookie(name){
    return document.cookie.split('; ').find(row => row.startsWith(name + '='))?.split('=')[1];
  }
  function showBanner(){
    var el = document.getElementById('cookie-banner');
    if (el) el.style.display = 'block';
  }
  function hideBanner(){
    var el = document.getElementById('cookie-banner');
    if (el) el.style.display = 'none';
  }
  if (!getCookie('cookie_consent')){
    window.addEventListener('load', showBanner);
  }
  var btn = document.getElementById('cookie-accept');
  if (btn){
    btn.addEventListener('click', function(){
      var oneYear = 365*24*60*60;
      document.cookie = 'cookie_consent=1; Max-Age=' + oneYear + '; Path=/; SameSite=Lax';
      hideBanner();
    });
  }
})();
</script>`;

  return `<!doctype html>
<html lang="${TARGET_LANG}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title ? `${escapeHtml(title)} · ` : ''}${escapeHtml(SITE_NAME)}</title>
  <meta name="description" content="Finden Sie ${escapeHtml(TARGET_PROFESSION)}-Stellen und Karrierechancen bei ${escapeHtml(SITE_NAME)}"/>
  <link rel="canonical" href="${canonicalUrl}"/>
  ${faviconHtml}
  <link rel="alternate" type="application/rss+xml" title="RSS Feed" href="${canonical('/feed.xml')}"/>

  <!-- Open Graph -->
  <meta property="og:title" content="${escapeHtml(title || SITE_NAME)}"/>
  <meta property="og:description" content="${escapeHtml(TARGET_PROFESSION)}-Jobs und Chancen"/>
  <meta property="og:url" content="${canonicalUrl}"/>
  <meta property="og:type" content="website"/>
  ${SITE_LOGO ? `<meta property="og:image" content="${escapeHtml(SITE_LOGO)}"/>` : ''}

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary"/>
  <meta name="twitter:title" content="${escapeHtml(title || SITE_NAME)}"/>
  <meta name="twitter:description" content="${escapeHtml(TARGET_PROFESSION)}-Jobs"/>

  <style>${baseCss}</style>
  ${breadcrumbSchema}
  ${metaExtra}
</head>
<body>
  <header class="wrap">
    <h1><a href="/">${escapeHtml(SITE_NAME)}</a></h1>
    <nav>
      <a href="/post-job" class="btn btn-primary">Job veröffentlichen</a>
      <a href="/tags">Tags</a>
      <a href="/feed.xml">RSS</a>
      <a href="/rules">Regeln</a>
      <a href="/privacy">Datenschutz</a>
      <a href="/terms">Nutzungsbedingungen</a>
    </nav>
  </header>
  <main class="wrap">
    ${body}
  </main>
  <footer class="wrap">
    <p class="muted small">© ${new Date().getFullYear()} ${escapeHtml(SITE_NAME)} · ${escapeHtml(TARGET_PROFESSION)}-Stellen · 
      <a href="/privacy">Datenschutz</a> · <a href="/terms">Nutzungsbedingungen</a> · <a href="/cookies">Cookies</a>
    </p>
  </footer>
  ${cookieBanner}
</body>
</html>`;
}

// ========================================
// HTTP-SERVER
// ========================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

// Healthcheck
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    jobs: getCachedCount(),
    feedRunning: FEED_RUNNING,
    aiEnabled: HAS_OPENAI
  });
});

// STARTSEITE
app.get('/', (req, res) => {
  const pageSize = 50;
  const cursor = req.query.cursor || '';
  
  let rows;
  if (!cursor) {
    rows = stmtPageFirst.all(pageSize);
  } else {
    const [pub, id] = cursor.split('-').map(Number);
    if (!pub || !id) return res.status(400).send('Ungültiger Cursor');
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
      <div class="muted small">${new Date(r.published_at * 1000).toLocaleDateString('de-DE')}</div>
    </li>`).join('');

  const popular = stmtPopularTags.all(5, 50);
  const tagsBlock = popular.length ? `
    <section>
      <h3>Beliebte Tags</h3>
      <div class="tags">
        ${popular.map(t => `<a class="tag" href="/tag/${t.slug}">${escapeHtml(t.name)} (${t.cnt})</a>`).join('')}
      </div>
    </section>` : '';

  const pagerLinks = [];
  if (nextCursor) {
    res.setHeader('Link', `<${canonical('/?cursor=' + nextCursor)}>; rel="next"`);
    pagerLinks.push(`<a href="/?cursor=${nextCursor}" rel="next">Weiter →</a>`);
  }
  if (cursor) {
    pagerLinks.unshift(`<a href="/" rel="prev">← Erste Seite</a>`);
  }
  const pager = pagerLinks.length ? `<div class="pager">${pagerLinks.join('')}</div>` : '';

  // Organization JSON-LD (nur Startseite)
  const orgSchema = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": SITE_NAME,
    "url": SITE_URL,
    ...(SITE_LOGO ? { "logo": SITE_LOGO } : {}),
    ...(SITE_SAMEAS ? { "sameAs": SITE_SAMEAS.split(',').map(s => s.trim()).filter(Boolean) } : {})
  })}</script>`;

  // WebSite JSON-LD + SearchAction
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
    title: 'Aktuelle Jobs',
    body: `
<section class="card search-form">
  <form method="GET" action="/search">
    <label for="q">Jobs suchen</label>
    <input type="search" id="q" name="q" placeholder="Nach Titel oder Unternehmen suchen…" required/>
    <button type="submit" class="btn" style="margin-top:12px">Suchen</button>
  </form>
</section>

<p class="muted">Angezeigt werden Stellen für ${escapeHtml(TARGET_PROFESSION)} · insgesamt ${total.toLocaleString('de-DE')} Jobs</p>
${tagsBlock}
<ul class="list">${items || '<li class="card">Noch keine Jobs. Rufe /fetch zum Import auf.</li>'}</ul>
${pager}`,
    metaExtra: orgSchema + websiteSchema
  }));
});

// SUCHE  — NOINDEX/FOLLOW-BLOCKED
app.get('/search', (req, res) => {
  // Prevent indexing of search result pages (best practice)
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const q = String(req.query.q || '').trim();
  if (!q) return res.redirect('/');

  const searchPattern = `%${q}%`;
  const rows = stmtSearch.all(searchPattern, searchPattern);

  const items = rows.map(r => `
    <li class="card">
      <h2><a href="/job/${r.slug}">${escapeHtml(r.title)}</a></h2>
      ${r.company ? `<div class="muted">${escapeHtml(r.company)}</div>` : ''}
      <p>${escapeHtml(r.description_short)}</p>
      <div class="muted small">${new Date(r.published_at * 1000).toLocaleDateString('de-DE')}</div>
    </li>`).join('');

  const breadcrumbs = [
    { name: 'Start', url: '/' },
    { name: 'Suche', url: `/search?q=${encodeURIComponent(q)}` }
  ];

  res.send(layout({
    title: `Suche: ${q}`,
    body: `
      <nav class="muted small"><a href="/">Start</a> › Suche</nav>
      <h1>Suche: „${escapeHtml(q)}“</h1>
      <p class="muted">${rows.length} Ergebnisse</p>
      <ul class="list">${items || '<li class="card">Keine Treffer gefunden.</li>'}</ul>
      <p><a href="/">← Zurück zu allen Jobs</a></p>`,
    breadcrumbs,
    // Redundant meta tag for crawlers that don’t honor X-Robots-Tag
    metaExtra: `<meta name="robots" content="noindex, nofollow"/>`
  }));
});

// JOB VERÖFFENTLICHEN (GET)
app.get('/post-job', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const breadcrumbs = [
    { name: 'Start', url: '/' },
    { name: 'Job veröffentlichen', url: '/post-job' }
  ];

  res.send(layout({
    title: 'Job veröffentlichen',
    body: `
      <nav class="muted small"><a href="/">Start</a> › Job veröffentlichen</nav>
      <article class="card">
        <h1>Job veröffentlichen</h1>
        <p>Stellenanzeige für ${escapeHtml(TARGET_PROFESSION)} übermitteln. Mit * markierte Felder sind Pflichtfelder.</p>
        
        <form method="POST" action="/post-job">
          <label for="title">Jobtitel *</label>
          <input type="text" id="title" name="title" required placeholder="z. B. LKW-Fahrer (m/w/d) Fernverkehr"/>
          
          <label for="company">Unternehmen *</label>
          <input type="text" id="company" name="company" required placeholder="z. B. ABC Spedition"/>
          
          <label for="url">Bewerbungs-URL *</label>
          <input type="url" id="url" name="url" required placeholder="https://…"/>
          <div class="help-text">Ziel-URL für Bewerbungen</div>
          
          <label for="description">Beschreibung (optional)</label>
          <textarea id="description" name="description" placeholder="Leer lassen, um eine strukturierte Beschreibung per KI zu erzeugen…"></textarea>
          <div class="help-text">Eigene HTML/Texte möglich – werden moderat bereinigt</div>
          
          <label for="tags">Tags (optional)</label>
          <input type="text" id="tags" name="tags" placeholder="z. B. fernverkehr, vollzeit, adr"/>
          <div class="help-text">Kommagetrennt</div>
          
          <div class="form-row">
            <div>
              <label for="employmentType">Beschäftigungsart</label>
              <select id="employmentType" name="employmentType">
                <option value="FULL_TIME">Vollzeit</option>
                <option value="PART_TIME">Teilzeit</option>
                <option value="CONTRACTOR">Zeitarbeit/Werkvertrag</option>
                <option value="TEMPORARY">Befristet</option>
                <option value="INTERN">Praktikum/Ausbildung</option>
              </select>
            </div>
            <div>
              <label for="isRemote">Remote</label>
              <select id="isRemote" name="isRemote">
                <option value="no">Nein</option>
                <option value="yes">Ja</option>
              </select>
            </div>
          </div>
          
          <h3 style="margin-top:24px">Vergütung (optional)</h3>
          
          <div class="form-row">
            <div>
              <label for="currency">Währung</label>
              <select id="currency" name="currency">
                <option value="">Keine</option>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
                <option value="CHF">CHF</option>
              </select>
            </div>
            <div>
              <label for="salaryMin">Minimum</label>
              <input type="number" id="salaryMin" name="salaryMin" placeholder="z. B. 3000"/>
            </div>
            <div>
              <label for="salaryMax">Maximum</label>
              <input type="number" id="salaryMax" name="salaryMax" placeholder="z. B. 3800"/>
            </div>
            <div>
              <label for="salaryUnit">Pro</label>
              <select id="salaryUnit" name="salaryUnit">
                <option value="YEAR">Jahr</option>
                <option value="MONTH">Monat</option>
                <option value="WEEK">Woche</option>
                <option value="DAY">Tag</option>
                <option value="HOUR">Stunde</option>
              </select>
            </div>
          </div>
          
          <button type="submit" class="btn btn-primary">Job senden</button>
        </form>
      </article>`,
    breadcrumbs
  }));
});

// JOB VERÖFFENTLICHEN (POST)
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

    if (!title || !company || !url) {
      return res.status(400).send('Erforderliche Felder fehlen');
    }

    const guid = `manual-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const published_at = Math.floor(Date.now() / 1000);

    const userTags = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    
    let finalHtml, finalShort, finalTags;
    if (!description.trim()) {
      console.log('Erzeuge KI-Inhalt für manuelle Anzeige:', title);
      const result = await rewriteJobRich({
        title,
        company,
        html: `<p>Position bei ${company}</p>`
      }, true);
      finalHtml = result.html;
      finalShort = result.short;
      finalTags = [...new Set([...result.tags, ...userTags])];
    } else {
      finalHtml = sanitizeHtml(stripDocumentTags(description));
      finalShort = truncateWords(convert(description, { wordwrap: 120 }), 45);
      finalTags = [...new Set([...extractTags({ title, company, html: description }), ...userTags])];
    }

    let salaryInfo = '';
    if (currency && (salaryMin || salaryMax)) {
      salaryInfo = `\n<p><strong>Vergütung:</strong> ${currency} ${salaryMin ? salaryMin : ''}${salaryMin && salaryMax ? '-' : ''}${salaryMax ? salaryMax : ''} pro ${salaryUnit.toLowerCase()}</p>`;
    }
    const enrichedHtml = finalHtml + salaryInfo;

    const slug = mkSlug(`${title}-${company}-${Date.now()}`) || mkSlug(guid);

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

    stmtSetCache.run('total_jobs', getCachedCount(0));
    console.log(`Manuelle Anzeige veröffentlicht: ${title} bei ${company}`);
    res.redirect(`/job/${slug}`);
  } catch (error) {
    console.error('Fehler beim Senden:', error);
    res.status(500).send('Fehler beim Senden der Anzeige. Bitte erneut versuchen.');
  }
});

// REGELN & FAQ
app.get('/rules', (req, res) => {
  const breadcrumbs = [
    { name: 'Start', url: '/' },
    { name: 'Regeln', url: '/rules' }
  ];

  const faqData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "Wie veröffentliche ich einen Job?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": `Klicken Sie auf „Job veröffentlichen“ im Header und füllen Sie das Formular aus. Alle ${TARGET_PROFESSION}-Positionen sind willkommen.`
        }
      },
      {
        "@type": "Question",
        "name": "Ist das Veröffentlichen kostenlos?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Ja, das Veröffentlichen von Jobs ist auf unserer Plattform kostenfrei."
        }
      },
      {
        "@type": "Question",
        "name": "Wie lange bleibt ein Job online?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Jobs bleiben 30 Tage aktiv und werden in Sitemap und RSS-Feed aufgenommen."
        }
      }
    ]
  };
  const faqSchema = `<script type="application/ld+json">${JSON.stringify(faqData)}</script>`;

  const orgSchema = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": SITE_NAME,
    "url": SITE_URL,
    ...(SITE_LOGO ? { "logo": SITE_LOGO } : {}),
    ...(SITE_SAMEAS ? { "sameAs": SITE_SAMEAS.split(',').map(s => s.trim()).filter(Boolean) } : {})
  })}</script>`;

  res.send(layout({
    title: 'Regeln & FAQ',
    body: `
      <nav class="muted small"><a href="/">Start</a> › Regeln</nav>
      <article class="card">
        <h1>Regeln & FAQ</h1>
        
        <h2>Richtlinien</h2>
        <ul>
          <li>Nur ${escapeHtml(TARGET_PROFESSION)}-Positionen veröffentlichen</li>
          <li>Alle Anzeigen müssen legitime Angebote sein</li>
          <li>Korrekte Unternehmensdaten und Bewerbungs-URLs angeben</li>
          <li>Keine diskriminierenden Inhalte oder Anforderungen</li>
        </ul>
        
        <h2>Häufige Fragen</h2>
        
        <h3>Wie veröffentliche ich einen Job?</h3>
        <p>Klicken Sie auf „Job veröffentlichen“ und füllen Sie das Formular aus. Alle ${escapeHtml(TARGET_PROFESSION)}-Positionen sind willkommen.</p>
        
        <h3>Ist das kostenlos?</h3>
        <p>Ja, das Veröffentlichen ist kostenfrei.</p>
        
        <h3>Wie lange bleibt ein Job online?</h3>
        <p>30 Tage, inkl. Aufnahme in Sitemap und RSS.</p>
        
        <h3>Kann ich eine Anzeige ändern oder löschen?</h3>
        <p>Kontaktieren Sie uns für Änderungen oder die Entfernung.</p>
        
        <h3>Wie werden Jobs aufbereitet?</h3>
        <p>Wir strukturieren Beschreibungen für bessere Lesbarkeit. Eigene Texte werden bevorzugt genutzt.</p>
      </article>`,
    breadcrumbs,
    metaExtra: faqSchema + orgSchema
  }));
});

// TAG-SEITE
app.get('/tag/:slug', (req, res) => {
  const slug = req.params.slug;
  const tag = stmtGetTagBySlug.get(slug);
  if (!tag) return res.status(404).send('Nicht gefunden');

  const pageSize = 50;
  const cursor = req.query.cursor || '';

  let rows;
  if (!cursor) {
    rows = stmtJobsByTagFirst.all(slug, pageSize);
  } else {
    const [pub, id] = cursor.split('-').map(Number);
    if (!pub || !id) return res.status(400).send('Ungültiger Cursor');
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
      <div class="muted small">${new Date(r.published_at * 1000).toLocaleDateString('de-DE')}</div>
    </li>`).join('');

  const pagerLinks = [];
  if (nextCursor) {
    res.setHeader('Link', `<${canonical(`/tag/${slug}?cursor=${nextCursor}`)}>; rel="next"`);
    pagerLinks.push(`<a href="/tag/${slug}?cursor=${nextCursor}" rel="next">Weiter →</a>`);
  }
  if (cursor) {
    pagerLinks.unshift(`<a href="/tag/${slug}" rel="prev">← Erste Seite</a>`);
  }
  const pager = pagerLinks.length ? `<div class="pager">${pagerLinks.join('')}</div>` : '';

  const breadcrumbs = [
    { name: 'Start', url: '/' },
    { name: 'Tags', url: '/tags' },
    { name: tag.name, url: `/tag/${slug}` }
  ];

  res.send(layout({
    title: `Tag: ${tag.name}`,
    body: `
      <nav class="muted small"><a href="/">Start</a> › <a href="/tags">Tags</a> › ${escapeHtml(tag.name)}</nav>
      <h1>Tag: ${escapeHtml(tag.name)}</h1>
      <p class="muted">${cnt} Jobs</p>
      <ul class="list">${items || '<li class="card">Noch keine Jobs.</li>'}</ul>
      ${pager}`,
    breadcrumbs
  }));
});

// ALLE TAGS
app.get('/tags', (req, res) => {
  const popular = stmtPopularTags.all(1, 500);
  const breadcrumbs = [
    { name: 'Start', url: '/' },
    { name: 'Tags', url: '/tags' }
  ];

  const body = popular.length ? `
    <nav class="muted small"><a href="/">Start</a> › Tags</nav>
    <h1>Alle Tags</h1>
    <div class="tags">
      ${popular.map(t => `<a class="tag" href="/tag/${t.slug}">${escapeHtml(t.name)} (${t.cnt})</a>`).join('')}
    </div>` : `
    <nav class="muted small"><a href="/">Start</a> › Tags</nav>
    <h1>Tags</h1>
    <p class="muted">Noch keine Tags.</p>`;

  res.send(layout({ title: 'Tags', body, breadcrumbs }));
});

// JOB-SEITE
app.get('/job/:slug', (req, res) => {
  const job = stmtBySlug.get(req.params.slug);
  if (!job) return res.status(404).send('Nicht gefunden');

  const token = crypto.createHmac('sha256', CLICK_SECRET).update(String(job.id)).digest('hex').slice(0, 16);

  const tags = (job.tags_csv || '').split(',').map(s => s.trim()).filter(Boolean);
  const tagsHtml = tags.length ? `
    <div class="tags">
      ${tags.map(name => `<a class="tag" href="/tag/${tagSlug(name)}">${escapeHtml(name)}</a>`).join('')}
    </div>` : '';

  const meta = parseMeta(job.description_html || '', job.title || '');
  const datePostedISO = new Date(job.published_at * 1000).toISOString();
  const validThrough = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

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
      "name": job.company || "Unbekannt"
    },
    ...(meta.isRemote ? { "jobLocationType": "TELECOMMUTE" } : {}),
    ...(meta.salary ? {
      "baseSalary": {
        "@type": "MonetaryAmount",
        "currency": meta.salary.currency,
        "value": {
          "@type": "QuantitativeValue",
          ...(meta.salary.min ? { "minValue": meta.salary.min } : {}),
          ...(meta.salary.max ? { "maxValue": meta.salary.max } : {}),
          ...(meta.salary.unit ? { "unitText": meta.salary.unit } : {})
        }
      }
    } : {})
  };

  const breadcrumbs = [
    { name: 'Start', url: '/' },
    { name: job.title, url: `/job/${job.slug}` }
  ];

  const metaExtra = `
    <script type="application/ld+json">${JSON.stringify(jobPostingJson)}</script>
    <meta name="robots" content="index, follow"/>
  `;

  const body = `
  <nav class="muted small"><a href="/">Start</a> › ${escapeHtml(job.title)}</nav>
  <article class="card">
    <h1>${escapeHtml(job.title)}</h1>
    ${job.company ? `<div class="muted">${escapeHtml(job.company)}</div>` : ''}
    <div class="muted small">${new Date(job.published_at * 1000).toLocaleDateString('de-DE')}</div>
    ${tagsHtml}
    <div class="content">${job.description_html || ''}</div>
    <form method="POST" action="/go" style="margin-top:24px">
      <input type="hidden" name="id" value="${job.id}"/>
      <input type="hidden" name="t" value="${token}"/>
      <button class="btn btn-primary" type="submit">Jetzt bewerben / Quelle öffnen</button>
    </form>
  </article>`;

  res.send(layout({ title: job.title, body, metaExtra, breadcrumbs }));
});

// /go Weiterleitung (mit Token)
app.post('/go', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const id = Number(req.body?.id || 0);
  const t = String(req.body?.t || '');
  if (!id || !t) return res.status(400).send('Fehlerhafte Anfrage');

  const expect = crypto.createHmac('sha256', CLICK_SECRET).update(String(id)).digest('hex').slice(0, 16);
  if (t !== expect) return res.status(403).send('Verboten');

  const job = stmtById.get(id);
  if (!job || !job.url) return res.status(404).send('Nicht gefunden');
  return res.redirect(302, job.url);
});

app.get('/go', (_req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(405).send('Methode nicht erlaubt');
});

// robots.txt
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

// RSS
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
    <description>Aktuelle ${escapeHtml(TARGET_PROFESSION.toLowerCase())}-Stellen</description>
    <language>${TARGET_LANG}</language>
    <atom:link href="${canonical('/feed.xml')}" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`);
});

// ========================================
// RECHTSTEXTE (DE)
// ========================================
const LAST_UPDATED = new Date().toISOString().slice(0,10); // YYYY-MM-DD

app.get('/privacy', (req, res) => {
  const breadcrumbs = [
    { name: 'Start', url: '/' },
    { name: 'Datenschutz', url: '/privacy' }
  ];
  res.send(layout({
    title: 'Datenschutzerklärung',
    body: `
      <nav class="muted small"><a href="/">Start</a> › Datenschutz</nav>
      <article class="card content">
        <h1>Datenschutzerklärung</h1>
        <p class="small muted">Stand: ${LAST_UPDATED}</p>
        <p>Wir respektieren Ihre Privatsphäre. Diese Website speichert nur die minimal erforderlichen Daten zur Bereitstellung der Kernfunktionen.</p>
        <h2>Daten, die wir verarbeiten</h2>
        <ul>
          <li>Server-Logs (IP-Adresse, User-Agent) zur Sicherheit und Zuverlässigkeit</li>
          <li>Von Ihnen übermittelte Inhalte in Stellenanzeigen</li>
          <li>Essenzielle Cookies zur Speicherung Ihrer Einwilligungspräferenzen</li>
        </ul>
        <h2>Zweck & Rechtsgrundlage</h2>
        <p>Wir verarbeiten Daten zur Bereitstellung des Dienstes, zur Missbrauchsvermeidung und zur Darstellung von Jobangeboten. Rechtsgrundlage sind berechtigte Interessen sowie Ihre Einwilligung, soweit erforderlich.</p>
        <h2>Speicherdauer</h2>
        <p>Logs werden zeitlich begrenzt vorgehalten, Stellenanzeigen solange relevant, Einwilligungs-Cookies bis zu zwölf Monate.</p>
        <h2>Ihre Rechte</h2>
        <p>Sie können Auskunft oder Löschung Ihrer personenbezogenen Daten in von Ihnen veröffentlichten Anzeigen verlangen.</p>
        <h2>Kontakt</h2>
        <p>Für Datenschutzanfragen kontaktieren Sie uns bitte über die auf der Website angegebenen Kontaktdaten.</p>
      </article>`,
    breadcrumbs
  }));
});

app.get('/terms', (req, res) => {
  const breadcrumbs = [
    { name: 'Start', url: '/' },
    { name: 'Nutzungsbedingungen', url: '/terms' }
  ];
  res.send(layout({
    title: 'Nutzungsbedingungen',
    body: `
      <nav class="muted small"><a href="/">Start</a> › Nutzungsbedingungen</nav>
      <article class="card content">
        <h1>Nutzungsbedingungen</h1>
        <p class="small muted">Stand: ${LAST_UPDATED}</p>
        <h2>Akzeptanz</h2>
        <p>Mit der Nutzung von ${escapeHtml(SITE_NAME)} erklären Sie sich mit diesen Bedingungen einverstanden. Wenn nicht, nutzen Sie den Dienst bitte nicht.</p>
        <h2>Nutzung des Dienstes</h2>
        <ul>
          <li>Veröffentlichen Sie nur legitime ${escapeHtml(TARGET_PROFESSION)}-Stellen</li>
          <li>Keine rechtswidrigen oder diskriminierenden Inhalte</li>
          <li>Keine Störungen oder missbräuchliche Nutzung des Dienstes</li>
        </ul>
        <h2>Inhalte</h2>
        <p>Für eingereichte Inhalte sind Sie verantwortlich. Wir können Inhalte entfernen, die gegen diese Bedingungen verstoßen.</p>
        <h2>Haftungsausschluss</h2>
        <p>Der Dienst wird „wie besehen“ ohne Garantien bereitgestellt.</p>
        <h2>Haftungsbeschränkung</h2>
        <p>Im gesetzlich zulässigen Umfang haften wir nicht für indirekte oder Folgeschäden.</p>
        <h2>Änderungen</h2>
        <p>Wir können diese Bedingungen gelegentlich durch Veröffentlichung einer aktualisierten Fassung ändern.</p>
      </article>`,
    breadcrumbs
  }));
});

app.get('/cookies', (req, res) => {
  const breadcrumbs = [
    { name: 'Start', url: '/' },
    { name: 'Cookie-Richtlinie', url: '/cookies' }
  ];
  res.send(layout({
    title: 'Cookie-Richtlinie',
    body: `
      <nav class="muted small"><a href="/">Start</a> › Cookies</nav>
      <article class="card content">
        <h1>Cookie-Richtlinie</h1>
        <p class="small muted">Stand: ${LAST_UPDATED}</p>
        <h2>Was sind Cookies?</h2>
        <p>Cookies sind kleine Textdateien, die auf Ihrem Gerät gespeichert werden, um Webseiten funktionsfähig zu machen.</p>
        <h2>Von uns verwendete Cookies</h2>
        <ul>
          <li><strong>cookie_consent</strong> — speichert Ihre Einwilligung (läuft nach 12 Monaten ab).</li>
        </ul>
        <h2>Cookies verwalten</h2>
        <p>Sie können Cookies in den Browser-Einstellungen löschen. Zum Ändern Ihrer Einwilligung hier klicken:</p>
        <button class="btn" onclick="document.cookie='cookie_consent=; Max-Age=0; Path=/; SameSite=Lax'; alert('Einwilligung gelöscht. Seite neu laden, um den Banner zu sehen.');">
          Einwilligung löschen
        </button>
      </article>`,
    breadcrumbs
  }));
});

// Manueller Feed-Import
app.get('/fetch', async (_req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.write('Verarbeite Feed…\n\n');
  try {
    await processFeed();
    res.end('Fertig! Details in der Konsole.\n');
  } catch (e) {
    res.end(`Fehler: ${e.message}\n`);
  }
});

// ========================================
// STARTUP
// ========================================
if (FEED_URL) {
  processFeed().catch(console.error);
}

if (FEED_URL && CRON_SCHEDULE) {
  cron.schedule(CRON_SCHEDULE, () => {
    console.log(`\nCRON: Starte geplante Feed-Verarbeitung…`);
    processFeed().catch(console.error);
  });
}

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log(`${SITE_NAME}`);
  console.log('='.repeat(60));
  console.log(`Server:       ${SITE_URL}`);
  console.log(`Profession:   ${TARGET_PROFESSION}`);
  console.log(`Keywords:     ${PROFESSION_KEYWORDS.join(', ')}`);
  console.log(`KI aktiv:     ${HAS_OPENAI ? 'Ja' : 'Nein'}`);
  console.log(`KI-Limit:     ${AI_PROCESS_LIMIT === 0 ? 'Unbegrenzt' : `${AI_PROCESS_LIMIT} Jobs pro Feed`}`);
  console.log(`Feed-URL:     ${FEED_URL || 'Nicht konfiguriert'}`);
  console.log(`Cron:         ${CRON_SCHEDULE}`);
  console.log(`Favicon:      ${FAVICON_URL || 'Keins'}`);
  console.log(`Jobs gesamt:  ${getCachedCount().toLocaleString('de-DE')}`);
  console.log('='.repeat(60) + '\n');
});
