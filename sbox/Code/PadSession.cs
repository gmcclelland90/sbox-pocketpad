using System.Globalization;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace PocketPad;

public enum PadState
{
	Idle,
	Connecting,
	Connected,
	/// <summary>Lost the server; retrying. Phones keep their screens and the session survives for a couple of minutes.</summary>
	Reconnecting,
	Ended,
}

public sealed class PadSessionOptions
{
	/// <summary>Key from the server's HOST_KEYS, if the server requires one.</summary>
	public string HostKey { get; set; }

	/// <summary>Server theme folder to use ("default", "paper", "neon", or your own).</summary>
	public string Theme { get; set; }

	/// <summary>0 = server default (16).</summary>
	public int MaxPlayers { get; set; }

	/// <summary>Reconnect automatically after network blips and server restarts.</summary>
	public bool AutoReconnect { get; set; } = true;

	/// <summary>Log every message (noisy).</summary>
	public bool Debug { get; set; }
}

/// <summary>
/// A game session on a PocketPad server. Players join from their phone browser with the
/// <see cref="Code"/> (or by opening <see cref="JoinUrl"/>), and you drive their screens and read
/// their input.
///
/// <para>All events are raised from <see cref="Poll"/>, on the thread that calls it. Call Poll once a
/// frame (the <see cref="PadHost"/> component does this for you).</para>
/// </summary>
public sealed class PadSession : IDisposable
{
	public const int ProtocolVersion = 1;

	/// <summary>
	/// Largest message the game accepts from the server (drawings arrive as PNG data URLs).
	/// s&box's WebSocket allows 4 KiB to 4 MiB; anything outside that throws in the constructor.
	/// </summary>
	public const int MaxMessageBytes = 4 * 1024 * 1024;

	public PadSession( string serverUrl, PadSessionOptions options = null )
	{
		ServerUrl = (serverUrl ?? "http://localhost:8080").TrimEnd( '/' );
		Options = options ?? new PadSessionOptions();
	}

	public string ServerUrl { get; }
	public PadSessionOptions Options { get; }
	public PadState State { get; private set; } = PadState.Idle;

	/// <summary>The 4-letter room code players type.</summary>
	public string Code { get; private set; }

	/// <summary>Link that opens the controller with the code filled in (show it on screen, or as a QR code).</summary>
	public string JoinUrl { get; private set; }

	/// <summary>The address players type, without "http://" (e.g. "192.168.1.20:8080").</summary>
	public string JoinHost => JoinUrl == null ? null : StripScheme( JoinUrl[..JoinUrl.LastIndexOf( '/' )] );

	/// <summary>A PNG QR code of <see cref="JoinUrl"/>, served by the server (?size= to change pixels).</summary>
	public string QrCodeUrl => Code == null ? null : $"{ServerUrl}/qr/{Code}.png";

	/// <summary>Whether new players can join. Players who already joined can always reconnect.</summary>
	public bool LobbyOpen { get; private set; } = true;

	/// <summary>Increments every <see cref="Poll"/>; used by <see cref="PadPlayer.WasPressed"/>.</summary>
	public long Frame { get; private set; }

	public IReadOnlyList<PadPlayer> Players => _order;

	/// <summary>Connected (or reconnecting) players.</summary>
	public IEnumerable<PadPlayer> ActivePlayers => _order.Where( p => p.IsConnected );

	public PadPlayer GetPlayer( string id ) => id != null && _players.TryGetValue( id, out var p ) ? p : null;

	// ------------------------------------------------------------------ events

	/// <summary>The session is ready (Code and JoinUrl are set). The bool is true when it resumed after a reconnect.</summary>
	public event Action<bool> Ready;

	/// <summary>A new player joined.</summary>
	public event Action<PadPlayer> PlayerJoined;

	/// <summary>A player's phone connected again after dropping out (refresh, network blip).</summary>
	public event Action<PadPlayer> PlayerReconnected;

	/// <summary>A player's phone lost connection. They stay in the game and can come back.</summary>
	public event Action<PadPlayer> PlayerDisconnected;

	/// <summary>A player left for good (pressed leave, or was kicked).</summary>
	public event Action<PadPlayer> PlayerLeft;

	/// <summary>Every input from every phone.</summary>
	public event Action<PadInput> Input;

	/// <summary>The session ended (you ended it, the server restarted, or it timed out). Carries the reason.</summary>
	public event Action<string> Ended;

	/// <summary>Something went wrong (bad host key, server unreachable, rejected message).</summary>
	public event Action<string> Error;

	// ------------------------------------------------------------------ internals

	private readonly Dictionary<string, PadPlayer> _players = new();
	private readonly List<PadPlayer> _order = new();
	private readonly object _lock = new();
	private readonly Queue<Action> _inbox = new();
	private readonly List<string> _outbox = new();
	private readonly CancellationTokenSource _cts = new();
	private WebSocket _socket;
	private string _hostToken;
	private int _retry;
	private bool _disposed;

	/// <summary>Connect and create the session. Completes when the server has answered (or failed).</summary>
	public async Task Start()
	{
		if ( State != PadState.Idle ) throw new InvalidOperationException( "This session has already started." );
		await Connect();
	}

	private string HostSocketUrl()
	{
		var url = ServerUrl.StartsWith( "https://", StringComparison.OrdinalIgnoreCase ) ? "wss://" + ServerUrl[8..]
			: ServerUrl.StartsWith( "http://", StringComparison.OrdinalIgnoreCase ) ? "ws://" + ServerUrl[7..]
			: ServerUrl;
		var q = new List<string> { $"v={ProtocolVersion}" };
		if ( !string.IsNullOrEmpty( _hostToken ) ) q.Add( "resume=" + Uri.EscapeDataString( _hostToken ) );
		if ( !string.IsNullOrEmpty( Options.HostKey ) ) q.Add( "key=" + Uri.EscapeDataString( Options.HostKey ) );
		if ( !string.IsNullOrEmpty( Options.Theme ) ) q.Add( "theme=" + Uri.EscapeDataString( Options.Theme ) );
		if ( Options.MaxPlayers > 0 ) q.Add( "maxPlayers=" + Options.MaxPlayers );
		return $"{url}/ws/host?{string.Join( "&", q )}";
	}

	private async Task Connect()
	{
		if ( _disposed || State == PadState.Ended ) return;
		State = _hostToken == null ? PadState.Connecting : PadState.Reconnecting;

		WebSocket socket;
		try
		{
			socket = new WebSocket( MaxMessageBytes );
		}
		catch ( Exception e )
		{
			// Don't let this escape: it would fault Start() and leave the session stuck in Connecting.
			Post( () => SetEnded( $"Couldn't create a WebSocket: {e.Message}" ) );
			return;
		}

		socket.OnMessageReceived += msg => OnSocketMessage( socket, msg );
		socket.OnDisconnected += ( status, reason ) => OnSocketClosed( socket, status, reason );
		_socket?.Dispose();
		_socket = socket;

		try
		{
			// Only new sessions need proving; resuming uses the host token the server gave us.
			var headers = _hostToken == null && Options.SendAuthToken ? await AuthHeaders() : null;
			if ( _socket != socket ) return;
			if ( headers != null ) await socket.Connect( HostSocketUrl(), headers, _cts.Token );
			else await socket.Connect( HostSocketUrl(), _cts.Token );
		}
		catch ( Exception e )
		{
			if ( _socket != socket ) return;
			Post( () => Error?.Invoke( $"Couldn't reach the PocketPad server at {ServerUrl}: {e.Message}" ) );
			ScheduleReconnect();
		}
	}

	/// <summary>An s&box auth token and our Steam ID, or null if we couldn't get a token (e.g. not signed in).</summary>
	private static async Task<Dictionary<string, string>> AuthHeaders()
	{
		try
		{
			var get = Sandbox.Services.Auth.GetToken( "pocketpad" );
			// GetToken ignores cancellation, so don't let a slow backend hold up the connection forever.
			if ( await Task.WhenAny( get, Task.Delay( 5000 ) ) != get ) return null;
			var token = await get;
			if ( string.IsNullOrEmpty( token ) ) return null;
			return new Dictionary<string, string>
			{
				{ "Authorization", token },
				{ "X-Steam-Id", Game.SteamId.ToString() },
			};
		}
		catch ( Exception e )
		{
			Log.Warning( $"[PocketPad] Couldn't get an s&box auth token: {e.Message}" );
			return null;
		}
	}

	private void OnSocketClosed( WebSocket socket, int status, string reason )
	{
		if ( _socket != socket || _disposed ) return;
		if ( Options.Debug ) Log.Info( $"[PocketPad] socket closed {status} {reason}" );
		if ( State == PadState.Ended ) return;
		if ( status == 4003 || status == 4029 || status == 4001 ) return; // rejected or ended: message handler deals with it
		ScheduleReconnect();
	}

	private async void ScheduleReconnect()
	{
		if ( _disposed || State == PadState.Ended ) return;
		if ( !Options.AutoReconnect ) { Post( () => SetEnded( "Lost connection to the server." ) ); return; }
		State = PadState.Reconnecting;
		var delay = Math.Min( 1000 * (1 << Math.Min( _retry++, 4 )), 15000 );
		try { await Task.Delay( delay, _cts.Token ); } catch { return; }
		await Connect();
	}

	private void OnSocketMessage( WebSocket socket, string text )
	{
		if ( _socket != socket ) return;
		var received = PadClock.Now;
		if ( Options.Debug ) Log.Info( $"[PocketPad] <- {text}" );

		JsonObject msg;
		try { msg = JsonNode.Parse( text ) as JsonObject; }
		catch { return; }
		if ( msg == null ) return;

		switch ( Str( msg, "type" ) )
		{
			case "ready":
				Post( () => HandleReady( msg ) );
				break;
			case "join":
				Post( () => HandleJoin( msg["player"] as JsonObject, Bool( msg, "rejoin" ) ) );
				break;
			case "status":
				Post( () =>
				{
					var p = GetPlayer( Str( msg, "id" ) );
					if ( p == null ) return;
					var connected = Bool( msg, "connected" );
					if ( p.IsConnected == connected ) return;
					p.IsConnected = connected;
					if ( !connected ) { p.ClearInput(); PlayerDisconnected?.Invoke( p ); }
				} );
				break;
			case "leave":
				Post( () =>
				{
					var p = GetPlayer( Str( msg, "id" ) );
					if ( p == null ) return;
					_players.Remove( p.Id );
					_order.Remove( p );
					p.IsConnected = false;
					PlayerLeft?.Invoke( p );
				} );
				break;
			case "input":
				Post( () => HandleInput( msg, received ) );
				break;
			case "error":
				var message = Str( msg, "message" ) ?? "Unknown server error";
				Post( () =>
				{
					Log.Warning( $"[PocketPad] {message}" );
					Error?.Invoke( message );
				} );
				if ( State != PadState.Connected ) Post( () => SetEnded( message ) );
				break;
			case "ended":
				Post( () => SetEnded( Str( msg, "message" ) ?? "The session ended." ) );
				break;
		}
	}

	private void HandleReady( JsonObject msg )
	{
		var code = Str( msg, "code" );
		var resumed = Bool( msg, "resumed" );
		if ( !resumed && Code != null && code != Code )
		{
			// The old session expired while we were away; this is a fresh one.
			foreach ( var p in _order.ToArray() ) PlayerLeft?.Invoke( p );
			_players.Clear();
			_order.Clear();
		}
		Code = code;
		JoinUrl = Str( msg, "joinUrl" );
		_hostToken = Str( msg, "hostToken" );
		LobbyOpen = !msg.ContainsKey( "lobbyOpen" ) || Bool( msg, "lobbyOpen" );
		State = PadState.Connected;
		_retry = 0;

		if ( msg["players"] is JsonArray list )
		{
			var seen = new HashSet<string>();
			foreach ( var node in list.OfType<JsonObject>() )
			{
				var id = Str( node, "id" );
				seen.Add( id );
				var known = GetPlayer( id ) != null;
				var p = Upsert( node );
				if ( !known ) PlayerJoined?.Invoke( p );
			}
			foreach ( var gone in _order.Where( p => !seen.Contains( p.Id ) ).ToArray() )
			{
				_players.Remove( gone.Id );
				_order.Remove( gone );
				PlayerLeft?.Invoke( gone );
			}
		}

		string[] pending;
		lock ( _lock ) { pending = _outbox.ToArray(); _outbox.Clear(); }
		foreach ( var m in pending ) SendRaw( m );

		Log.Info( resumed ? $"[PocketPad] Reconnected to session {Code}" : $"[PocketPad] Session {Code} ready, join at {JoinUrl}" );
		Ready?.Invoke( resumed );
	}

	private PadPlayer Upsert( JsonObject node )
	{
		var id = Str( node, "id" );
		if ( !_players.TryGetValue( id, out var p ) )
		{
			p = new PadPlayer( this, id );
			_players[id] = p;
			_order.Add( p );
			_order.Sort( ( a, b ) => a.Slot.CompareTo( b.Slot ) );
		}
		p.Name = Str( node, "name" ) ?? p.Name ?? id;
		p.Slot = (int)Num( node, "slot", p.Slot );
		p.ColorHex = Str( node, "color" ) ?? p.ColorHex;
		p.Badge = Str( node, "badge" );
		p.IsConnected = !node.ContainsKey( "connected" ) || Bool( node, "connected" );
		_order.Sort( ( a, b ) => a.Slot.CompareTo( b.Slot ) );
		return p;
	}

	private void HandleJoin( JsonObject node, bool rejoin )
	{
		if ( node == null ) return;
		var known = GetPlayer( Str( node, "id" ) ) != null;
		var p = Upsert( node );
		p.IsConnected = true;
		if ( known ) PlayerReconnected?.Invoke( p );
		else PlayerJoined?.Invoke( p );
	}

	private void HandleInput( JsonObject msg, double received )
	{
		var player = GetPlayer( Str( msg, "from" ) );
		if ( player == null ) return;
		var ev = Str( msg, "ev" ) ?? "";
		var kind = PadInput.KindOf( ev );

		string value = null;
		double? number = null;
		if ( msg["value"] is JsonValue v )
		{
			if ( v.TryGetValue<string>( out var s ) )
			{
				value = s;
				if ( double.TryParse( s, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed ) ) number = parsed;
			}
			else if ( v.TryGetValue<double>( out var d ) ) { number = d; value = d.ToString( CultureInfo.InvariantCulture ); }
			else if ( v.TryGetValue<bool>( out var b ) ) { value = b ? "true" : "false"; number = b ? 1 : 0; }
		}

		string[] values = null;
		if ( msg["values"] is JsonArray arr ) values = arr.Select( n => n?.ToString() ).Where( s => s != null ).ToArray();

		var input = new PadInput
		{
			Player = player,
			Element = Str( msg, "el" ),
			Event = ev,
			Kind = kind,
			Key = Str( msg, "key" ),
			X = (float)Num( msg, "x", 0 ),
			Y = (float)Num( msg, "y", 0 ),
			Value = value,
			Number = number,
			Values = values,
			HeldSeconds = (float)(Num( msg, "held", 0 ) / 1000.0),
			Sequence = (long)Num( msg, "seq", 0 ),
			ReceivedAt = received,
		};
		player.Apply( input, Frame );
		Input?.Invoke( input );
	}

	private void SetEnded( string reason )
	{
		if ( State == PadState.Ended ) return;
		State = PadState.Ended;
		foreach ( var p in _order ) p.IsConnected = false;
		Log.Info( $"[PocketPad] Session ended: {reason}" );
		Ended?.Invoke( reason );
	}

	private void Post( Action a )
	{
		lock ( _lock ) _inbox.Enqueue( a );
	}

	/// <summary>Raise queued events. Call once per frame from the main thread.</summary>
	public void Poll()
	{
		Frame++;
		while ( true )
		{
			Action a;
			lock ( _lock )
			{
				if ( _inbox.Count == 0 ) break;
				a = _inbox.Dequeue();
			}
			try { a(); }
			catch ( Exception e ) { Log.Error( e, "[PocketPad] Error in event handler" ); }
		}
	}

	// ------------------------------------------------------------------ sending

	private void Send( JsonObject msg, IEnumerable<PadPlayer> to = null )
	{
		if ( to != null )
		{
			var ids = new JsonArray();
			foreach ( var p in to ) if ( p != null ) ids.Add( p.Id );
			if ( ids.Count == 0 ) return;
			msg["to"] = ids;
		}
		var text = msg.ToJsonString();
		if ( State == PadState.Connected && _socket is { IsConnected: true } ) SendRaw( text );
		else if ( State != PadState.Ended )
		{
			lock ( _lock )
			{
				// Keep the latest few hundred while offline. Screens are cached by the server, so order is what matters.
				if ( _outbox.Count >= 300 ) _outbox.RemoveAt( 0 );
				_outbox.Add( text );
			}
		}
	}

	private async void SendRaw( string text )
	{
		if ( Options.Debug ) Log.Info( $"[PocketPad] -> {(text.Length > 300 ? text[..300] + "..." : text)}" );
		try { await _socket.Send( text ); }
		catch ( Exception e ) { Log.Warning( $"[PocketPad] send failed: {e.Message}" ); }
	}

	private static IEnumerable<PadPlayer> One( PadPlayer p ) => p == null ? null : new[] { p };

	/// <summary>Show a screen on every phone. Players who join later see it too.</summary>
	public void Show( PadScreen screen )
	{
		foreach ( var p in _order ) p.ClearInput();
		Send( new JsonObject { ["type"] = "show", ["screen"] = screen.ToJson() } );
	}

	/// <summary>Show a screen on one player's phone.</summary>
	public void Show( PadScreen screen, PadPlayer player )
	{
		if ( player == null ) { Show( screen ); return; }
		player.ClearInput();
		Send( new JsonObject { ["type"] = "show", ["screen"] = screen.ToJson() }, One( player ) );
	}

	/// <summary>Show a screen on some players' phones (e.g. one team).</summary>
	public void Show( PadScreen screen, IEnumerable<PadPlayer> players )
	{
		var list = players.ToList();
		foreach ( var p in list ) p.ClearInput();
		Send( new JsonObject { ["type"] = "show", ["screen"] = screen.ToJson() }, list );
	}

	/// <summary>
	/// Change properties of one element without redrawing the screen, e.g.
	/// <c>Update("power", new { value = 0.5f, label = "50%" })</c>. Use the element's JSON names (camelCase).
	/// Use id "$screen" to change title, subtitle, timer, round or background.
	/// </summary>
	public void Update( string elementId, object properties, PadPlayer player = null )
	{
		Send( new JsonObject { ["type"] = "update", ["id"] = elementId, ["set"] = PadJson.ToNode( properties ) }, One( player ) );
	}

	public void Update( string elementId, object properties, IEnumerable<PadPlayer> players )
	{
		Send( new JsonObject { ["type"] = "update", ["id"] = elementId, ["set"] = PadJson.ToNode( properties ) }, players.ToList() );
	}

	/// <summary>Change the screen title/subtitle/timer without redrawing controls.</summary>
	public void UpdateScreen( string title = null, string subtitle = null, float? timer = null, PadPlayer player = null )
	{
		var set = new JsonObject();
		if ( title != null ) set["title"] = title;
		if ( subtitle != null ) set["subtitle"] = subtitle;
		if ( timer.HasValue ) set["timer"] = timer.Value;
		Send( new JsonObject { ["type"] = "update", ["id"] = "$screen", ["set"] = set }, One( player ) );
	}

	/// <summary>Vibrate, play a sound, flash, shake or pop a message on phones.</summary>
	public void Feedback( PadFeedback feedback, PadPlayer player = null )
	{
		Send( new JsonObject { ["type"] = "feedback", ["feedback"] = feedback.ToJson() }, One( player ) );
	}

	public void Feedback( PadFeedback feedback, IEnumerable<PadPlayer> players )
	{
		Send( new JsonObject { ["type"] = "feedback", ["feedback"] = feedback.ToJson() }, players.ToList() );
	}

	/// <summary>Send any data to custom elements in a theme script (PocketPad.onCustom on the phone).</summary>
	public void SendCustom( object data, PadPlayer player = null )
	{
		Send( new JsonObject { ["type"] = "send", ["data"] = PadJson.ToNode( data ) }, One( player ) );
	}

	internal void SetPlayer( PadPlayer player, string color, string badge )
	{
		player.ColorHex = color;
		player.Badge = badge;
		var msg = new JsonObject { ["type"] = "player", ["id"] = player.Id, ["color"] = color };
		msg["badge"] = badge;
		Send( msg );
	}

	/// <summary>Change the phones' branding mid-game (or before anyone joins).</summary>
	public void SetTheme( PadTheme theme )
	{
		Send( new JsonObject { ["type"] = "theme", ["theme"] = theme.ToJson() } );
	}

	/// <summary>Open or close the lobby. Closed: new players are turned away, existing ones can still reconnect.</summary>
	public void SetLobbyOpen( bool open )
	{
		LobbyOpen = open;
		Send( new JsonObject { ["type"] = "lobby", ["open"] = open } );
	}

	public void Kick( PadPlayer player, string reason = null )
	{
		if ( player == null ) return;
		var msg = new JsonObject { ["type"] = "kick", ["id"] = player.Id };
		if ( reason != null ) msg["reason"] = reason;
		Send( msg );
	}

	/// <summary>End the session; phones go back to the join screen showing the reason.</summary>
	public void End( string reason = null )
	{
		if ( State == PadState.Ended || State == PadState.Idle ) { State = PadState.Ended; return; }
		var msg = new JsonObject { ["type"] = "end" };
		if ( reason != null ) msg["reason"] = reason;
		if ( _socket is { IsConnected: true } ) SendRaw( msg.ToJsonString() );
		State = PadState.Ended;
	}

	public void Dispose()
	{
		if ( _disposed ) return;
		End( "The game has closed." );
		_disposed = true;
		_cts.Cancel();
		var socket = _socket;
		_socket = null;
		CloseLater( socket );
	}

	private static async void CloseLater( WebSocket socket )
	{
		if ( socket == null ) return;
		try { await Task.Delay( 300 ); } catch { }
		socket.Dispose();
	}

	// ------------------------------------------------------------------ json helpers

	private static string Str( JsonObject o, string key ) =>
		o.TryGetPropertyValue( key, out var n ) && n is JsonValue v && v.TryGetValue<string>( out var s ) ? s : null;

	private static bool Bool( JsonObject o, string key ) =>
		o.TryGetPropertyValue( key, out var n ) && n is JsonValue v && v.TryGetValue<bool>( out var b ) && b;

	private static double Num( JsonObject o, string key, double fallback ) =>
		o.TryGetPropertyValue( key, out var n ) && n is JsonValue v && v.TryGetValue<double>( out var d ) ? d : fallback;

	private static string StripScheme( string url ) =>
		url.Replace( "https://", "" ).Replace( "http://", "" ).TrimEnd( '/' );
}
