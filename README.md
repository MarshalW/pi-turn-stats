# @marshal/pi-turn-stats

A pi extension that automatically tracks per-exchange duration, token usage (input / output / cache read / cache write), and cost after every conversation turn.

## Features

- **Stats card in conversation stream** — After each reply, a stats card is appended to the stream (does not enter LLM context).
- **Real-time status bar** — The bottom status bar shows the last exchange's duration, throughput, token count, and cost.
- **`/turnstats` command** — Appends a session cumulative stats card (total exchanges, total LLM calls, total tokens, total cost).
- **Auto i18n** — UI labels automatically switch between Chinese and English based on your system locale (`LANG` / `LC_ALL` / `Intl`).

## Demo

![Turn Stats Demo](https://raw.githubusercontent.com/MarshalW/pi-turn-stats/main/turn-stats.gif)

## Screenshots

**Chinese (default)**

![Turn Stats](https://raw.githubusercontent.com/MarshalW/pi-turn-stats/v0.1.2/turn-stats.jpg)

**English (auto-detected from `LANG=en`)**

![Turn Stats EN](https://raw.githubusercontent.com/MarshalW/pi-turn-stats/main/turn-stats_en.png)

## Installation

**Recommended**: Install via npm for stable access and install statistics.

```bash
# Install directly with pi
pi install npm:@marshal/pi-turn-stats
```

Or standard npm install:

```bash
npm install -g @marshal/pi-turn-stats
```

> Note: `pi install npm:...` registers the extension globally. Plain `npm install -g` only downloads the package without registering it as a pi extension.

**Alternative**: Install from GitHub (for source access or custom modifications).

```bash
# Install from GitHub repo (SSH)
pi install git:git@github.com:MarshalW/pi-turn-stats
```

> Users in China are encouraged to use the npm method, as GitHub access may be unreliable.

## Notes

Statistics are **stored locally only** and are not uploaded to any server. Data is read from the running pi process's `turn_end` events and wall-clock timing.

## Development

```bash
git clone git@github.com:MarshalW/pi-turn-stats.git
cd pi-turn-stats
pi install ./        # local install for testing
```

## Release Process

```bash
git tag vX.Y.Z && git push origin main --tags
# Publish to npm: npm version patch && npm publish --access public
# Consumer install:
#   npm (recommended): pi install npm:@marshal/pi-turn-stats
#   git (fallback):    pi install git:git@github.com:MarshalW/pi-turn-stats@vX.Y.Z
```
