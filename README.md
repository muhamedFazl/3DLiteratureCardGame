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

### Reconnecting

A player who drops out mid-match (closed tab, crash, lost Wi-Fi) has their seat
held open for 10 minutes while a bot plays it. Reopening the game offers to put
them back. The credential is the client'''s own `peerId` — a random value stored
locally and known only to that browser and the host — so a seat cannot be claimed
by anyone else. Quitting deliberately clears it; the host is not covered, since
the host IS the game.

Mobile browsers freeze a backgrounded tab instead of unloading it, so the peer
connection dies while the page lives on. The client therefore also recovers on
`visibilitychange`: coming back to a dead channel is treated as a dropout and
the rejoin offer appears without needing a reload. Departures are announced on
`pagehide` as well as `beforeunload` (mobile often skips the latter) over MQTT,
which still works when WebRTC is gone — so the host holds the seat at once
rather than after an ICE timeout.

### Playing across different networks

Two things have to work, and they fail independently.

**Finding the table.** Beacons are published per network bucket, so a friend on
other Wi-Fi will not see your table in the list. That is what the room code is
for: entering a code searches *every* bucket, not just your own. The *Show tables
on other networks* toggle does the same for browsing.

**Connecting.** Signalling goes through the public broker and is unaffected by
distance. The peer connection is the fragile part: it uses public STUN with no
TURN relay configured. STUN lets two peers punch a hole through most home
routers, but a **symmetric NAT** hands out a different port per destination, so
the address STUN reports is not the one the other peer must send to and the
punch fails. In practice:

- Same Wi-Fi — essentially always works.
- Home broadband to home broadband — usually works.
- **Mobile data on either side — often fails.** Carriers commonly use CGNAT with
  symmetric NAT.
- Corporate/university networks — often blocked outright.

**Diagnosing a failure.** Open `tests/netcheck.html` on each device that cannot
connect and press Run. It checks WebRTC locally, checks the broker, then asks two
different STUN servers for your public address. If they report the **same IP but
different ports**, you are behind a symmetric NAT: hole punching cannot work, and
that is a property of the network rather than of this code.

**Fixing it: TURN.** A relay is the only thing that gets past a symmetric NAT,
because both peers can always reach it outbound. ICE falls back to it only when
no direct path exists, so it costs nothing when peer-to-peer already works, and a
relay never sees the game: data channels are DTLS-encrypted end to end.

There is deliberately **no default relay**. Every free public TURN server either
no longer exists or now requires an account — the once-standard Open Relay
credentials were tested here and produce zero relay candidates. Shipping dead
credentials is worse than shipping none, because the game then fails silently
instead of explaining itself. Set one of the two options in the ICE configuration
block at the top of `src/net.js`:

- `TURN_SERVERS` — fixed credentials, for self-hosted coturn or any static account.
- `TURN_FETCH_URL` — an endpoint returning a JSON array of `RTCIceServer` objects,
  for providers that issue short-lived credentials. Fetched once at startup.

Then re-run `tests/netcheck.html`. Its relay test forces
`iceTransportPolicy: 'relay'`, discarding all direct paths, so it only passes if
the relay genuinely carries traffic. Nothing else about the architecture changes:
still no game server, still static hosting.

Anything in a static page is public, so prefer a provider issuing short-lived
credentials, or a relay you can rate-limit.

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
- Seats alternate teams: 0/2/4 Blue, 1/3/5 Red. The host assigns teams in the
  lobby by moving people between seats (tap one seat, tap another to swap) — so
  the sides are always 3v3 by construction, and bots fill whatever is left.
- **Asking** — you must hold at least one card of the half-suit, must not hold the
  card you name, and must ask an opponent who still has cards. Hit keeps your turn;
  miss passes it to them.
- **Declaring** — name a half-suit. You do NOT say who holds what: every teammate
  automatically surrenders whatever they hold of it. If your team holds all six
  between you, you score; if even one is with an opponent, they do. Either way the
  set leaves play.
- A player with no cards can't be asked, and their turn slides to a teammate.
- First team past four half-suits wins.

## Bot AI

Bots reason from **publicly observable information only** — who asked for what, and
what that implies — never from hidden hands. On top of that they run a deductive
closure: empty hands hold nothing; a card excluded from five seats sits at the
sixth; when a player's known cards equal their hand size, everything else is
excluded. A bot declares only when it is certain all six cards sit somewhere on its own
team, and falls back to a best-guess declaration when it has no legal ask left.

## Credits

Three.js r128, TWEEN.js, MQTT.js — all via CDN. No build tooling.
