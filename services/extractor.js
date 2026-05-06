'use strict';

const pdfParse = require('pdf-parse');
const cheerio = require('cheerio');

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_CLIENT_VERSION = '20.10.38';
const ANDROID_UA = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36';
const YT_ID_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/i;

function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/.test(url);
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function parseTranscriptXml(xml) {
  const texts = [];
  // New format: <p t="..." d="..."><s>text</s></p>
  const pMatches = [...xml.matchAll(/<p\s[^>]*>([\s\S]*?)<\/p>/g)];
  if (pMatches.length > 0) {
    for (const m of pMatches) {
      const sMatches = [...m[1].matchAll(/<s[^>]*>([^<]*)<\/s>/g)];
      const raw = sMatches.length ? sMatches.map(s => s[1]).join('') : m[1].replace(/<[^>]+>/g, '');
      const text = decodeHtmlEntities(raw).trim();
      if (text) texts.push(text);
    }
  } else {
    // Old format: <text start="..." dur="...">...</text>
    for (const m of xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) {
      const text = decodeHtmlEntities(m[1]).trim();
      if (text) texts.push(text);
    }
  }
  return texts.join(' ');
}

async function extractYouTubeTranscript(url) {
  const idMatch = url.match(YT_ID_RE);
  if (!idMatch) throw new Error('Neplatná YouTube URL.');
  const videoId = idMatch[1];

  const itRes = await fetch(INNERTUBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': ANDROID_UA },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: INNERTUBE_CLIENT_VERSION } },
      videoId,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!itRes.ok) throw new Error(`YouTube InnerTube API vrátil ${itRes.status}.`);

  const data = await itRes.json();
  const title = data?.videoDetails?.title || `YouTube (${videoId})`;
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('Video nemá dostupné titulky/prepis. Skúste iné video.');
  }

  const trackUrl = tracks[0].baseUrl;
  if (!new URL(trackUrl).hostname.endsWith('.youtube.com')) {
    throw new Error('Neplatná URL titulkov.');
  }

  const xmlRes = await fetch(trackUrl, {
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!xmlRes.ok) throw new Error('Chyba pri sťahovaní prepisu.');

  const xml = await xmlRes.text();
  const text = parseTranscriptXml(xml);
  if (!text) throw new Error('Prepis je prázdny.');

  return { title, text: text.slice(0, 20000) };
}

async function extractArticleText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'sk,cs,en;q=0.8' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} pri načítaní stránky.`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const title = $('meta[property="og:title"]').attr('content')
    || $('title').text().trim()
    || $('h1').first().text().trim()
    || url;

  $('script, style, nav, header, footer, aside, .sidebar, .menu, .nav, .ads, .advertisement, .cookie, .popup, .modal, [role="navigation"], [role="complementary"]').remove();

  const main = $('article, [role="main"], main, .post-content, .entry-content, .article-body, .content').first();
  const text = (main.length ? main.text() : $('body').text())
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20000);

  if (text.length < 100) throw new Error('Stránka neobsahuje dostatok textu. Skúste iný URL.');

  return { title: title.trim(), text };
}

async function extractPdfText(buffer) {
  const data = await pdfParse(buffer);
  const text = data.text.replace(/\s+/g, ' ').trim();
  if (text.length < 50) throw new Error('PDF neobsahuje čitateľný text (možno je skenovaný obrázok).');
  return { title: 'PDF dokument', text: text.slice(0, 20000) };
}

module.exports = { isYouTubeUrl, extractYouTubeTranscript, extractArticleText, extractPdfText };
