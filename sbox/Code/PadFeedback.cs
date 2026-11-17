using System.Text.Json.Nodes;

namespace PocketPad;

/// <summary>
/// A one-off effect on phones: vibration, a sound, a colour flash, a screen shake and/or a big toast message.
/// Combine as you like: <c>new PadFeedback { Toast = "Nice!", Sound = "success", Haptic = "success" }</c>.
/// Vibration works on Android browsers; iPhones ignore it (Safari has no vibration API).
/// </summary>
public sealed class PadFeedback
{
	/// <summary>"tap", "light", "medium", "heavy", "press", "success", "error", "warning", "buzz", "long".</summary>
	public string Haptic { get; set; }

	/// <summary>Custom vibration pattern in milliseconds (on, off, on...). Overrides <see cref="Haptic"/>.</summary>
	public int[] HapticPattern { get; set; }

	/// <summary>
	/// Built-in synth sounds: "tap", "click", "pop", "tick", "coin", "success", "fail", "buzz", "go",
	/// "whoosh", "countdown". Themes can add their own sound files by name.
	/// </summary>
	public string Sound { get; set; }

	public float? Volume { get; set; }

	/// <summary>Flash the screen: a CSS colour, "player", "success", "danger"... </summary>
	public string Flash { get; set; }

	public bool Shake { get; set; }

	/// <summary>A big message that pops up for a moment.</summary>
	public string Toast { get; set; }
	public string ToastColor { get; set; }
	/// <summary>Seconds the toast stays up. Default 1.6.</summary>
	public float? Duration { get; set; }

	public static PadFeedback Good( string toast = null ) => new() { Toast = toast, Sound = "success", Haptic = "success", Flash = "success" };
	public static PadFeedback Bad( string toast = null ) => new() { Toast = toast, Sound = "fail", Haptic = "error", Flash = "danger", Shake = true };
	public static PadFeedback Buzz() => new() { Haptic = "buzz", Sound = "buzz" };
	public static PadFeedback Tap() => new() { Haptic = "tap" };
	public static PadFeedback Message( string toast, string color = null ) => new() { Toast = toast, ToastColor = color };

	public JsonObject ToJson()
	{
		var o = new JsonObject();
		if ( HapticPattern != null ) o["haptic"] = PadJson.ToNode( HapticPattern );
		else PadJson.Set( o, "haptic", Haptic );
		PadJson.Set( o, "sound", Sound );
		if ( Volume.HasValue ) o["volume"] = Volume.Value;
		PadJson.Set( o, "flash", Flash );
		if ( Shake ) o["shake"] = true;
		PadJson.Set( o, "toast", Toast );
		PadJson.Set( o, "toastColor", ToastColor );
		if ( Duration.HasValue ) o["duration"] = Duration.Value;
		return o;
	}
}

/// <summary>
/// Branding for the phone page. Either name a theme folder installed on the server
/// (<see cref="Use"/>), override bits inline, or both. Server theme folders can also carry
/// a logo, fonts, sounds, a stylesheet and custom controls; see docs/theming.md.
/// </summary>
public sealed class PadTheme
{
	/// <summary>Name of a theme folder on the server to start from ("default", "paper", "neon", or your own).</summary>
	public string Use { get; set; }

	/// <summary>Game name shown on the join page and as the tab title.</summary>
	public string Title { get; set; }
	public string Subtitle { get; set; }

	/// <summary>Logo URL (https or data: URL). Theme folders can use a relative file name instead.</summary>
	public string Logo { get; set; }

	/// <summary>Background image URL.</summary>
	public string Background { get; set; }

	/// <summary>CSS font-family list.</summary>
	public string Font { get; set; }
	public string FontUrl { get; set; }

	/// <summary>Corner radius in pixels.</summary>
	public int? Radius { get; set; }

	/// <summary>Colour overrides: bg, surface, text, muted, accent, accentText, button, buttonText, border, danger, success.</summary>
	public Dictionary<string, string> Colors { get; set; }

	/// <summary>Text overrides: codeLabel, nameLabel, joinButton, joined, watch, reconnecting, ended...</summary>
	public Dictionary<string, string> Text { get; set; }

	/// <summary>Sound name to URL, e.g. { ["coin"] = "https://example.com/coin.ogg" }.</summary>
	public Dictionary<string, string> Sounds { get; set; }

	/// <summary>Extra CSS injected into the page.</summary>
	public string Css { get; set; }

	/// <summary>Hide the "Powered by PocketPad" line.</summary>
	public bool HidePoweredBy { get; set; }

	public static PadTheme Named( string name ) => new() { Use = name };

	public JsonObject ToJson()
	{
		var o = new JsonObject();
		PadJson.Set( o, "use", Use );
		PadJson.Set( o, "title", Title );
		PadJson.Set( o, "subtitle", Subtitle );
		PadJson.Set( o, "logo", Logo );
		PadJson.Set( o, "background", Background );
		PadJson.Set( o, "font", Font );
		PadJson.Set( o, "fontUrl", FontUrl );
		if ( Radius.HasValue ) o["radius"] = Radius.Value;
		if ( Colors != null ) o["colors"] = PadJson.ToNode( Colors );
		if ( Text != null ) o["text"] = PadJson.ToNode( Text );
		if ( Sounds != null ) o["sounds"] = PadJson.ToNode( Sounds );
		PadJson.Set( o, "css", Css );
		if ( HidePoweredBy ) o["poweredBy"] = false;
		return o;
	}
}
