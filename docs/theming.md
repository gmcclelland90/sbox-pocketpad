# Theming and custom controls

A theme is a folder with a `theme.json` and any files it uses. The server ships `default`, `paper` and
`neon` in [`server/themes`](../server/themes). Add your own by putting folders in the server's
`THEMES_DIR` (`/themes` in Docker; `docker-compose.yml` mounts `./themes`). A folder with the same name
as a built-in theme replaces it, so `/themes/default` rebrands the plain join page too.

Games pick a theme by name (`PadHost.Theme`, or `?theme=` when connecting) and can override parts of it
inline with `session.SetTheme(...)`. Changes to `theme.json` are picked up without restarting.

## Keeping your game's theme in your game

Your theme doesn't need to live in PocketPad. Keep the folder in your game's repo and point the server at it:

```powershell
powershell -ExecutionPolicy Bypass -File tools\start-dev-server.ps1 -ThemesDir C:\path\to\mygame\PhoneThemes -Theme mygame
```

(`THEMES_DIR=/path/to/mygame/PhoneThemes DEFAULT_THEME=mygame tools/start-dev-server.sh` on macOS/Linux, or mount
the folder at `/themes` in Docker.) `THEMES_DIR` can list several folders, separated by `;` on Windows and `:`
elsewhere; when two have a theme of the same name, the later folder wins. A theme folder can carry everything:
`theme.json`, a stylesheet, a script with custom controls, fonts, sounds and images.

Without a server-side folder, a game can still restyle phones from s&box alone with `session.SetTheme(...)`:
colours, font and `FontUrl`, inline `Css`, a `Stylesheet` URL, logo, background, sounds and text, all as `https://`
or `data:` URLs. Only scripts (custom controls) need a theme folder.

## theme.json

```json
{
  "title": "Paper Party",
  "subtitle": "Grab your phone, it's your controller",
  "logo": "logo.svg",
  "hideTitle": true,
  "background": "paper.jpg",
  "colors": {
    "bg": "#f5eedc", "surface": "#fffaf0", "text": "#2b2420", "muted": "#7a6d60",
    "accent": "#e8574f", "accentText": "#ffffff",
    "button": "#fffaf0", "buttonText": "#2b2420", "border": "#d9cbb0",
    "danger": "#c8372d", "success": "#3f9c55"
  },
  "radius": 10,
  "font": "\"Patrick Hand\", sans-serif",
  "fontUrl": "PatrickHand.woff2",
  "stylesheet": "paper.css",
  "css": ".el-button { text-transform: uppercase; }",
  "script": "controls.js",
  "sounds": { "coin": "coin.ogg", "boing": "boing.mp3" },
  "text": {
    "codeLabel": "Room code", "nameLabel": "Your name", "joinButton": "Join",
    "joined": "You're in!", "watch": "Watch the screen.", "reconnecting": "Reconnecting...",
    "ended": "The game has ended.", "cantConnect": "Couldn't connect. Check the code and try again.",
    "needCode": "Enter the 4-letter room code.", "needName": "Enter your name.",
    "motionDenied": "Motion access was blocked. Check your browser settings."
  },
  "poweredBy": false
}
```

Every key is optional. Relative paths (`logo`, `background`, `stylesheet`, `script`, `fontUrl`,
`sounds`) are files in the theme folder, served at `/themes/<name>/<file>`. Absolute `https://` and
`data:` URLs work too.

| Key | Effect |
|---|---|
| `title`, `subtitle` | Join page heading and browser tab title |
| `logo`, `hideTitle` | Image above the join form; `hideTitle` hides the text title when the logo has it |
| `colors` | The palette. `accent` is the primary button colour; each player also gets their own colour (`--player`) |
| `radius` | Corner roundness in px |
| `font`, `fontUrl` | CSS font-family, and an optional font file to load for it |
| `background` | Background image |
| `stylesheet`, `css` | Extra CSS (a file, or inline). Games can also send a `Stylesheet` URL with `SetTheme` |
| `sounds` | Name to sound file. Overrides built-in synth sounds with the same name, or adds new ones for `PadFeedback.Sound` and `PadButton.Sound` |
| `text` | Replace any of the page's words (translations too) |
| `script` | JavaScript that adds custom controls (theme folders only; games can't inject scripts) |
| `poweredBy` | `false` hides "Powered by PocketPad" |

## Styling hooks

The page uses CSS custom properties: `--bg`, `--surface`, `--text`, `--muted`, `--accent`,
`--accent-text`, `--button`, `--button-text`, `--border`, `--danger`, `--success`, `--player`,
`--radius`, `--font`, `--gap`. Each control has classes `.el` and `.el-<type>` (`.el-button`,
`.el-joystick`, ...), plus any `Class` the game sets on it. Pressed controls get `.pressed`, sent forms
get `.sent`. `body[data-theme="<name>"]` and `body[data-screen="join|game"]` are set too.

The [paper theme's stylesheet](../server/themes/paper/paper.css) is a short example of a full restyle.

## Custom controls

A theme `script` can register new control types. The game shows them with `PadCustom`:

```csharp
session.Show( new PadScreen( "Turn it up" ).Add(
	new PadCustom( "dial", new() { ["id"] = "volume", ["steps"] = 12 } ) ) );
```

and the script draws them:

```js
PocketPad.defineElement("dial", (def, ctx) => {
	const node = document.createElement("div");
	// ...build your control, using def.steps etc...
	// send input to the game, tagged with this element's id:
	ctx.send("change", { value: 3 });
	ctx.haptic("light");          // or ctx.sound("pop")
	return {
		node,
		update(set, def) { /* session.Update("volume", new { value = 5 }) lands here */ },
		destroy() { /* screen replaced */ },
	};
});
```

`ctx` has `send(ev, data)`, `haptic(name)`, `sound(name)`, `mount(childDefs, parentNode)` (to render
built-in controls inside yours), `resolveColor(c)`, and `disabled`, `theme`, `me` (the player). Input
data can include `key`, `x`, `y`, `value` (string, number or bool), `values` (string array) and `held`.
For game-to-control data beyond updates, the game calls `session.SendCustom(data)` and the script listens
with `PocketPad.onCustom(fn)`.

[`examples/themes/custom-controls`](../examples/themes/custom-controls) is a working dial. The built-in
controls in [`server/public/elements.js`](../server/public/elements.js) use the same API, so they're
the best reference.

## Trying themes without s&box

```bash
THEMES_DIR=../examples/themes npm start
node tools/demo-host.js --theme custom-controls
```

Open the printed link on your phone and press Enter to step through every control.

## Assets and the jam rules

If your game is in a jam that penalises AI-generated art or audio, keep your theme's logo, images and
sounds hand-made. The built-in sounds are simple synth tones generated in code.
