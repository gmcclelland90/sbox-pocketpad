using PocketPad;

namespace Playground;

/// <summary>
/// PocketPad example: every phone that joins gets a cube to drive around.
/// Press 1-6 on the keyboard to switch every phone to a different controller layout:
///   1 gamepad (joystick + buttons)   2 d-pad   3 mash meter   4 quiz   5 drawing   6 tilt
/// The HUD shows the room code, a QR code and each player's latest input.
/// </summary>
[Title( "Playground Game" ), Category( "PocketPad Example" ), Icon( "sports_esports" )]
public sealed class PlaygroundGame : Component
{
	[Property] public float MoveSpeed { get; set; } = 260f;
	[Property] public float ArenaHalfSize { get; set; } = 230f;

	public static PlaygroundGame Instance { get; private set; }

	/// <summary>Bumped whenever the HUD should redraw.</summary>
	public int Version { get; private set; }

	public string ModeName => Modes[_mode];

	private static readonly string[] Modes = { "Gamepad", "D-pad", "Mash", "Quiz", "Draw", "Tilt" };
	private int _mode;
	private PadSession _session;
	private readonly Dictionary<PadPlayer, Pawn> _pawns = new();
	private readonly Dictionary<PadPlayer, string> _lastInput = new();

	private sealed class Pawn
	{
		public GameObject Object;
		public ModelRenderer Renderer;
		public float Height;
		public float VerticalSpeed;
		public int Mashes;
	}

	public string LastInput( PadPlayer p ) => _lastInput.TryGetValue( p, out var s ) ? s : "joined";

	protected override void OnStart()
	{
		Instance = this;
		var host = PadHost.Current ?? Scene.GetAllComponents<PadHost>().FirstOrDefault();
		if ( host == null )
		{
			Log.Warning( "Add a PocketPad Host component to the scene." );
			return;
		}
		host.OnSession( Hook );
	}

	private void Hook( PadSession session )
	{
		_session = session;
		session.Ready += _ => { ShowMode(); Version++; };
		session.PlayerJoined += OnJoined;
		session.PlayerReconnected += _ => Version++;
		session.PlayerDisconnected += _ => Version++;
		session.PlayerLeft += OnLeft;
		session.Input += OnInput;
		session.Error += e => Log.Warning( $"PocketPad: {e}" );
	}

	private void OnJoined( PadPlayer player )
	{
		var go = new GameObject( true, $"Pawn {player.Name}" );
		var renderer = go.Components.Create<ModelRenderer>();
		renderer.Model = Model.Load( "models/dev/box.vmdl" );
		renderer.Tint = player.Color;
		go.WorldScale = 0.5f;
		go.WorldPosition = new Vector3( Game.Random.Float( -100, 100 ), Game.Random.Float( -100, 100 ), 0 );
		_pawns[player] = new Pawn { Object = go, Renderer = renderer };

		player.SetBadge( $"P{player.Slot}" );
		player.Feedback( new PadFeedback { Toast = $"Hi {player.Name}!", Sound = "coin", Haptic = "success" } );
		Version++;
	}

	private void OnLeft( PadPlayer player )
	{
		if ( _pawns.Remove( player, out var pawn ) ) pawn.Object.Destroy();
		_lastInput.Remove( player );
		Version++;
	}

	private void OnInput( PadInput input )
	{
		if ( input.Kind != PadInputKind.Move && input.Kind != PadInputKind.Tilt ) // too chatty to show
		{
			_lastInput[input.Player] = input.ToString().Substring( input.Player.Name.Length ).Trim();
			Version++;
		}
		if ( !_pawns.TryGetValue( input.Player, out var pawn ) ) return;

		// Event style: react to one-off things here. (Continuous things like sticks are polled in OnUpdate.)
		if ( input.Is( "colour", PadInputKind.Down ) )
		{
			var c = new ColorHsv( Game.Random.Float( 0, 360 ), 0.7f, 0.95f ).ToColor();
			input.Player.SetColor( c );
			pawn.Renderer.Tint = c;
		}
		else if ( input.Is( "mash", PadInputKind.Down ) )
		{
			pawn.Mashes++;
			var full = pawn.Mashes >= 30;
			_session.Update( "meter", new { value = Math.Min( 1f, pawn.Mashes / 30f ), label = full ? "FULL POWER!" : $"{pawn.Mashes} / 30" }, input.Player );
			if ( pawn.Mashes == 30 ) input.Player.Feedback( PadFeedback.Good( "MAX!" ) );
			pawn.Object.WorldScale = 0.5f + Math.Min( 1f, pawn.Mashes / 30f );
		}
		else if ( input.Is( "quiz", PadInputKind.Submit ) )
		{
			input.Player.Feedback( input.Value == "56" ? PadFeedback.Good( "Correct!" ) : PadFeedback.Bad( "Nope, 56!" ) );
		}
		else if ( input.Is( "sketch", PadInputKind.Submit ) )
		{
			input.Player.Feedback( PadFeedback.Message( $"Got it! ({input.Value.Length / 1024} KB)" ) );
		}
		else if ( input.Is( "$shake" ) )
		{
			pawn.VerticalSpeed = 500f;
		}
	}

	protected override void OnUpdate()
	{
		for ( var i = 0; i < Modes.Length; i++ )
		{
			if ( Input.Keyboard.Pressed( (i + 1).ToString() ) && _mode != i )
			{
				_mode = i;
				ShowMode();
				Version++;
			}
		}

		foreach ( var (player, pawn) in _pawns )
		{
			// Polling style: read the latest control state every frame.
			var move = _mode switch
			{
				0 => player.Stick( "move" ),
				1 => player.Dpad( "dpad" ),
				5 => player.Tilt,
				_ => Vector2.Zero,
			};
			// Phone X is right, Y is up/away. In s&box, +X is forward and +Y is left.
			var pos = pawn.Object.WorldPosition + new Vector3( move.y, -move.x, 0 ) * MoveSpeed * Time.Delta;
			pos.x = Math.Clamp( pos.x, -ArenaHalfSize, ArenaHalfSize );
			pos.y = Math.Clamp( pos.y, -ArenaHalfSize, ArenaHalfSize );

			if ( (player.WasPressed( "jump" ) || player.WasPressed( "dpad-jump" )) && pawn.Height <= 0.01f ) pawn.VerticalSpeed = 380f;
			pawn.VerticalSpeed -= 1100f * Time.Delta;
			pawn.Height = Math.Max( 0, pawn.Height + pawn.VerticalSpeed * Time.Delta );
			if ( pawn.Height <= 0 ) pawn.VerticalSpeed = 0;
			pos.z = pawn.Height;
			pawn.Object.WorldPosition = pos;
		}
	}

	/// <summary>Build the phone screen for the current mode. Each microgame in your game would do this.</summary>
	private void ShowMode()
	{
		if ( _session is not { State: PadState.Connected } ) return;

		var screen = _mode switch
		{
			0 => new PadScreen( "Drive your cube", "Stick to move, JUMP to hop" ) { Layout = "row" }.Add(
				Pad.Joystick( "move" ),
				Pad.Column(
					new PadButton { Id = "jump", Label = "JUMP", Shape = "round", Color = "player", Sound = "pop" },
					new PadButton { Id = "colour", Label = "New colour", Flex = 0.4f } ) ),

			1 => new PadScreen( "D-pad", "Slide your thumb between arrows" ).Add(
				Pad.Dpad( "dpad" ),
				new PadButton { Id = "dpad-jump", Label = "JUMP", Flex = 0.35f, Color = "player" } ),

			2 => new PadScreen( "Mash!", "Fill the meter" ) { Timer = 10 }.Add(
				Pad.Progress( "meter", 0, "0 / 30" ),
				new PadButton { Id = "mash", Label = "MASH!", Color = "player", Haptic = "tap", Sound = "tap" } ),

			3 => new PadScreen( "Quick quiz", "What's 7 x 8?" ) { Timer = 15 }.Add(
				new PadChoice
				{
					Id = "quiz",
					Columns = 2,
					Options = new() { new( "54", "54", "#e8574f" ), new( "56", "56", "#4a8ce8" ), new( "58", "58", "#f5c33b" ), new( "64", "64", "#5bbf72" ) },
				} ),

			4 => new PadScreen( "Draw a cat" ) { Scroll = true }.Add( Pad.Drawing( "sketch" ) ),

			5 => new PadScreen( "Tilt to roll", "Shake to jump" ) { Tilt = true, Shake = true }.Add(
				Pad.Text( "📱", "xl" ) ),

			_ => new PadScreen( "Hi!" ),
		};

		foreach ( var pawn in _pawns.Values ) { pawn.Mashes = 0; pawn.Object.WorldScale = 0.5f; }
		_session.Show( screen );
	}

	protected override void OnDestroy()
	{
		foreach ( var pawn in _pawns.Values ) pawn.Object?.Destroy();
		_pawns.Clear();
		if ( Instance == this ) Instance = null;
	}
}
