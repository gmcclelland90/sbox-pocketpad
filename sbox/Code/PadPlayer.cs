namespace PocketPad;

/// <summary>
/// A player on a phone. Besides events, it keeps the latest state of their controls so you can poll
/// in OnUpdate: <c>player.Stick("move")</c>, <c>player.IsDown("jump")</c>, <c>player.WasPressed("jump")</c>.
/// </summary>
public sealed class PadPlayer
{
	internal PadPlayer( PadSession session, string id )
	{
		Session = session;
		Id = id;
	}

	public PadSession Session { get; }

	/// <summary>Stable id for this session ("p1", "p2"...). Survives phone refreshes.</summary>
	public string Id { get; }

	public string Name { get; internal set; }

	/// <summary>Join order, starting at 1.</summary>
	public int Slot { get; internal set; }

	/// <summary>The player's colour as CSS ("#e8574f"). The server assigns one; change it with <see cref="SetColor"/>.</summary>
	public string ColorHex { get; internal set; }

	/// <summary>The player's colour as an s&amp;box Color.</summary>
	public Color Color => PadColor.Parse( ColorHex );

	public string Badge { get; internal set; }
	public bool IsConnected { get; internal set; }

	/// <summary>Your own data (score, pawn, team...).</summary>
	public object Tag { get; set; }

	// ------------------------------------------------------------------ live state

	private readonly HashSet<string> _down = new( StringComparer.OrdinalIgnoreCase );
	private readonly Dictionary<string, long> _pressedFrame = new( StringComparer.OrdinalIgnoreCase );
	private readonly Dictionary<string, long> _releasedFrame = new( StringComparer.OrdinalIgnoreCase );
	private readonly Dictionary<string, Vector2> _vectors = new( StringComparer.OrdinalIgnoreCase );
	private readonly Dictionary<string, PadInput> _last = new( StringComparer.OrdinalIgnoreCase );

	/// <summary>Latest tilt, X right / Y away, -1..1. Zero unless the screen enables tilt.</summary>
	public Vector2 Tilt { get; private set; }

	/// <summary>Number of shakes since the session started.</summary>
	public int Shakes { get; private set; }

	private static string Slot2( string element, string key ) => key == null ? element : element + "." + key;

	/// <summary>Is this button (or d-pad direction, with key) held right now?</summary>
	public bool IsDown( string element, string key = null ) => _down.Contains( Slot2( element, key ) );

	/// <summary>Was it pressed during the latest <see cref="PadSession.Poll"/>? Use for one-shot actions.</summary>
	public bool WasPressed( string element, string key = null ) =>
		_pressedFrame.TryGetValue( Slot2( element, key ), out var f ) && f == Session.Frame;

	/// <summary>Was it released during the latest <see cref="PadSession.Poll"/>?</summary>
	public bool WasReleased( string element, string key = null ) =>
		_releasedFrame.TryGetValue( Slot2( element, key ), out var f ) && f == Session.Frame;

	/// <summary>Latest joystick value (X right, Y up, -1..1), or zero.</summary>
	public Vector2 Stick( string element = "stick" ) => _vectors.TryGetValue( element, out var v ) ? v : Vector2.Zero;

	/// <summary>Latest touchpad position (0..1 from top-left), or null when not touching.</summary>
	public Vector2? Touch( string element = "touch" ) => IsDown( element ) && _vectors.TryGetValue( element, out var v ) ? v : null;

	/// <summary>A d-pad as a direction vector (X right, Y up).</summary>
	public Vector2 Dpad( string element = "dpad" ) => new(
		(IsDown( element, "right" ) ? 1 : 0) - (IsDown( element, "left" ) ? 1 : 0),
		(IsDown( element, "up" ) ? 1 : 0) - (IsDown( element, "down" ) ? 1 : 0) );

	/// <summary>The latest input from an element (slider value, last submit...), if any.</summary>
	public PadInput? Last( string element ) => _last.TryGetValue( element, out var i ) ? i : null;

	/// <summary>Latest numeric value of an element (slider, number entry), or null.</summary>
	public double? Number( string element ) => Last( element )?.Number;

	/// <summary>Latest text value of an element, or null.</summary>
	public string Value( string element ) => Last( element )?.Value;

	/// <summary>Forget all held buttons and stick positions (called automatically when you show a new screen).</summary>
	public void ClearInput()
	{
		_down.Clear();
		_vectors.Clear();
		_last.Clear();
		Tilt = Vector2.Zero;
	}

	internal void Apply( PadInput input, long frame )
	{
		_last[input.Element] = input;
		var slot = Slot2( input.Element, input.Key );
		switch ( input.Kind )
		{
			case PadInputKind.Down:
				_down.Add( slot );
				if ( input.Key != null ) _down.Add( input.Element );
				_pressedFrame[slot] = frame;
				if ( input.Key != null ) _pressedFrame[input.Element] = frame;
				if ( input.X != 0 || input.Y != 0 ) _vectors[input.Element] = input.Vector;
				break;
			case PadInputKind.Up:
				_down.Remove( slot );
				if ( input.Key != null && !_down.Any( d => d.StartsWith( input.Element + ".", StringComparison.OrdinalIgnoreCase ) ) ) _down.Remove( input.Element );
				_releasedFrame[slot] = frame;
				_vectors[input.Element] = input.Vector;
				break;
			case PadInputKind.Move:
				_vectors[input.Element] = input.Vector;
				break;
			case PadInputKind.Tilt:
				Tilt = input.Vector;
				break;
			case PadInputKind.Shake:
				Shakes++;
				break;
		}
	}

	// ------------------------------------------------------------------ actions

	/// <summary>Show a screen on this player's phone only.</summary>
	public void Show( PadScreen screen ) => Session.Show( screen, this );

	/// <summary>Play feedback on this player's phone only.</summary>
	public void Feedback( PadFeedback feedback ) => Session.Feedback( feedback, this );

	/// <summary>Change this player's colour (their name chip and any "player" coloured controls).</summary>
	public void SetColor( Color color ) => Session.SetPlayer( this, PadColor.ToHex( color ), Badge );
	public void SetColor( string cssColor ) => Session.SetPlayer( this, cssColor, Badge );

	/// <summary>Small badge next to their name, e.g. "P1", "1st", "👑". Null clears it.</summary>
	public void SetBadge( string badge ) => Session.SetPlayer( this, ColorHex, badge );

	public override string ToString() => $"{Name} ({Id})";
}

/// <summary>Colour helpers between s&amp;box Color and CSS hex.</summary>
public static class PadColor
{
	public static string ToHex( Color c )
	{
		static int B( float v ) => Math.Clamp( (int)MathF.Round( v * 255f ), 0, 255 );
		return $"#{B( c.r ):x2}{B( c.g ):x2}{B( c.b ):x2}";
	}

	public static Color Parse( string hex, Color? fallback = null )
	{
		var fb = fallback ?? new Color( 1f, 1f, 1f );
		if ( string.IsNullOrEmpty( hex ) || hex[0] != '#' ) return fb;
		var s = hex[1..];
		if ( s.Length == 3 ) s = string.Concat( s.Select( ch => $"{ch}{ch}" ) );
		if ( s.Length != 6 && s.Length != 8 ) return fb;
		try
		{
			float P( int i ) => Convert.ToInt32( s.Substring( i, 2 ), 16 ) / 255f;
			return new Color( P( 0 ), P( 2 ), P( 4 ), s.Length == 8 ? P( 6 ) : 1f );
		}
		catch
		{
			return fb;
		}
	}
}
