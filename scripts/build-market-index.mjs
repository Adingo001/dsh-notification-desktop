// Builds market/index.json: the format-1 plugin market index for this bundle.
//
//   $env:ELECTRON_RUN_AS_NODE = 1
//   & "D:\ai\DeepSeek Harness.exe" scripts\build-market-index.mjs [commit]
//
// The commit defaults to HEAD and must be a full 40-hex SHA that contains the
// package as published: market install targets are commit-pinned
// (`git+https://…git#<commit>`), so a moving branch would be a supply-chain hole.
// Existing versions are kept, so one index file accumulates releases.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const OWNER = 'Adingo001'
const REPO = 'dsh-notification-desktop'
const REPO_URL = `https://github.com/${OWNER}/${REPO}`

const commit = (process.argv[2] ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).trim()
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`not a full commit SHA: ${commit}`)

const indexPath = join(root, 'market', 'index.json')
let previousVersions = []
try {
  previousVersions = JSON.parse(readFileSync(indexPath, 'utf8')).plugins?.[0]?.versions ?? []
} catch {
  /* first build */
}

const version = {
  version: pkg.version,
  publishTimestamp: Math.floor(Date.now() / 1000),
  source: { type: 'git', url: REPO_URL, commit },
  engines: { dsh: '>=0.2.0 <0.3.0' },
}

const versions = [...previousVersions.filter(entry => entry.version !== version.version), version]

const index = {
  format: 1,
  title: { en: 'dsh-notification-desktop', zh: '完成提醒' },
  description: {
    en: 'Turn-finished desktop notifications for DeepSeek Harness 0.2.x, with a settings page.',
    zh: 'DeepSeek Harness 0.2.x 的「一轮跑完就弹通知」插件，带设置页。',
  },
  metadata: {
    categories: {
      notifications: { title: { en: 'Notifications', zh: '通知提醒' } },
    },
    labels: {
      windows: { title: { en: 'Windows', zh: 'Windows' } },
      desktop: { title: { en: 'Desktop shell', zh: '桌面端' } },
      zeroDependency: { title: { en: 'No dependencies', zh: '零依赖' } },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Completion reminders', zh: '完成提醒' },
      description: {
        en: 'Posts a desktop notification when a session finishes a turn, filtered by how it ended. Host projection plus a WinRT toast on the desktop shell.',
        zh: '会话跑完一轮就弹系统通知，可按结束原因过滤。Host 侧会话投影 + 桌面端 WinRT toast。',
      },
      icon: 'icon.svg',
      author: OWNER,
      homepage: REPO_URL,
      repository: { url: REPO_URL },
      metadata: {
        category: 'notifications',
        keywords: ['notification', 'toast', 'reminder', 'turn', 'desktop', 'windows', '通知', '提醒'],
        labels: ['windows', 'desktop', 'zeroDependency'],
      },
      versions,
    },
  ],
}

mkdirSync(join(root, 'market'), { recursive: true })
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
copyFileSync(join(root, 'icon.svg'), join(root, 'market', 'icon.svg'))
console.log(`market/index.json: ${pkg.name}@${pkg.version} -> ${commit}`)
for (const entry of versions) console.log(`  ${entry.version}  ${entry.publishTimestamp}  ${entry.source.commit.slice(0, 7)}`)
