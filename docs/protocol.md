# Protocol reference (v1)

Everything is JSON text frames over two WebSockets. You only need this to write a client for another
engine, or a phone client of your own; the s&box library and the bundled phone page already speak it.

## Game (host) socket

`ws(s)://SERVER/ws/host?v=1[&key=HOST_KEY][&theme=NAME][&maxPlayers=N][&resume=HOST_TOKEN]`

On connect the server sends:

```json
{ "type": "ready", "code": "KQTB", "hostToken": "…", "joinUrl": "https://pad.example.com/KQTB",
  "resumed": false, "maxPlayers": 16, "lobbyOpen": true, "theme": { … }, "players": [ PLAYER… ] }
```

Keep `hostToken`. If the socket drops, reconnect with `resume=<hostToken>` within `HOST_GRACE_SECONDS`
to get the same session back (`resumed: true`, with the current player list). Otherwise you get a new
session. A rejected connection gets `{type:"error", message}` and close code 4003 (bad key) or 4029 (full).

`PLAYER` is `{ id, name, slot, color, badge, avatar, connected }`.

### Server → game

| type | fields | when |
|---|---|---|
| `join` | `player`, `rejoin` | a phone joined (`rejoin: true` if it's a known player coming back) |
| `status` | `id`, `connected` | a phone's connection dropped (`false`) |
| `leave` | `id`, `reason` (`left`/`kicked`) | a player is gone for good |
| `input` | `from`, `el`, `ev`, [`key`, `x`, `y`, `value`, `values`, `held`], `seq`, `t` | phone input; `t` is ms since the session started |
| `pong` | `t` | reply to `ping` |
| `error` | `message`, `about` | a message was rejected |
| `ended` | `message` | the session ended |

### Game → server

`to` is optional on every message: omit or `null` for all players, a player id, or an array of ids.

| type | fields | effect |
|---|---|---|
| `show` | `screen`, `to` | replace the screen. With no `to` it becomes the default for everyone, including later joiners |
| `update` | `id`, `set`, `to` | merge `set` into the element with that `id` (or `"$screen"` for screen fields) |
| `feedback` | `feedback`, `to` | haptic / sound / flash / shake / toast, see below |
| `send` | `data`, `to` | arbitrary data for theme scripts (`PocketPad.onCustom`) |
| `player` | `id`, `color`, `badge`, `avatar` | change a player's colour or badge |
| `theme` | `theme` | change branding: `{use: "name", …overrides}` |
| `lobby` | `open`, `maxPlayers` | open or close joining |
| `kick` | `id`, `reason` | remove a player |
| `end` | `reason` | end the session |
| `ping` | `t` | keep-alive / latency check |

## Screen format

```json
{
  "title": "Race!", "subtitle": "Go go go", "round": "Round 2/5",
  "timer": 30, "timerTicks": true,
  "layout": "stack | row | grid", "scroll": false, "background": "#202",
  "sensors": { "tilt": true | { "range": 35, "interval": 50 }, "shake": true },
  "elements": [ ELEMENT… ]
}
```

Every element: `type`, `id`, `flex`, `color`, `textColor`, `disabled`, `hidden`, `class`. Then:

| type | properties | input (`ev`) |
|---|---|---|
| `text` | `text`, `size` (s/m/l/xl), `align` | |
| `image` | `src`, `fit`, `alt` | |
| `progress` | `value` (0..1), `label` | |
| `spacer` | | |
| `row`, `column` | `children`, `gap` | |
| `button` | `label`, `sublabel`, `icon`, `shape` (rect/round/pill), `haptic`, `sound`, `key` | `down`; `up` with `held` (ms) |
| `dpad` | `diagonals`, `labels`, `haptic` | `down`/`up` with `key` |
| `joystick` | `label`, `floating`, `axis` (x/y), `deadzone`, `interval` | `down`; `move` with `x`,`y` (-1..1, y up); `up` with 0,0 |
| `touchpad` | `label`, `interval` | `down`/`move`/`up` with `x`,`y` (0..1) |
| `swipe` | `label`, `directions`, `minDistance` | `swipe` with `key`, `x`,`y` velocity; `tap` |
| `slider` | `label`, `min`, `max`, `step`, `value`, `vertical`, `showValue` | `change`, `set` with `value` |
| `textinput` | `label`, `placeholder`, `maxLength`, `multiline`, `rows`, `value`, `submitLabel`, `keepOpen`, `allowEmpty` | `submit` with `value` |
| `number` | `label`, `placeholder`, `min`, `max`, `decimals`, `submitLabel`, `keepOpen` | `submit` with numeric `value` |
| `choice` | `options` [{value, label, icon, color, image}], `columns`, `multi`, `submitLabel`, `keepOpen`, `live` | `submit` with `value` (or `values`); `change` with `values` if `live` |
| `drawing` | `width`, `height`, `colors`, `background`, `brush`, `submitLabel`, `clearLabel` | `submit` with PNG data URL `value` |

Sensors send from element `$tilt` (`ev: "tilt"`, `x`, `y`) and `$shake` (`ev: "shake"`, `value` = force).

## Feedback format

```json
{ "haptic": "success" | [50, 30, 50], "sound": "coin", "volume": 1,
  "flash": "#ff0" | "player" | true, "shake": true,
  "toast": "Nice!", "toastColor": "success", "duration": 1.6 }
```

## Phone socket

`ws(s)://SERVER/ws/play?code=KQTB&name=Sam[&token=PLAYER_TOKEN]`

The server answers `welcome` (`code`, `token`, `rejoin`, `id`, `name`, `slot`, `color`, `badge`,
`theme`, `screen`, `status`), then `screen`, `update`, `feedback`, `theme`, `player`, `custom`,
`status` (`message`, null clears it), `pong`, `error`, `ended` (`message`, `reason`:
ended/kicked/replaced). Phones send `{type:"input", el, ev, …}`, `{type:"ping"}` and `{type:"leave"}`.

Store `token` and pass it when reconnecting to come back as the same player, even when the lobby is
closed. Close codes: 4000 replaced by a newer connection, 4001 ended or kicked, 4004 rejected.

## HTTP

| Path | Returns |
|---|---|
| `/` and `/ABCD` | phone page (the second pre-fills the code) |
| `/healthz` | `{ok, version, sessions}` |
| `/api/v1/info` | `{name, version, protocol, hostKeyRequired, defaultTheme, themes, maxPlayers}` |
| `/api/v1/sessions/ABCD` | `{exists, code, lobbyOpen, players, maxPlayers, theme}` or 404 |
| `/api/v1/themes/NAME` | resolved theme JSON |
| `/qr/ABCD.svg`, `/qr/ABCD.png?size=512` | QR code of the join link |
| `/themes/NAME/FILE` | theme assets |
