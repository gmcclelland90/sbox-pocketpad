# s&box library guide

Namespace `PocketPad`. Everything below is in [`sbox/Code`](../sbox/Code).

## Install

Copy `sbox/` into your game as `Libraries/pocketpad/` with `tools/install-library.ps1` (Windows) or
`tools/install-library.sh`. The editor compiles it alongside your game. Run the script again to update.

s&box only allows plain-HTTP connections to loopback addresses on ports 80, 443, 8080 and 8443, and
blocks raw IP addresses. During development, point the game at `http://localhost:8080` and let phones use
your LAN address (the server works it out, or set `PUBLIC_URL`). In production use an `https://` domain.

## Starting a session

The easy way is the **PocketPad Host** component (`PadHost`): add it to a GameObject, set **Server Url**,
optionally **Theme**, **Max Players**, **Host Key**, **Send Auth Token** (for servers that set
`SBOX_AUTH`, see [self-hosting](self-hosting.md#sbox-auth-tokens)) and **Rejoin By Name** (a phone back without its
saved token, e.g. after clearing its browser, takes back its disconnected player of the same name). It connects on play, calls `Poll()` every frame and
ends the session when destroyed. From your own component:

```csharp
protected override void OnStart()
{
	Components.Get<PadHost>().OnSession( session =>
	{
		session.Ready += resumed => { /* session.Code, session.JoinUrl, session.QrCodeUrl are set */ };
		session.PlayerJoined += OnPlayerJoined;
		session.Input += OnPadInput;
	} );
}
```

`PadHost.Current` gives you the active host from anywhere. In a networked game only the host runs a session.

Without the component:

```csharp
var session = new PadSession( "http://localhost:8080", new PadSessionOptions { Theme = "paper", MaxPlayers = 8 } );
await session.Start();
// every frame:
session.Poll();
// when done:
session.Dispose();
```

All events are raised inside `Poll()`, on your thread, so it's safe to touch the scene from handlers.

## Showing the join info

| Property | Example | Use |
|---|---|---|
| `Code` | `KQTB` | Big on the TV |
| `JoinHost` | `192.168.1.20:8080` | "Go to ... on your phone" |
| `JoinUrl` | `http://192.168.1.20:8080/KQTB` | Opens with the code filled in |
| `QrCodeUrl` | `http://localhost:8080/qr/KQTB.png` | `<img src=...>` in Razor UI; phones scan it |

## Screens

A `PadScreen` is what a phone shows at one moment: title, subtitle, optional countdown and a list of
controls. Build a fresh one whenever the moment changes (lobby, each microgame, results) and show it:

```csharp
session.Show( screen );                    // everyone (and anyone who joins later)
session.Show( screen, player );            // one player
session.Show( screen, teamRed );           // a list of players
player.Show( screen );                     // same as above
```

Screen options: `Title`, `Subtitle`, `Round` (small top-bar text), `Timer` (seconds, the phone counts
down and ticks for the last three), `Layout` (`"stack"` default, `"row"` for side by side, `"grid"`),
`Scroll` (for forms and drawing), `Background` (CSS), `Tilt`, `TiltRange`, `Shake`, and `InputDelay` (seconds the phone
ignores taps after the screen appears, so a leftover tap from the last screen can't hit a new button; up to 3).

Elements stack top to bottom and interactive ones grow to fill the screen. Use `Flex` to change the
share of space, and `PadRow` / `PadColumn` to nest:

```csharp
new PadScreen( "Fight!" ) { Layout = "row" }.Add(
	Pad.Joystick( "move" ),
	Pad.Column(
		new PadButton { Id = "punch", Label = "👊", Shape = "round", Color = "#e8574f" },
		new PadButton { Id = "block", Label = "Block", Flex = 0.5f } ) );
```

Every element has `Id`, `Flex`, `Color` and `TextColor` (any CSS colour, or `"player"`, `"accent"`,
`"danger"`, `"success"`), `Disabled`, `Hidden`, `Class` (CSS class for themes) and `Extra` (any other
properties, for custom controls).

## Controls and their input

| Element | Factory | Events (`PadInputKind`) | Data |
|---|---|---|---|
| `PadButton` | `Pad.Button(id, label, color)` | `Down` on touch, `Up` on release | `HeldSeconds` on Up, `Key` if set |
| `PadDpad` | `Pad.Dpad(id)` | `Down` / `Up` per direction | `Key` = up/down/left/right |
| `PadJoystick` | `Pad.Joystick(id)` | `Down`, `Move` (~30/s), `Up` | `X`, `Y` in -1..1, Y up |
| `PadTouchpad` | `Pad.Touchpad(id)` | `Down`, `Move`, `Up` | `X`, `Y` in 0..1 from top-left |
| `PadSwipe` | `Pad.Swipe(id)` | `Swipe`, `Tap` | `Key` = direction, `X`/`Y` = velocity |
| `PadSlider` | `Pad.Slider(id, min, max, step)` | `Change` while dragging, `Set` on release | `Number` |
| `PadTextInput` | `Pad.TextInput(id, label)` | `Submit` | `Value` |
| `PadNumberInput` | `Pad.Number(id, label)` | `Submit` | `Number` (and `Value`) |
| `PadChoice` | `Pad.Choice(id, "A", "B")` | `Submit` on tap (or after Done with `Multi`) | `Value`, or `Values` for multi |
| `PadDrawing` | `Pad.Drawing(id, w, h)` | `Submit` | `Value` = PNG data URL |
| `PadText`, `PadImage`, `PadProgress`, `PadSpacer` | `Pad.Text(...)` etc. | none | display only |
| sensors | `screen.Tilt = true`, `screen.Shake = true` | `Tilt` from `"$tilt"`, `Shake` from `"$shake"` | `X`, `Y` in -1..1 |
| custom | `new PadCustom("dial", props)` | whatever the theme script sends | |

Text, number, choice and drawing lock after sending (set `KeepOpen` to allow more answers).

Buttons fire `Down` the instant the screen is touched, which is what reaction games want. Use `Up` and
`HeldSeconds` for hold-to-charge.

### Reading input as events

```csharp
void OnPadInput( PadInput input )
{
	if ( input.Is( "answer", PadInputKind.Submit ) ) CheckAnswer( input.Player, input.Value );
	if ( input.Is( "mash", PadInputKind.Down ) ) Score[input.Player]++;
}
```

`PadInput` also carries `ReceivedAt` (`PadClock.Now` when it arrived, before frame queuing) for fair
reaction timing, and `Sequence` per player.

### Reading input by polling

Each `PadPlayer` keeps the latest state:

```csharp
foreach ( var p in session.Players )
{
	Vector2 move = p.Stick( "move" );            // joystick, zero when released
	Vector2 dir = p.Dpad( "dpad" );              // d-pad as a vector
	Vector2? aim = p.Touch( "aim" );             // touchpad, null when not touching
	bool charging = p.IsDown( "charge" );
	bool jumped = p.WasPressed( "jump" );        // true for the one Poll() it happened in
	Vector2 tilt = p.Tilt;
	double? volume = p.Number( "volume" );       // latest slider value
}
```

State clears when you show that player a new screen.

## Live updates

Change one element without redrawing (uses the JSON property names, camelCase):

```csharp
session.Update( "power", new { value = 0.75f, label = "75%" }, player );
session.Update( "go", new { disabled = false, label = "GO!" } );
session.Update( "hint", new { hidden = true } );
session.UpdateScreen( title: "Faster!", timer: 5 );
```

Phones that reconnect get the updated state.

## Feedback

```csharp
player.Feedback( PadFeedback.Good( "Correct!" ) );   // sound + haptic + green flash + toast
player.Feedback( PadFeedback.Bad( "Too slow" ) );    // fail sound, error buzz, red flash, shake
session.Feedback( new PadFeedback { Sound = "go", Toast = "GO!", Flash = "#ffd23f" } );
session.Feedback( new PadFeedback { HapticPattern = new[] { 50, 50, 50, 50, 300 } }, loser );
```

Built-in sounds (synthesised on the phone, no files): `tap`, `click`, `pop`, `tick`, `coin`, `success`,
`fail`, `buzz`, `go`, `whoosh`, `countdown`. Themes can add or replace sounds with files.
Haptic presets: `tap`, `light`, `medium`, `heavy`, `press`, `success`, `error`, `warning`, `buzz`, `long`.
Vibration works on Android browsers; iPhones ignore it.

## Players

`PadPlayer`: `Id` (stable for the session, survives refreshes), `Name` (unique within the session),
`Slot` (join order), `ColorHex` / `Color` (assigned from a 16-colour palette), `Badge`, `IsConnected`,
and `Tag` for your own data.

```csharp
player.SetColor( Color.Orange );     // their name chip and "player"-coloured controls follow
player.SetBadge( "👑" );
session.Kick( player, "Be nice!" );
session.SetLobbyOpen( false );       // no new joins mid-round; existing players can still reconnect
```

Events: `PlayerJoined`, `PlayerReconnected`, `PlayerDisconnected` (still in the game, may come back),
`PlayerLeft` (gone for good), `Input`, `Ready(bool resumed)`, `Ended(reason)`, `Error(message)`.

## Branding

Pick a server theme with `PadHost.Theme` / `PadSessionOptions.Theme`, or override at runtime:

```csharp
session.SetTheme( new PadTheme
{
	Use = "paper",
	Title = "Paper Party",
	Colors = new() { ["accent"] = "#e8574f", ["bg"] = "#f5eedc" },
	Text = new() { ["joinButton"] = "Let's go!" },
} );
```

See [theming.md](theming.md) for everything a theme can do, including custom controls.

## Connection behaviour

- If the game loses the server, the session keeps running on the server for `HOST_GRACE_SECONDS`
  (2 minutes by default) and the library reconnects to it. Messages sent while offline are queued.
- If it comes back too late, `Ready(false)` fires with a new code and the old players are reported as left.
- `Dispose()` (or destroying the `PadHost`) ends the session; phones go back to the join page with a message.
