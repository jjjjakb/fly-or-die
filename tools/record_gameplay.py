"""Record real gameplay of FLY OR DIE for social media.

Drives the page with genuine mouse events (so the crosshair, dart trails and
neural activity all render naturally), plays a bait-and-punish match, and lets
Playwright capture 1280x720 video. Selects the best take afterwards.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
TAKES = "/tmp/flytakes"
URL = "http://127.0.0.1:8123/?debug"
W, H = 1280, 720
SCROLL_Y = 1000

READ = """() => {
  const g = window.__flyGame, n = performance.now();
  const r = document.getElementById('arenaCanvas').getBoundingClientRect();
  return {phase:g.phase, hp:g.hp, shots:g.shots, hits:g.hits, gf:g.gfCount,
          GW:g.W, GH:g.H,
          fx:g.fly.x, fy:g.fly.y, fvx:g.fly.vx, fvy:g.fly.vy,
          esc:g.fly.escapeUntil - n, wind:g.fly.windedUntil - n,
          rx:r.left, ry:r.top, rw:r.width, rh:r.height};
}"""


def state(page):
    return page.evaluate(READ)


class Mouse:
    def __init__(self, page):
        self.page = page
        self.x, self.y = W / 2, H / 2

    def glide(self, x, y, steps=9, pause=0.011):
        x = max(4, min(W - 4, x))
        y = max(4, min(H - 4, y))
        for i in range(1, steps + 1):
            t = i / steps
            self.page.mouse.move(self.x + (x - self.x) * t, self.y + (y - self.y) * t)
            time.sleep(pause)
        self.x, self.y = x, y

    def click(self, x, y):
        self.glide(x, y)
        self.page.mouse.down()
        time.sleep(0.03)
        self.page.mouse.up()

    def snap(self, x, y):
        """Fast click: aiming must happen within the fly's winded window."""
        x = max(4, min(W - 4, x))
        y = max(4, min(H - 4, y))
        self.page.mouse.move(x, y, steps=3)
        self.page.mouse.down()
        self.page.mouse.up()
        self.x, self.y = x, y


def fire_at(page, mouse, s, lead=0.0):
    gx = s["fx"] + s["fvx"] * lead
    gy = s["fy"] + s["fvy"] * lead
    cx = s["rx"] + gx * (s["rw"] / s["GW"])
    cy = s["ry"] + gy * (s["rh"] / s["GH"])
    mouse.snap(cx, cy)


def play_match(page, mouse, log):
    """One bait-and-punish match. Returns outcome stats."""
    for _ in range(6):
        s = state(page)
        if s["phase"] != "playing" or s["shots"] <= 0 or s["hp"] <= 0:
            break

        fire_at(page, mouse, s)                      # bait -> triggers escape
        started = False
        for _ in range(30):
            time.sleep(0.025)
            s = state(page)
            if s["esc"] > 0 or s["wind"] > 0:
                started = True
            if started and s["esc"] < 0:
                break
        if s["phase"] != "playing":
            break

        time.sleep(0.05)                             # earliest part of the winded window
        s = state(page)
        if s["phase"] != "playing" or s["shots"] <= 0:
            break
        hp_before = s["hp"]
        fire_at(page, mouse, s, lead=0.05)           # punish
        time.sleep(0.13)
        s = state(page)
        # a hit leaves the fly slow and reeling: cash in with a straight shot
        if (s["hp"] < hp_before and s["phase"] == "playing"
                and s["shots"] > 0 and s["hp"] > 0):
            fire_at(page, mouse, s, lead=0.0)
            time.sleep(0.16)
        time.sleep(0.42)

    time.sleep(0.4)
    return state(page)


def record_take(idx):
    os.makedirs(TAKES, exist_ok=True)
    out = {"take": idx, "errors": []}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": W, "height": H},
            device_scale_factor=1,
            record_video_dir=TAKES,
            record_video_size={"width": W, "height": H},
        )
        page = ctx.new_page()
        page.on("pageerror", lambda e: out["errors"].append(str(e)))
        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_timeout(1400)
        # the page uses CSS smooth scrolling, which breaks scripted scroll animations
        page.evaluate("document.documentElement.style.scrollBehavior='auto'")

        # 1) hold on the hero (its own title reads as a title card)
        page.evaluate("window.scrollTo(0,0)")
        page.wait_for_timeout(2200)

        # 2) glide down to the arena
        page.evaluate("""(y) => {
            const start = scrollY, t0 = performance.now(), dur = 900;
            (function step(t){
              const k = Math.min(1, (t - t0) / dur);
              const e = k<.5 ? 2*k*k : -1+(4-2*k)*k;
              scrollTo(0, start + (y - start) * e);
              if (k < 1) requestAnimationFrame(step);
            })(t0);
        }""", SCROLL_Y)
        page.wait_for_timeout(1300)
        if abs(page.evaluate("() => scrollY") - SCROLL_Y) > 4:
            page.evaluate("(y) => scrollTo(0, y)", SCROLL_Y)
            page.wait_for_timeout(250)

        # 3) press FIGHT THE FLY with a real click
        mouse = Mouse(page)
        box = page.locator("#btnStart").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        mouse.glide(cx, cy)
        time.sleep(0.2)
        page.locator("#btnStart").click()
        page.wait_for_timeout(250)
        if page.evaluate("() => window.__flyGame.phase") != "playing":
            page.evaluate("() => window.__flyStart()")   # safety net
            page.wait_for_timeout(250)

        # 4) play
        fin = play_match(page, mouse, out)
        out.update(hp_end=fin["hp"], hits=fin["hits"], shots_left=fin["shots"],
                   gf=fin["gf"], phase=fin["phase"], win=fin["hp"] <= 0)

        # 5) hold on the result card
        page.wait_for_timeout(4600)

        ctx.close()   # flush video
        browser.close()

    vids = sorted(glob.glob(os.path.join(TAKES, "*.webm")), key=os.path.getmtime)
    if vids:
        dst = os.path.join(TAKES, f"take_{idx:02d}.webm")
        shutil.move(vids[-1], dst)
        out["video"] = dst
        out["seconds"] = round(probe_seconds(dst), 2)
    print(json.dumps(out), flush=True)
    return out


def probe_seconds(path):
    ff = None
    try:
        import imageio_ffmpeg
        ff = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        ff = shutil.which("ffmpeg")
    if not ff:
        return 0.0
    r = subprocess.run([ff, "-i", path], capture_output=True, text=True)
    for line in r.stderr.splitlines():
        if "Duration:" in line:
            t = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = t.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    shutil.rmtree(TAKES, ignore_errors=True)   # wipe once per batch, not per take
    results = []
    for i in range(n):
        results.append(record_take(i))
    with open(os.path.join(TAKES, "results.json"), "w") as f:
        json.dump(results, f, indent=2)
    wins = [r for r in results if r.get("win")]
    print("\n=== %d/%d takes won ===" % (len(wins), len(results)))
    for r in results:
        print(r["take"], "win" if r.get("win") else "loss", "hits", r.get("hits"),
              "shots_left", r.get("shots_left"), "gf", r.get("gf"), "s", r.get("seconds"))
