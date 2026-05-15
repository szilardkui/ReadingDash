// Reading Dashboard — Notion Data Proxy
// Queries Sessions DB + resolves book titles via relation

const SESSIONS_DB_ID = '21d9469c05fd802a8494f492a1634dc7';
const NOTION_VERSION = '2022-06-28';

async function notionGet(path, token) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  return res.json();
}

async function notionPost(path, body, token) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

function extractProp(p, key) {
  const prop = p[key];
  if (!prop) return null;
  switch (prop.type) {
    case 'title':       return prop.title?.[0]?.plain_text ?? '';
    case 'rich_text':   return prop.rich_text?.[0]?.plain_text ?? '';
    case 'number':      return prop.number ?? null;
    case 'date':        return prop.date?.start ?? null;
    case 'select':      return prop.select?.name ?? null;
    case 'relation':    return (prop.relation || []).map(r => r.id);
    case 'formula':
      const f = prop.formula;
      return f.number ?? f.string ?? f.boolean ?? null;
    default:            return null;
  }
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'NOTION_TOKEN not set' }) };
  }

  try {
    // ── 1. Fetch all sessions ──────────────────────────────────
    let allPages = [];
    let cursor;

    do {
      const body = {
        page_size: 100,
        sorts: [{ property: 'Date', direction: 'ascending' }],
      };
      if (cursor) body.start_cursor = cursor;

      const result = await notionPost(`/databases/${SESSIONS_DB_ID}/query`, body, token);

      if (result.object === 'error') throw new Error(result.message);
      allPages = [...allPages, ...result.results];
      cursor = result.has_more ? result.next_cursor : null;
    } while (cursor);

    // ── 2. Collect unique book IDs ─────────────────────────────
    const bookIds = new Set();
    allPages.forEach(page => {
      const relation = extractProp(page.properties, 'Book');
      if (Array.isArray(relation)) relation.forEach(id => bookIds.add(id));
    });

    // ── 3. Fetch book titles in parallel ──────────────────────
    const books = {};
    await Promise.all([...bookIds].map(async id => {
      try {
        const page = await notionGet(`/pages/${id}`, token);
        const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
        books[id] = titleProp?.title?.[0]?.plain_text || 'Unknown';
      } catch {
        books[id] = 'Unknown';
      }
    }));

    // ── 4. Transform sessions ─────────────────────────────────
    const sessions = allPages.map(page => {
      const p = page.properties;
      const bookRelation = extractProp(p, 'Book') || [];

      const locationsRead = extractProp(p, 'Locations Read');
      const duration = extractProp(p, 'Duration (mins)');
      let wpm = extractProp(p, 'WPM');

      // Fallback: calculate WPM manually if formula returned null
      if (!wpm && locationsRead && duration) {
        wpm = Math.round((locationsRead * 21) / duration);
      }

      return {
        id: page.id,
        session: extractProp(p, 'Session') || '',
        date: extractProp(p, 'Date'),
        startLocation: extractProp(p, 'Start Location'),
        endLocation: extractProp(p, 'End Location'),
        locationsRead,
        duration,
        wpm,
        medium: extractProp(p, 'Medium'),
        comprehension: extractProp(p, 'Comprehension'),
        score: extractProp(p, 'Score (1\u20135)'),   // en-dash
        notes: extractProp(p, 'Notes') || '',
        bookIds: bookRelation,
        bookTitles: bookRelation.map(id => books[id] || 'Unknown'),
      };
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ sessions, books }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
