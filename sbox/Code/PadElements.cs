using System.Text.Json;
using System.Text.Json.Nodes;

namespace PocketPad;

/// <summary>
/// What a phone shows: an optional title, subtitle and countdown, plus a list of controls.
/// Build a new one for each moment of your game (lobby, each microgame, results) and pass it to
/// <see cref="PadSession.Show(PadScreen)"/>. Elements stack top to bottom; use <see cref="PadRow"/>
/// and <see cref="PadColumn"/> to lay them out side by side.
/// </summary>
public sealed class PadScreen
{
	public string Title { get; set; }
	public string Subtitle { get; set; }

	/// <summary>Small text in the top bar, e.g. "Round 3/10".</summary>
	public string Round { get; set; }

	/// <summary>Seconds for the countdown in the top bar. Null hides it.</summary>
	public float? Timer { get; set; }

	/// <summary>Set false to silence the last-three-seconds tick.</summary>
	public bool TimerTicks { get; set; } = true;

	/// <summary>"stack" (default, top to bottom), "row" (side by side, good for landscape) or "grid".</summary>
	public string Layout { get; set; }

	/// <summary>Allow the page to scroll (forms, drawing). Off by default so controls fill the screen.</summary>
	public bool Scroll { get; set; }

	/// <summary>CSS background for this screen, e.g. "#222" or "linear-gradient(...)".</summary>
	public string Background { get; set; }

	/// <summary>Send phone tilt as input from element "$tilt" (ev "tilt", X/Y in -1..1).</summary>
	public bool Tilt { get; set; }

	/// <summary>Degrees of tilt that count as full (1.0). Default 35.</summary>
	public float? TiltRange { get; set; }

	/// <summary>Send shakes as input from element "$shake".</summary>
	public bool Shake { get; set; }

	/// <summary>
	/// Seconds after this screen appears during which the phone ignores taps on its controls (up to 3). Use it when
	/// a screen replaces one players were hammering, so a leftover tap can't hit a button that just appeared there
	/// (e.g. NEXT / PAUSE after a mashing game). Sensors aren't affected.
	/// </summary>
	public float InputDelay { get; set; }

	public List<PadElement> Elements { get; set; } = new();

	public PadScreen() { }

	public PadScreen( string title, string subtitle = null )
	{
		Title = title;
		Subtitle = subtitle;
	}

	/// <summary>Add elements and return this screen, for one-line screen building.</summary>
	public PadScreen Add( params PadElement[] elements )
	{
		Elements.AddRange( elements.Where( e => e != null ) );
		return this;
	}

	public JsonObject ToJson()
	{
		var o = new JsonObject();
		PadJson.Set( o, "title", Title );
		PadJson.Set( o, "subtitle", Subtitle );
		PadJson.Set( o, "round", Round );
		if ( Timer.HasValue ) o["timer"] = Timer.Value;
		if ( !TimerTicks ) o["timerTicks"] = false;
		PadJson.Set( o, "layout", Layout );
		if ( Scroll ) o["scroll"] = true;
		PadJson.Set( o, "background", Background );
		if ( InputDelay > 0 ) o["inputDelay"] = (int)MathF.Round( MathF.Min( InputDelay, 3f ) * 1000 );
		if ( Tilt || Shake )
		{
			var sensors = new JsonObject();
			if ( Tilt ) sensors["tilt"] = TiltRange.HasValue ? new JsonObject { ["range"] = TiltRange.Value } : true;
			if ( Shake ) sensors["shake"] = true;
			o["sensors"] = sensors;
		}
		o["elements"] = PadJson.Array( Elements );
		return o;
	}
}

/// <summary>
/// Base for every control. Give an element an <see cref="Id"/> when you want to read its input or
/// update it later; input events carry the id as <see cref="PadInput.Element"/>.
/// </summary>
public abstract class PadElement
{
	/// <summary>The control type the phone renders ("button", "joystick", or your custom type).</summary>
	public abstract string Type { get; }

	public string Id { get; set; }

	/// <summary>How much free space this element takes relative to its siblings (CSS flex-grow).</summary>
	public float? Flex { get; set; }

	/// <summary>Main colour: a CSS colour, or "player" (this player's colour), "accent", "danger", "success".</summary>
	public string Color { get; set; }

	/// <summary>Text colour, same values as <see cref="Color"/>.</summary>
	public string TextColor { get; set; }

	public bool Disabled { get; set; }
	public bool Hidden { get; set; }

	/// <summary>Extra CSS class names for theme styling.</summary>
	public string Class { get; set; }

	/// <summary>Any extra properties to send (for custom elements or newer client features).</summary>
	public Dictionary<string, object> Extra { get; set; }

	public JsonObject ToJson()
	{
		var o = new JsonObject { ["type"] = Type };
		PadJson.Set( o, "id", Id );
		if ( Flex.HasValue ) o["flex"] = Flex.Value;
		PadJson.Set( o, "color", Color );
		PadJson.Set( o, "textColor", TextColor );
		if ( Disabled ) o["disabled"] = true;
		if ( Hidden ) o["hidden"] = true;
		PadJson.Set( o, "class", Class );
		Write( o );
		if ( Extra != null )
			foreach ( var (k, v) in Extra ) o[k] = PadJson.ToNode( v );
		return o;
	}

	protected abstract void Write( JsonObject o );
}

/// <summary>Text on the phone. Size: "s", "m", "l" or "xl".</summary>
public sealed class PadText : PadElement
{
	public override string Type => "text";
	public string Text { get; set; }
	public string Size { get; set; }
	public string Align { get; set; }

	protected override void Write( JsonObject o )
	{
		PadJson.Set( o, "text", Text );
		PadJson.Set( o, "size", Size );
		PadJson.Set( o, "align", Align );
	}
}

/// <summary>An image by URL (https, data: URL, or a file in the server theme, e.g. "/themes/mygame/cat.png").</summary>
public sealed class PadImage : PadElement
{
	public override string Type => "image";
	public string Src { get; set; }
	/// <summary>CSS object-fit: "contain" (default) or "cover".</summary>
	public string Fit { get; set; }
	public string Alt { get; set; }

	protected override void Write( JsonObject o )
	{
		PadJson.Set( o, "src", Src );
		PadJson.Set( o, "fit", Fit );
		PadJson.Set( o, "alt", Alt );
	}
}

/// <summary>A bar from 0 to 1. Update its Value live with <see cref="PadSession.Update"/>.</summary>
public sealed class PadProgress : PadElement
{
	public override string Type => "progress";
	public float Value { get; set; }
	public string Label { get; set; }

	protected override void Write( JsonObject o )
	{
		o["value"] = Value;
		PadJson.Set( o, "label", Label );
	}
}

/// <summary>Empty space.</summary>
public sealed class PadSpacer : PadElement
{
	public override string Type => "spacer";
	protected override void Write( JsonObject o ) { }
}

/// <summary>Lays children out side by side.</summary>
public class PadRow : PadElement
{
	public override string Type => "row";
	public List<PadElement> Children { get; set; } = new();
	/// <summary>Gap between children in pixels.</summary>
	public int? Gap { get; set; }

	public PadRow() { }
	public PadRow( params PadElement[] children ) { Children.AddRange( children.Where( c => c != null ) ); }

	protected override void Write( JsonObject o )
	{
		o["children"] = PadJson.Array( Children );
		if ( Gap.HasValue ) o["gap"] = Gap.Value;
	}
}

/// <summary>Stacks children top to bottom (useful inside a <see cref="PadRow"/>).</summary>
public sealed class PadColumn : PadRow
{
	public override string Type => "column";
	public PadColumn() { }
	public PadColumn( params PadElement[] children ) : base( children ) { }
}

/// <summary>
/// A button. Sends <see cref="PadInputKind.Down"/> the instant it's touched and
/// <see cref="PadInputKind.Up"/> on release (with <see cref="PadInput.HeldSeconds"/>), so it works for
/// taps, mashing and hold-to-charge alike.
/// </summary>
public sealed class PadButton : PadElement
{
	public override string Type => "button";
	public string Label { get; set; }
	public string Sublabel { get; set; }
	/// <summary>Emoji or short text shown before the label.</summary>
	public string Icon { get; set; }
	/// <summary>"rect" (default), "round" or "pill".</summary>
	public string Shape { get; set; }
	/// <summary>Vibration on press: "tap" (default), "light", "heavy", "none"...</summary>
	public string Haptic { get; set; }
	/// <summary>Sound the phone plays on press (built-in name like "tap"/"pop", or a theme sound).</summary>
	public string Sound { get; set; }
	/// <summary>Optional key sent with the input, handy when several buttons share handling code.</summary>
	public string Key { get; set; }

	protected override void Write( JsonObject o )
	{
		PadJson.Set( o, "label", Label );
		PadJson.Set( o, "sublabel", Sublabel );
		PadJson.Set( o, "icon", Icon );
		PadJson.Set( o, "shape", Shape );
		PadJson.Set( o, "haptic", Haptic );
		PadJson.Set( o, "sound", Sound );
		PadJson.Set( o, "key", Key );
	}
}

/// <summary>
/// A d-pad. Sends Down/Up with Key = "up", "down", "left" or "right". Players can slide their thumb
/// between directions. With Diagonals, two keys can be held at once.
/// </summary>
public sealed class PadDpad : PadElement
{
	public override string Type => "dpad";
	public bool Diagonals { get; set; }
	/// <summary>Custom labels per direction, e.g. { ["up"] = "W" }.</summary>
	public Dictionary<string, string> Labels { get; set; }
	public string Haptic { get; set; }

	protected override void Write( JsonObject o )
	{
		if ( Diagonals ) o["diagonals"] = true;
		if ( Labels != null ) o["labels"] = PadJson.ToNode( Labels );
		PadJson.Set( o, "haptic", Haptic );
	}
}

/// <summary>
/// An analog stick. Sends Move with X/Y in -1..1 (X right, Y up) about 30 times a second while held,
/// and Up with 0,0 on release. Read the latest value any time with <see cref="PadPlayer.Stick"/>.
/// </summary>
public sealed class PadJoystick : PadElement
{
	public override string Type => "joystick";
	public string Label { get; set; }
	/// <summary>Centre the stick wherever the thumb lands.</summary>
	public bool Floating { get; set; }
	/// <summary>Lock to one axis: "x" or "y".</summary>
	public string Axis { get; set; }
	public float? Deadzone { get; set; }
	/// <summary>Milliseconds between updates. Default 33.</summary>
	public int? Interval { get; set; }

	protected override void Write( JsonObject o )
	{
		PadJson.Set( o, "label", Label );
		if ( Floating ) o["floating"] = true;
		PadJson.Set( o, "axis", Axis );
		if ( Deadzone.HasValue ) o["deadzone"] = Deadzone.Value;
		if ( Interval.HasValue ) o["interval"] = Interval.Value;
	}
}

/// <summary>A touch area. Sends Down/Move/Up with X/Y in 0..1 from the top-left. Good for aiming and pointing.</summary>
public sealed class PadTouchpad : PadElement
{
	public override string Type => "touchpad";
	public string Label { get; set; }
	public int? Interval { get; set; }

	protected override void Write( JsonObject o )
	{
		PadJson.Set( o, "label", Label );
		if ( Interval.HasValue ) o["interval"] = Interval.Value;
	}
}

/// <summary>
/// A swipe area. Sends Swipe with Key = direction and X/Y = velocity (screen widths per second, Y up),
/// or Tap for a touch without movement.
/// </summary>
public sealed class PadSwipe : PadElement
{
	public override string Type => "swipe";
	public string Label { get; set; }
	/// <summary>Only report these directions (null = all four).</summary>
	public string[] Directions { get; set; }
	public int? MinDistance { get; set; }

	protected override void Write( JsonObject o )
	{
		PadJson.Set( o, "label", Label );
		if ( Directions != null ) o["directions"] = PadJson.ToNode( Directions );
		if ( MinDistance.HasValue ) o["minDistance"] = MinDistance.Value;
	}
}

/// <summary>A slider. Sends Change while dragging and Set with the final value on release.</summary>
public sealed class PadSlider : PadElement
{
	public override string Type => "slider";
	public string Label { get; set; }
	public float Min { get; set; } = 0;
	public float Max { get; set; } = 1;
	/// <summary>Null = continuous.</summary>
	public float? Step { get; set; }
	public float? Value { get; set; }
	public bool Vertical { get; set; }
	public bool ShowValue { get; set; }

	protected override void Write( JsonObject o )
	{
		PadJson.Set( o, "label", Label );
		o["min"] = Min;
		o["max"] = Max;
		if ( Step.HasValue ) o["step"] = Step.Value;
		if ( Value.HasValue ) o["value"] = Value.Value;
		if ( Vertical ) o["vertical"] = true;
		if ( ShowValue ) o["showValue"] = true;
	}
}

/// <summary>Text entry. Sends Submit with Value. Locks after sending unless KeepOpen.</summary>
public sealed class PadTextInput : PadElement
{
	public override string Type => "textinput";
	public string Label { get; set; }
	public string Placeholder { get; set; }
	public int? MaxLength { get; set; }
	public bool Multiline { get; set; }
	public int? Rows { get; set; }
	public string Value { get; set; }
	public string SubmitLabel { get; set; }
	public bool KeepOpen { get; set; }
	public bool AllowEmpty { get; set; }

	protected override void Write( JsonObject o )
	{
		PadJson.Set( o, "label", Label );
		PadJson.Set( o, "placeholder", Placeholder );
		if ( MaxLength.HasValue ) o["maxLength"] = MaxLength.Value;
		if ( Multiline ) o["multiline"] = true;
		if ( Rows.HasValue ) o["rows"] = Rows.Value;
		PadJson.Set( o, "value", Value );
		PadJson.Set( o, "submitLabel", SubmitLabel );
		if ( KeepOpen ) o["keepOpen"] = true;
		if ( AllowEmpty ) o["allowEmpty"] = true;
	}
}

/// <summary>Number entry with a numeric keypad. Sends Submit with <see cref="PadInput.Number"/>.</summary>
public sealed class PadNumberInput : PadElement
{
	public override string Type => "number";
	public string Label { get; set; }
	public string Placeholder { get; set; }
	public double? Min { get; set; }
	public double? Max { get; set; }
	public bool Decimals { get; set; }
	public string SubmitLabel { get; set; }
	public bool KeepOpen { get; set; }

	protected override void Write( JsonObject o )
	{
		PadJson.Set( o, "label", Label );
		PadJson.Set( o, "placeholder", Placeholder );
		if ( Min.HasValue ) o["min"] = Min.Value;
		if ( Max.HasValue ) o["max"] = Max.Value;
		if ( Decimals ) o["decimals"] = true;
		PadJson.Set( o, "submitLabel", SubmitLabel );
		if ( KeepOpen ) o["keepOpen"] = true;
	}
}

public sealed class PadOption
{
	public string Value { get; set; }
	public string Label { get; set; }
	public string Icon { get; set; }
	public string Color { get; set; }
	public string Image { get; set; }

	public PadOption() { }
	public PadOption( string value, string label = null, string color = null )
	{
		Value = value;
		Label = label;
		Color = color;
	}

	public JsonObject ToJson()
	{
		var o = new JsonObject { ["value"] = Value };
		PadJson.Set( o, "label", Label );
		PadJson.Set( o, "icon", Icon );
		PadJson.Set( o, "color", Color );
		PadJson.Set( o, "image", Image );
		return o;
	}
}

/// <summary>
/// A list of options. Tapping one sends Submit with Value immediately. With Multi, players toggle
/// options and press the submit button, which sends Submit with <see cref="PadInput.Values"/>.
/// </summary>
public sealed class PadChoice : PadElement
{
	public override string Type => "choice";
	public List<PadOption> Options { get; set; } = new();
	public int? Columns { get; set; }
	public bool Multi { get; set; }
	public string SubmitLabel { get; set; }
	/// <summary>Let players change their answer (sends Submit again).</summary>
	public bool KeepOpen { get; set; }

	protected override void Write( JsonObject o )
	{
		var arr = new JsonArray();
		foreach ( var opt in Options ) arr.Add( opt.ToJson() );
		o["options"] = arr;
		if ( Columns.HasValue ) o["columns"] = Columns.Value;
		if ( Multi ) o["multi"] = true;
		PadJson.Set( o, "submitLabel", SubmitLabel );
		if ( KeepOpen ) o["keepOpen"] = true;
	}
}

/// <summary>A drawing canvas. Sends Submit with Value = a PNG data URL ("data:image/png;base64,...").</summary>
public sealed class PadDrawing : PadElement
{
	public override string Type => "drawing";
	public int Width { get; set; } = 320;
	public int Height { get; set; } = 240;
	/// <summary>Palette as CSS colours. The background colour acts as the eraser.</summary>
	public string[] Colors { get; set; }
	public string Background { get; set; }
	public string SubmitLabel { get; set; }

	protected override void Write( JsonObject o )
	{
		o["width"] = Width;
		o["height"] = Height;
		if ( Colors != null ) o["colors"] = PadJson.ToNode( Colors );
		PadJson.Set( o, "background", Background );
		PadJson.Set( o, "submitLabel", SubmitLabel );
	}
}

/// <summary>
/// A control type defined by a theme script (see docs/theming.md). Put its settings in
/// <see cref="PadElement.Extra"/>.
/// </summary>
public sealed class PadCustom : PadElement
{
	private readonly string _type;
	public override string Type => _type;

	public PadCustom( string type, Dictionary<string, object> props = null )
	{
		_type = type;
		Extra = props ?? new Dictionary<string, object>();
	}

	protected override void Write( JsonObject o ) { }
}

/// <summary>Shorthand factories so screens read like a layout: <c>Pad.Button("jump", "JUMP")</c>.</summary>
public static class Pad
{
	public static PadText Text( string text, string size = null ) => new() { Text = text, Size = size };
	public static PadImage Image( string src ) => new() { Src = src };
	public static PadProgress Progress( string id, float value = 0, string label = null ) => new() { Id = id, Value = value, Label = label };
	public static PadSpacer Spacer( float flex = 1 ) => new() { Flex = flex };
	public static PadRow Row( params PadElement[] children ) => new( children );
	public static PadColumn Column( params PadElement[] children ) => new( children );

	public static PadButton Button( string id, string label, string color = null ) => new() { Id = id, Label = label, Color = color };
	public static PadDpad Dpad( string id = "dpad" ) => new() { Id = id };
	public static PadJoystick Joystick( string id = "stick" ) => new() { Id = id };
	public static PadTouchpad Touchpad( string id = "touch", string label = null ) => new() { Id = id, Label = label };
	public static PadSwipe Swipe( string id = "swipe", string label = null ) => new() { Id = id, Label = label };
	public static PadSlider Slider( string id, float min = 0, float max = 1, float? step = null ) => new() { Id = id, Min = min, Max = max, Step = step };
	public static PadTextInput TextInput( string id, string label = null, int maxLength = 40 ) => new() { Id = id, Label = label, MaxLength = maxLength };
	public static PadNumberInput Number( string id, string label = null ) => new() { Id = id, Label = label };
	public static PadDrawing Drawing( string id = "drawing", int width = 320, int height = 240 ) => new() { Id = id, Width = width, Height = height };

	public static PadChoice Choice( string id, params PadOption[] options ) => new() { Id = id, Options = options.ToList() };

	/// <summary>Choice from plain strings: each string is both value and label.</summary>
	public static PadChoice Choice( string id, params string[] options ) => new() { Id = id, Options = options.Select( s => new PadOption( s, s ) ).ToList() };

	/// <summary>2-4 big buttons in a grid, ids are the labels lower-cased unless you pass options.</summary>
	public static PadElement Buttons( params PadButton[] buttons )
	{
		if ( buttons.Length <= 2 ) return new PadRow( buttons );
		var half = (buttons.Length + 1) / 2;
		return new PadColumn( new PadRow( buttons.Take( half ).ToArray() ), new PadRow( buttons.Skip( half ).ToArray() ) );
	}
}

internal static class PadJson
{
	public static readonly JsonSerializerOptions Options = new()
	{
		PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		DictionaryKeyPolicy = null,
	};

	public static void Set( JsonObject o, string key, string value )
	{
		if ( value != null ) o[key] = value;
	}

	public static JsonArray Array( IEnumerable<PadElement> elements )
	{
		var arr = new JsonArray();
		if ( elements == null ) return arr;
		foreach ( var e in elements )
			if ( e != null ) arr.Add( e.ToJson() );
		return arr;
	}

	/// <summary>Turn any value (string, number, dictionary, anonymous object, element, screen) into JSON.</summary>
	public static JsonNode ToNode( object value )
	{
		return value switch
		{
			null => null,
			JsonNode n => n.DeepClone(),
			PadElement e => e.ToJson(),
			PadScreen s => s.ToJson(),
			string s => JsonValue.Create( s ),
			bool b => JsonValue.Create( b ),
			int i => JsonValue.Create( i ),
			long l => JsonValue.Create( l ),
			float f => JsonValue.Create( f ),
			double d => JsonValue.Create( d ),
			_ => JsonSerializer.SerializeToNode( value, value.GetType(), Options ),
		};
	}
}
