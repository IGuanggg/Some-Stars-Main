import { writeFile } from 'node:fs/promises';

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

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="next"'));
  return match?.match(/^<([^>]+)>/)?.[1] || null;
}

async function request(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`);
  }
  return response;
}

async function fetchPaged(url) {
  const items = [];
  let current = url;

  while (current) {
    const response = await request(current);
    items.push(...(await response.json()));
    current = nextLink(response.headers.get('link'));
  }

  return items;
}

async function fetchStarredRepos() {
  const rawItems = await fetchPaged(`${apiBase}/user/starred?per_page=100`);

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

function repoLine(repo) {
  const details = [
    `stars ${formatNumber(repo.stargazers_count)}`,
    `forks ${formatNumber(repo.forks_count)}`,
    `updated ${formatDate(repo.updated_at)}`,
  ];

  if (repo.topics.length) {
    details.push(repo.topics.slice(0, 4).map((topic) => `#${topic}`).join(' '));
  }

  return `- [${repo.full_name}](${repo.html_url}) - ${plainText(repo.description)}\n  <br><sub>${details.join(' · ')}</sub>`;
}

function compactRepoLine(repo) {
  return `- [${repo.full_name}](${repo.html_url}) <sub>${formatNumber(
    repo.stargazers_count
  )} stars · ${repo.language || 'miscellaneous'} · updated ${formatDate(repo.updated_at)}</sub>`;
}

function renderReadme(groups, repos) {
  const generatedAt = formatDateTime(new Date());
  const languageEntries = Object.entries(groups);
  const total = repos.length;
  const topLanguages = [...languageEntries]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8);
  const recentlyStarred = [...repos]
    .filter((repo) => repo.starred_at)
    .sort((a, b) => new Date(b.starred_at) - new Date(a.starred_at))
    .slice(0, 8);
  const mostStarred = [...repos]
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, 8);
  const recentlyUpdated = [...repos]
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 8);

  const seen = new Map();
  const tocHeadings = [
    'Snapshot',
    'Highlights',
    'Language Index',
    'All Stars',
    ...languageEntries.map(([language]) => language),
    'About',
  ];
  const toc = tocHeadings
    .map((heading) => `- [${heading}](#${headingSlug(heading, seen)})`)
    .join('\n');

  const languageIndex = topLanguages
    .map(([language, items]) => `\`${language}\` ${items.length}`)
    .join(' · ');

  const allStars = languageEntries
    .map(([language, items], index) => {
      const open = index < 4 ? ' open' : '';
      return `<details${open}>\n<summary><strong>${language}</strong> · ${items.length} repos</summary>\n\n### ${language}\n\n${items
        .map(repoLine)
        .join('\n\n')}\n\n</details>`;
    })
    .join('\n\n');

  return `<div align="center">

# ${repository}

[![Awesome](https://awesome.re/badge.svg)](https://awesome.re)
[![Auth](https://img.shields.io/badge/Auth-${owner}-ff69b5?logo=github)](https://github.com/${owner})
[![Stars](https://img.shields.io/badge/Starred-${formatNumber(total)}-c780fa?logo=github)](https://github.com/${owner}?tab=stars)

My GitHub star list, refreshed every day.

<img src="https://cdn.jsdelivr.net/gh/eryajf/tu@main/img/image_20240420_214408.gif" width="800" height="3">
</div>

## Table of Contents

${toc}

## Snapshot

| Total starred | Languages | Last sync |
| ---: | ---: | --- |
| ${formatNumber(total)} | ${languageEntries.length} | ${generatedAt} Asia/Shanghai |

${languageIndex}

## Highlights

### Recently Starred

${recentlyStarred.map(compactRepoLine).join('\n')}

### Most Starred

${mostStarred.map(compactRepoLine).join('\n')}

### Recently Updated

${recentlyUpdated.map(compactRepoLine).join('\n')}

## Language Index

${languageEntries.map(([language, items]) => `- ${language}: ${items.length}`).join('\n')}

## All Stars

${allStars}

## About

Generated by this repository's GitHub Actions workflow. Data is stored in [data.json](data.json).
`;
}

const starred = await fetchStarredRepos();
const repos = starred.map(normalizeRepo);
const groups = groupByLanguage(repos);

await writeFile('data.json', `${JSON.stringify(groups, null, 2)}\n`);
await writeFile('README.md', renderReadme(groups, repos));

console.log(`Generated ${repos.length} starred repositories across ${Object.keys(groups).length} languages.`);
