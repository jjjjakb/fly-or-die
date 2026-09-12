# FLY OR DIE 🪰

> **"I turned a fruit fly's brain wiring into a boss fight. You get 10 shots. Can you beat it?"**

A single-page arcade game and science demo built around the **MCNS — the male adult *Drosophila*
central nervous system connectome** published on **3 September 2026** by HHMI Janelia, the MRC
Laboratory of Molecular Biology, the University of Cambridge and Google Research.

**Play:** open `index.html` (or the hosted link). Mouse/finger to aim, click/tap or `Space` to fire,
`R` to restart, `M` to mute.

---

## The game

You are a fixed turret with **10 darts**. The fly has **3 HP**. Aiming straight at it will not work —
the fly detects your dart's looming approach and commits to an escape burst. Your job is to out-think
the reflex:

1. **Bait it.** Fire once to trigger the dodge.
2. **Punish the recovery.** Every escape leaves the fly *winded* (dashed amber ring, `WINDED — HIT IT NOW`).
   It cannot dodge again for a short window. Hit it then.
3. **Fatigue it.** Repeated near-misses *habituate* the escape relay — the fly reacts later and dodges
   weaker. A hit re-sensitises it, so don't waste your opening.

## The simulation

`neural.js` is a real leaky-integrate-and-fire spiking network (≈70 neurons, ≈360 synapses, 1 ms
timesteps) wired to mirror the published escape pathway:

```
looming detectors (LC4 / LPLC2)
   → local interneurons (LPU / PVLP / AVLP …)
   → descending neurons (DNa / DNb / DNp …)
   → giant fibre (GF)
   → flight + leg motor neurons
```

The pink **GF** node firing is not decoration: that spike is what commits the fly to a dodge in
`game.js`. Synaptic depression + a hard-adapting giant fibre produce **habituation**, and the fly's
idle wander is nudged by its own motor-neuron readout.

> **Honesty note:** this is a compact, biologically-inspired model — **not** a recording or a full
> simulation of the 166,000-neuron connectome. The published figures quoted on the page are the real
> ones, with links to the source data.

## Running locally

No build step, no dependencies. Any static server works:

```bash
python3 -m http.server 8123
# then open http://localhost:8123/
```

## Deploy to Cloudflare Pages

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jjjjakb/fly-or-die)

**Option A — one-click (Git-connected, auto-deploys on push)**

Click the button above, or in the Cloudflare dashboard: **Workers & Pages → Create → Pages →
Connect to Git → `jjjjakb/fly-or-die`**, then set:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `bash build.sh` |
| Build output directory | `dist` |

**Option B — direct upload from the CLI**

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./deploy.sh
```

The token needs the **Cloudflare Pages: Edit** permission. `deploy.sh` stages a clean
`dist/` (via `build.sh`) and uploads it with `wrangler pages deploy`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure, hero, arena, science + sources |
| `styles.css` | Neon connectome aesthetic, responsive layout |
| `neural.js` | Spiking network model (giant-fibre escape + habituation) |
| `game.js` | Arena, fly behaviour, darts, HUD, neural visualisation, sharing |
| `og.png` | Social share card |
| `build.sh` | Stages the static site into `dist/` |
| `deploy.sh` | Direct-upload deploy to Cloudflare Pages |
| `wrangler.toml` | Cloudflare Pages project config |
| `_headers` | Cache + security headers for Cloudflare Pages |

## Sources

- Male CNS Connectome portal — <https://male-cns.janelia.org/>
- FlyWire Codex (MCNS) — <https://codex.flywire.ai/?dataset=mcns>
- Janelia project page — <https://www.janelia.org/project-team/flyem/male-cns-connectome>
- Google Research — “A connectomics milestone: Mapping the complete male fruit fly brain” (3 Sep 2026)
- HHMI — “Scientists Complete Full Map of the Fruit Fly Central Nervous System”
- *Cell* — “Sexual dimorphism in the complete connectome of the *Drosophila* male central nervous system”

## Credits / disclaimer

Fan-made science demo. Not affiliated with HHMI Janelia, Google Research, the University of Cambridge
or the MCNS consortium. Published data © the original authors; the interactive simulation is an
independent, biologically-inspired model. Built as a tribute to the completion of the male
*Drosophila* CNS connectome (2026).
