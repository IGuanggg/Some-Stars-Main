import { mkdir, writeFile } from 'node:fs/promises';

const token = process.env.STAR_LIST_TOKEN || process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || 'IGuanggg/Some-Stars-Main';
const [owner] = repository.split('/');
const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';

if (!token) {
  throw new Error('Missing STAR_LIST_TOKEN or GITHUB_TOKEN');
}

const headers = {
  Accept: 'application/vnd.github.star+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': `${repository}-star-list-generator`,
  'X-GitHub-Api-Version': '2022-11-28',
};

const publicHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': `${repository}-star-list-generator`,
  'X-GitHub-Api-Version': '2022-11-28',
};

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="next"'));
  return match?.match(/^<([^>]+)>/)?.[1] || null;
}

async function request(url, requestHeaders = headers) {
  const response = await fetch(url, { headers: requestHeaders });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`);
  }
  return response;
}

async function fetchPaged(url, requestHeaders = headers) {
  const items = [];
  let current = url;

  while (current) {
    const response = await request(current, requestHeaders);
    items.push(...(await response.json()));
    current = nextLink(response.headers.get('link'));
  }

  return items;
}

async function fetchStarredRepos() {
  let rawItems;

  try {
    rawItems = await fetchPaged(`${apiBase}/user/starred?per_page=100`);
  } catch (error) {
    console.warn(`Authenticated starred lookup failed: ${error.message}`);
    console.warn(`Falling back to public starred list for ${owner}.`);
    const publicItems = await fetchPaged(
      `${apiBase}/users/${owner}/starred?per_page=100`,
      publicHeaders
    );

    return publicItems.map((repo) => ({
      starred_at: null,
      repo,
    }));
  }

  return rawItems.map((item) => {
    if (item.repo) {
      return {
        starred_at: item.starred_at,
        repo: item.repo,
      };
    }

    return {
      starred_at: null,
      repo: item,
    };
  });
}

function normalizeRepo({ repo, starred_at }) {
  return {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: repo.full_name,
    owner: {
      login: repo.owner?.login,
      id: repo.owner?.id,
      avatar_url: repo.owner?.avatar_url,
      url: repo.owner?.url,
      html_url: repo.owner?.html_url,
    },
    html_url: repo.html_url,
    description: repo.description || '',
    url: repo.url,
    languages_url: repo.languages_url,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: repo.git_url,
    ssh_url: repo.ssh_url,
    clone_url: repo.clone_url,
    homepage: repo.homepage,
    stargazers_count: repo.stargazers_count || 0,
    watchers_count: repo.watchers_count || 0,
    forks_count: repo.forks_count || 0,
    open_issues_count: repo.open_issues_count || 0,
    language: repo.language || null,
    topics: repo.topics || [],
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
    license: repo.license
      ? {
          key: repo.license.key,
          name: repo.license.name,
          spdx_id: repo.license.spdx_id,
          url: repo.license.url,
        }
      : null,
    starred_at,
  };
}

function groupByLanguage(repos) {
  const groups = {};

  for (const repo of repos) {
    const language = repo.language || 'miscellaneous';
    groups[language] ||= [];
    groups[language].push(repo);
  }

  return Object.fromEntries(
    Object.entries(groups).sort(([left], [right]) => {
      if (left === 'miscellaneous') return -1;
      if (right === 'miscellaneous') return 1;
      return left.localeCompare(right);
    })
  );
}

function plainText(value, fallback = 'No description provided.') {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[—–]/g, '-')
    .replace(/·/g, '|')
    .trim();
  return text || fallback;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value || 0);
}

function formatDate(value) {
  if (!value) return 'unknown';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function escapeHtml(value) {
  return plainText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value) {
  return escapeHtml(value);
}

function formatShortNumber(value) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value || 0);
}

function truncate(value, maxLength = 140) {
  const text = plainText(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3).trim()}...`;
}

function headingSlug(heading, seen) {
  const base =
    heading
      .trim()
      .toLowerCase()
      .replace(/\\/g, '')
      .replace(/&/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section';
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function repoCard(repo, compact = false) {
  const description = escapeHtml(truncate(repo.description, compact ? 92 : 150));
  const language = escapeHtml(repo.language || 'miscellaneous');
  const topics = compact || !repo.topics.length
    ? ''
    : `<br><sub>${repo.topics.slice(0, 3).map((topic) => `#${escapeHtml(topic)}`).join(' ')}</sub>`;

  return `<strong><a href="${repo.html_url}">${escapeHtml(repo.full_name)}</a></strong><br>
<sub>${description}</sub><br>
  <code>&#9733; ${formatShortNumber(repo.stargazers_count)} | Fork ${formatShortNumber(
    repo.forks_count
  )} | ${language}</code>${topics}`;
}

function repoGrid(items) {
  const rows = [];

  for (let index = 0; index < items.length; index += 2) {
    if (items[index + 1]) {
      rows.push(
        `<tr><td width="50%" valign="top">${repoCard(
          items[index]
        )}</td><td width="50%" valign="top">${repoCard(items[index + 1])}</td></tr>`
      );
    } else {
      rows.push(`<tr><td colspan="2" valign="top">${repoCard(items[index])}</td></tr>`);
    }
  }

  return `<table>\n${rows.join('\n')}\n</table>`;
}

function highlightTable(recentlyStarred, mostStarred) {
  const count = Math.max(recentlyStarred.length, mostStarred.length);
  const rows = [];

  for (let index = 0; index < count; index += 1) {
    const recent = recentlyStarred[index]
      ? repoCard(recentlyStarred[index], true)
      : '';
    const popular = mostStarred[index] ? repoCard(mostStarred[index], true) : '';
    rows.push(`<tr><td width="58%" valign="top">${recent}</td><td width="42%" valign="top">${popular}</td></tr>`);
  }

  return `<table>
<thead><tr><th align="left">New to the shelf</th><th align="left">Community favorites</th></tr></thead>
<tbody>${rows.join('\n')}</tbody>
</table>`;
}

function badgeUrl(label, message, color = '1f6feb', style = 'flat-square') {
  return `https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(
    message
  )}-${color}?style=${style}`;
}

function renderStarAtlas(languageEntries, total, generatedAt) {
  const topLanguages = [...languageEntries]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8);
  const topTotal = topLanguages.reduce((sum, [, items]) => sum + items.length, 0) || 1;
  const shades = ['#58a6ff', '#2f81f7', '#1f6feb', '#1158c7', '#79c0ff', '#388bfd', '#0d419d', '#a5d6ff'];
  let segmentX = 650;

  const segments = topLanguages
    .map(([language, items], index) => {
      const width = (items.length / topTotal) * 470;
      const segment = `<rect x="${segmentX.toFixed(2)}" y="303" width="${width.toFixed(
        2
      )}" height="18" rx="9" fill="${shades[index]}"/>`;
      segmentX += width;
      return segment;
    })
    .join('');

  const languageRows = topLanguages
    .map(([language, items], index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = 650 + column * 245;
      const y = 88 + row * 50;
      return `<g transform="translate(${x} ${y})">
  <rect width="12" height="12" rx="4" fill="${shades[index]}"/>
  <text x="24" y="11" class="label">${escapeXml(language)}</text>
  <text x="215" y="11" text-anchor="end" class="value">${items.length}</text>
</g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="380" viewBox="0 0 1200 380" role="img" aria-labelledby="title description">
<title id="title">IGuanggg Star Atlas</title>
<desc id="description">${total} starred repositories grouped across ${languageEntries.length} languages</desc>
<style>
  .title { fill: #f0f6fc; font: 700 46px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: -1.5px; }
  .subtitle { fill: #8b949e; font: 400 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .metric { fill: #f0f6fc; font: 700 32px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .metric-label { fill: #8b949e; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 1px; }
  .label { fill: #c9d1d9; font: 600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .value { fill: #8b949e; font: 600 14px ui-monospace, SFMono-Regular, Consolas, monospace; }
</style>
<rect width="1200" height="380" rx="28" fill="#0d1117"/>
<rect x="28" y="28" width="1144" height="324" rx="22" fill="#161b22" stroke="#30363d"/>
<text x="72" y="105" class="title">STAR ATLAS</text>
<text x="72" y="143" class="subtitle">A living shelf of open-source tools, ideas, and experiments.</text>
<g transform="translate(72 205)">
  <text class="metric">${formatNumber(total)}</text>
  <text y="25" class="metric-label">STARRED REPOS</text>
</g>
<g transform="translate(245 205)">
  <text class="metric">${languageEntries.length}</text>
  <text y="25" class="metric-label">LANGUAGES</text>
</g>
<text x="72" y="310" class="subtitle">Synced ${escapeXml(generatedAt)} Asia/Shanghai</text>
<text x="650" y="58" class="metric-label">TOP LANGUAGES</text>
${languageRows}
${segments}
</svg>`;
}

function renderReadme(groups, repos) {
  const generatedAt = formatDateTime(new Date());
  const languageEntries = Object.entries(groups);
  const total = repos.length;
  const starredWithDates = repos.filter((repo) => repo.starred_at);
  const recentlyStarred = (
    starredWithDates.length
      ? [...starredWithDates].sort((a, b) => new Date(b.starred_at) - new Date(a.starred_at))
      : repos
  ).slice(0, 6);
  const mostStarred = [...repos]
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, 6);
  const recentlyUpdated = [...repos]
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 10);

  const seen = new Map();
  const tocHeadings = [
    'Snapshot',
    'Highlights',
    'Language Index',
    'All Stars',
    ...languageEntries.map(([language]) => language),
    'About',
  ];
  const anchors = Object.fromEntries(
    tocHeadings.map((heading) => [heading, headingSlug(heading, seen)])
  );

  const languageBadges = languageEntries
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([language, items]) =>
        `<a href="#${anchors[language]}"><img alt="${escapeHtml(language)} ${
          items.length
        }" src="${badgeUrl(language, items.length, '1f6feb', 'for-the-badge')}"></a>`
    )
    .join('\n');

  const updatedBadges = recentlyUpdated
    .map(
      (repo) =>
        `<a href="${repo.html_url}"><img alt="${escapeHtml(repo.full_name)}" src="${badgeUrl(
          repo.name,
          `${formatShortNumber(repo.stargazers_count)} stars`,
          '30363d'
        )}"></a>`
    )
    .join('\n');

  const allStars = languageEntries
    .map(([language, items], index) => {
      const open = index < 2 ? ' open' : '';
      return `<a id="${anchors[language]}"></a>
<details${open}>
<summary><strong>${escapeHtml(language)}</strong> <code>${items.length} repos</code></summary>

${repoGrid(items)}

</details>`;
    })
    .join('\n\n');

  return `<a id="${anchors.Snapshot}"></a>

<p align="center"><img src="assets/star-atlas.svg" width="100%" alt="IGuanggg Star Atlas overview"></p>

<p align="center">
  <a href="https://github.com/${owner}"><img src="https://github.com/${owner}.png?size=96" width="72" alt="${owner} avatar"></a>
</p>

<h1 align="center">${owner}'s open-source shelf</h1>

<p align="center">Useful tools, sharp ideas, and projects worth returning to. Refreshed automatically every day.</p>

<p align="center">
  <a href="#${anchors.Highlights}"><img src="${badgeUrl('Browse', 'highlights', '1f6feb')}" alt="Browse highlights"></a>
  <a href="#${anchors['Language Index']}"><img src="${badgeUrl('Explore', 'languages', '1f6feb')}" alt="Explore languages"></a>
  <a href="#${anchors['All Stars']}"><img src="${badgeUrl('Open', 'full collection', '1f6feb')}" alt="Open full collection"></a>
</p>

## Highlights

${highlightTable(recentlyStarred, mostStarred)}

### Active this week

<p>${updatedBadges}</p>

## Language Index

<p align="center">${languageBadges}</p>

## All Stars

${allStars}

## About

This collection is generated by the repository's GitHub Actions workflow. The structured source lives in [data.json](data.json), and the visual summary is rebuilt from the same data on every sync.
`;
}

const starred = await fetchStarredRepos();
const repos = starred.map(normalizeRepo);
const groups = groupByLanguage(repos);
const generatedAt = formatDateTime(new Date());

await mkdir('assets', { recursive: true });
await writeFile('data.json', `${JSON.stringify(groups, null, 2)}\n`);
await writeFile('README.md', renderReadme(groups, repos));
await writeFile(
  'assets/star-atlas.svg',
  `${renderStarAtlas(Object.entries(groups), repos.length, generatedAt)}\n`
);

console.log(`Generated ${repos.length} starred repositories across ${Object.keys(groups).length} languages.`);
