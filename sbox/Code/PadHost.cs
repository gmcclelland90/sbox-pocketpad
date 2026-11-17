using System.Threading.Tasks;

namespace PocketPad;

/// <summary>
/// Drop this on a GameObject to host a PocketPad session. It connects when the scene starts,
/// pumps events every frame, and ends the session when destroyed. Get at it from anywhere with
/// <see cref="Current"/>, or subscribe to <see cref="Session"/> events from your own component.
/// Only the network host runs a session.
/// </summary>
[Title( "PocketPad Host" ), Category( "PocketPad" ), Icon( "smartphone" )]
public sealed class PadHost : Component
{
	/// <summary>Where your PocketPad server is. For local Docker: http://localhost:8080.</summary>
	[Property] public string ServerUrl { get; set; } = "http://localhost:8080";

	/// <summary>Only needed if the server sets HOST_KEYS.</summary>
	[Property] public string HostKey { get; set; }

	/// <summary>Theme folder on the server ("default", "paper", "neon", or your own).</summary>
	[Property] public string Theme { get; set; }

	[Property, Range( 0, 64 )] public int MaxPlayers { get; set; } = 8;

	[Property] public bool StartOnPlay { get; set; } = true;

	[Property] public bool DebugLogging { get; set; }

	public static PadHost Current { get; private set; }

	public PadSession Session { get; private set; }

	/// <summary>Raised once the session exists, before it connects, so you can subscribe to its events.</summary>
	public event Action<PadSession> SessionCreated;

	/// <summary>
	/// Run <paramref name="setup"/> for the current session (if there is one) and for every new one.
	/// Use this from your own component's OnStart to hook events; it doesn't matter which component starts first.
	/// </summary>
	public void OnSession( Action<PadSession> setup )
	{
		if ( Session != null ) setup( Session );
		SessionCreated += setup;
	}

	protected override void OnStart()
	{
		if ( Networking.IsActive && !Networking.IsHost ) return;
		Current = this;
		if ( StartOnPlay ) _ = StartSession();
	}

	/// <summary>Create and connect a new session (ending any current one).</summary>
	public async Task StartSession()
	{
		Session?.Dispose();
		Session = new PadSession( ServerUrl, new PadSessionOptions
		{
			HostKey = HostKey,
			Theme = Theme,
			MaxPlayers = MaxPlayers,
			Debug = DebugLogging,
		} );
		SessionCreated?.Invoke( Session );
		try
		{
			await Session.Start();
		}
		catch ( Exception e )
		{
			Log.Warning( $"[PocketPad] Couldn't start: {e.Message}" );
		}
	}

	protected override void OnUpdate()
	{
		Session?.Poll();
	}

	protected override void OnDestroy()
	{
		Session?.Dispose();
		Session = null;
		if ( Current == this ) Current = null;
	}
}
