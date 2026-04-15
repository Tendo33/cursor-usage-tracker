# Cursor Usage Tracker

<p align="center">
  <strong>A small VS Code / Cursor extension that shows your Cursor request usage in the status bar.</strong><br>
  Read your quota at a glance, hover for details, and stop guessing how close you are to the monthly limit.
</p>

<p align="center">
  <a href="README_CN.md"><img src="https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-0F172A?style=for-the-badge" alt="Chinese README"></a>
  <img src="https://img.shields.io/badge/Platform-Cursor%20%7C%20VS%20Code-2563EB?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Platform">
  <img src="https://img.shields.io/badge/Version-1.0.3-16A34A?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/License-MIT-EAB308?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/SQLite-2GiB%2B%20Fallback-7C3AED?style=for-the-badge" alt="Large SQLite fallback">
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/Quick_Start-5_Minutes-2563EB?style=flat-square" alt="Quick Start"></a>
  <a href="#screenshots"><img src="https://img.shields.io/badge/Screenshots-Reserved-16A34A?style=flat-square" alt="Screenshots"></a>
  <a href="#how-it-works"><img src="https://img.shields.io/badge/How_It_Works-Transparent-0F766E?style=flat-square" alt="How It Works"></a>
  <a href="#troubleshooting"><img src="https://img.shields.io/badge/Troubleshooting-Included-F97316?style=flat-square" alt="Troubleshooting"></a>
</p>

This project is for people who use Cursor heavily and keep checking whether they still have room in the month. Instead of opening logs, guessing, or waiting until requests start failing, you get a simple status bar indicator such as `🟢 120/500`, plus a hover card with requests, token usage, and the next reset date.

> [!IMPORTANT]
> This extension is not an official Cursor integration. It reads local Cursor data on your machine, then requests usage data from `https://cursor.com/api/usage`.

## Contents

- [Cursor Usage Tracker](#cursor-usage-tracker)
  - [Contents](#contents)
  - [Screenshots](#screenshots)
  - [Why this exists](#why-this-exists)
  - [Highlights](#highlights)
  - [Quick start](#quick-start)
    - [Option 1: install from VSIX](#option-1-install-from-vsix)
    - [Option 2: run in development mode](#option-2-run-in-development-mode)
  - [What you will see](#what-you-will-see)
  - [Configuration](#configuration)
  - [How it works](#how-it-works)
  - [Storage paths](#storage-paths)
    - [User ID lookup](#user-id-lookup)
    - [Access token lookup](#access-token-lookup)
  - [Troubleshooting](#troubleshooting)
    - [It shows `No ID`](#it-shows-no-id)
    - [It shows `Failed`](#it-shows-failed)
    - [Large database fallback does not work](#large-database-fallback-does-not-work)
  - [Project structure](#project-structure)
  - [Development](#development)
  - [Changelog](#changelog)
    - [1.0.3](#103)
    - [1.0.2](#102)
    - [1.0.1](#101)
  - [License](#license)

## Screenshots

![Main status bar view](assets/main-status-bar.png)


## Why this exists

Cursor users usually notice quota problems too late. By the time you realize something is off, you are already close to the limit or out of it. This extension keeps the number visible where it belongs: in the editor, all the time, without asking you to dig through config files or browser tabs.

It is also built for the less pleasant edge case that shows up on long-lived machines: oversized `state.vscdb` files. Starting with `1.0.2`, the extension can fall back to Python's `sqlite3` when Node.js hits the `ERR_FS_FILE_TOO_LARGE` limit on databases at or above 2 GiB.

## Highlights

- Status bar usage indicator with traffic-light levels
- Hover tooltip with requests, token usage, and reset time
- Automatic refresh every 5 minutes by default
- Local user ID discovery across Windows, macOS, and Linux paths
- Automatic access token lookup from Cursor's SQLite storage
- Large database fallback for `state.vscdb >= 2 GiB`
- Simple settings, no extra service or dashboard required

## Quick start

### Option 1: install from VSIX

Build the extension:

```bash
npm install
npm run compile
npm run package
```

This generates a file like `cursor-usage-tracker-1.0.3.vsix` in the project root.

Then install it in Cursor or VS Code:

1. Open the command palette with `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on macOS.
2. Run `Extensions: Install from VSIX...`.
3. Select the generated `.vsix` file.
4. Restart the editor if needed.

### Option 2: run in development mode

```bash
git clone https://github.com/Tendo33/cursor-usage-tracker.git
cd cursor-usage-tracker
npm install
npm run compile
```

Then press `F5` in VS Code or Cursor to launch an Extension Development Host.

## What you will see

After the extension starts, the status bar may show one of the following states:

- `🟢 120/500`: low usage
- `🟡 260/500`: medium usage
- `🔴 410/500`: high usage
- `$(sync~spin) Loading...`: fetching data
- `$(warning) No ID`: user ID could not be found locally
- `$(error) Failed`: the API request failed

Hovering the item shows a compact summary with:

- used requests
- total request limit
- token usage in millions
- estimated days until reset

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `cursorUsageTracker.refreshInterval` | `number` | `300` | Auto refresh interval in seconds |
| `cursorUsageTracker.showInStatusBar` | `boolean` | `true` | Whether to show the indicator in the status bar |

Example:

```json
{
  "cursorUsageTracker.refreshInterval": 180,
  "cursorUsageTracker.showInStatusBar": true
}
```

## How it works

The extension does three practical things:

1. It looks for your Cursor user ID in local storage files, with the newer `sentry` paths checked first.
2. It reads `cursorAuth/accessToken` from Cursor's `state.vscdb`.
3. It calls the usage endpoint and renders the result in the status bar.

Request shape:

```text
GET https://cursor.com/api/usage?user={userId}
Cookie: WorkosCursorSessionToken={userId}%3A%3A{accessToken}
```

For normal-sized databases, the extension uses `sql.js`. If the SQLite file is too large for `readFileSync`, it automatically falls back to Python:

- Windows: tries `python`, then `py`, then `python3`
- macOS / Linux: tries `python3`, then `python`

## Storage paths

### User ID lookup

- Windows: `%APPDATA%\Cursor\sentry\scope_v3.json`
- Windows: `%APPDATA%\Cursor\sentry\session.json`
- Windows legacy: `%APPDATA%\Cursor\User\globalStorage\storage.json`
- macOS: `~/Library/Application Support/Cursor/sentry/*.json`
- Linux: `~/.config/Cursor/sentry/*.json`

### Access token lookup

- Windows: `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
- macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Linux: `~/.config/Cursor/User/globalStorage/state.vscdb`

## Troubleshooting

### It shows `No ID`

The extension could not find a valid `user_*` identifier in local Cursor data. In practice, this usually means one of three things:

- Cursor has not completed login on this machine
- the storage path changed in your installation
- the local files exist but do not contain the expected user record

Open the command palette and run the extension's log-view command to inspect the lookup process.

### It shows `Failed`

That means the usage request did not come back with usable data. Common reasons include:

- the access token could not be read from `state.vscdb`
- the local token is stale and refresh did not recover it
- the request format or upstream response changed

### Large database fallback does not work

If your `state.vscdb` is 2 GiB or larger, the extension relies on a local Python interpreter for fallback access. Make sure one of these commands is available on your machine:

- `python`
- `py`
- `python3`

If none of them exists, install Python 3 and refresh again.

## Project structure

```text
cursor-usage-tracker/
├── README.md
├── README_CN.md
├── src/
│   ├── extension.ts
│   └── sql.js.d.ts
├── out/
├── esbuild.mjs
├── package.json
├── test-api.js
└── icon.png
```

## Development

Useful commands:

```bash
npm install
npm run compile
npm run watch
npm run package
```

There is also a local helper script:

```bash
node test-api.js
```

It is useful when you want to inspect user ID discovery, token loading, and the raw API call outside the editor extension runtime.

## Changelog

### 1.0.3

- retry transient TLS/network failures when requesting the Cursor usage API
- add request timeout handling to avoid hanging refresh attempts
- add regression tests for retryable network errors

### 1.0.2

- fixed failures when `state.vscdb >= 2 GiB`
- added Python `sqlite3` fallback for oversized SQLite files
- improved logging and failure handling

### 1.0.1

- initial release

## License

[MIT](LICENSE)
