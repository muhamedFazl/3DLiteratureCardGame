# Literature — 3D Card Game

A browser implementation of **Literature** (Canadian Fish / Authors): six players,
two alternating teams of three, 48 cards, eight half-suits. Rendered in Three.js,
playable against bots offline or with friends over peer-to-peer WebRTC.


---

## Play

- **Play with Bots** — fully offline, five rule-abiding AI opponents.
- **Host a Table** — opens a room; friends on the same Wi-Fi see it listed automatically.
- **Play → Join** — browse tables on your network, or join anywhere with a 4-letter code.

---

## How multiplayer works

There is **no game server**. The deployed page is 100% static.

1. A public **MQTT broker** (over WSS) carries two things only: lobby beacons
   ("a table is forming") and the WebRTC handshake (SDP + ICE).
2. Once peers connect, every game message travels over a direct
   **RTCDataChannel** between the host and each player. The broker sees none of it.
3. The **host is authoritative** — it owns the rules engine and drives the bots.

### "Same network" discovery

Lobby beacons are published to a topic keyed by a hash of your **public IP**.
Everyone behind one router shares that IP, so your friends' tables appear without
anyone typing anything. Nothing about the address itself is ever published — only
a one-way hash.

Caveats worth knowing:

- **Carrier-grade NAT** can put strangers in the same bucket. You'd see their table
  listed; you cannot see or affect their game.
- **IPv6** gives each device its own address, so the bucket is the `/64` prefix.
- If the IP lookup fails, everyone falls back to a shared `global` bucket.
- The **room code** and the *Show all networks* toggle cover every case discovery misses.

### Hidden information

Literature is a hidden-information game, so the host sends each player **only their
own hand**. Public `state` messages carry hand *counts*, never card identities.
Opening devtools as a joining player reveals nothing about anyone else's cards.

The host does hold full state — as the machine running the simulation, it must. A
host could in principle inspect it. Play with people you'd play cards with in person.

### Connectivity limits

Peer connections use public STUN only, with no TURN relay. Same-Wi-Fi connections
are essentially always fine. Across the internet, most home networks work, but a
strict/symmetric NAT or corporate firewall may fail to connect. Adding a TURN
server would close that gap.

---

## Running locally

The code is ES modules, so it needs to be served over HTTP — opening `index.html`
straight off disk will fail on CORS.

```bash
python -m http.server 8777
```

Then visit <http://localhost:8777/>. Append `#debug` to expose a `window.__LIT`
handle for inspection (it exposes only what that client already knows).

---

## Deploying to GitHub Pages

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: Deploy from a branch → `main` / `root`**.
The game will be live at `https://<you>.github.io/<repo>/` in a minute or two.
No build step, no secrets, no server.

---

## Project layout

```
index.html        markup shell + CDN dependencies
styles.css        all styling
src/engine.js     pure rules + bot AI — no DOM, no Three.js
src/view.js       Three.js scene, card meshes, animations
src/ui.js         menu, lobby overlays, HUD, modals
src/net.js        MQTT signalling + WebRTC peer plumbing
src/game.js       authoritative match loop (GameHost)
src/main.js       wiring and app state machine
```

`engine.js` has no dependencies and no side effects, so the rules are
soak-testable on their own. Open **`tests/soak.html`** and hit Run: it plays
hundreds of full bot-vs-bot matches and asserts the invariants — every card dealt
exactly once, no illegal asks, no asking your own teammate, a bot's "certain"
claim is never wrong, cards conserved (hands + claimed sets == 48), scores match
sets declared, and no claimed card lingers in a hand.

---

## Rules implemented

- 48 cards: a standard deck minus the four 8s, split into 8 half-suits of 6
  (minor 2–7 and major 9–A of each suit).
- Seats alternate teams: 0/2/4 Blue, 1/3/5 Red.
- **Asking** — you must hold at least one card of the half-suit, must not hold the
  card you name, and must ask an opponent who still has cards. Hit keeps your turn;
  miss passes it to them.
- **Declaring** — name the holder of all six cards across your team. All six right
  scores for you; one wrong scores for them. Either way the set leaves play.
- A player with no cards can't be asked, and their turn slides to a teammate.
- First team past four half-suits wins.

## Bot AI

Bots reason from **publicly observable information only** — who asked for what, and
what that implies — never from hidden hands. On top of that they run a deductive
closure: empty hands hold nothing; a card excluded from five seats sits at the
sixth; when a player's known cards equal their hand size, everything else is
excluded. A bot declares only when all six locations are certain, and falls back to
a best-guess declaration when it has no legal ask left.

## Credits

Three.js r128, TWEEN.js, MQTT.js — all via CDN. No build tooling.
