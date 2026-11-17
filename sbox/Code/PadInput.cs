using System.Diagnostics;

namespace PocketPad;

public enum PadInputKind
{
	/// <summary>A button or d-pad direction was pressed, or a stick/touchpad was touched.</summary>
	Down,
	/// <summary>Released. Buttons include <see cref="PadInput.HeldSeconds"/>; sticks report 0,0.</summary>
	Up,
	/// <summary>Joystick or touchpad position changed.</summary>
	Move,
	/// <summary>Quick touch on a swipe area.</summary>
	Tap,
	/// <summary>Swipe with direction in Key and velocity in X/Y.</summary>
	Swipe,
	/// <summary>Slider moving, or multi-choice toggled with live updates.</summary>
	Change,
	/// <summary>Slider released at its final value.</summary>
	Set,
	/// <summary>Text, number, choice or drawing sent.</summary>
	Submit,
	/// <summary>Phone tilt (element "$tilt"), X/Y in -1..1.</summary>
	Tilt,
	/// <summary>Phone shaken (element "$shake").</summary>
	Shake,
	/// <summary>Anything else, e.g. from a custom element. See <see cref="PadInput.Event"/>.</summary>
	Other,
}

/// <summary>One input event from a phone.</summary>
public readonly struct PadInput
{
	public PadPlayer Player { get; init; }

	/// <summary>The id of the element that sent it ("$tilt"/"$shake" for sensors).</summary>
	public string Element { get; init; }

	public PadInputKind Kind { get; init; }

	/// <summary>The raw event name from the phone ("down", "move", "submit", ...).</summary>
	public string Event { get; init; }

	/// <summary>Direction for d-pads and swipes, or a button's Key.</summary>
	public string Key { get; init; }

	public float X { get; init; }
	public float Y { get; init; }

	/// <summary>Text, choice value, drawing data URL, or a number as text.</summary>
	public string Value { get; init; }

	/// <summary>Numeric value for sliders and number entry.</summary>
	public double? Number { get; init; }

	/// <summary>Picked values for multi-choice.</summary>
	public string[] Values { get; init; }

	/// <summary>How long a button was held, on <see cref="PadInputKind.Up"/>.</summary>
	public float HeldSeconds { get; init; }

	/// <summary>Per-player sequence number from the server.</summary>
	public long Sequence { get; init; }

	/// <summary><see cref="PadClock.Now"/> when the message arrived from the server, before frame queuing.</summary>
	public double ReceivedAt { get; init; }

	public Vector2 Vector => new( X, Y );

	public bool Is( string element ) => string.Equals( Element, element, StringComparison.OrdinalIgnoreCase );
	public bool Is( string element, PadInputKind kind ) => Kind == kind && Is( element );

	public override string ToString() => $"{Player?.Name} {Element} {Event}{(Key != null ? " " + Key : "")}{(X != 0 || Y != 0 ? $" ({X:0.##},{Y:0.##})" : "")}{(Value != null ? " " + (Value.Length > 40 ? Value[..40] + "..." : Value) : "")}";

	internal static PadInputKind KindOf( string ev ) => ev switch
	{
		"down" => PadInputKind.Down,
		"up" => PadInputKind.Up,
		"move" => PadInputKind.Move,
		"tap" => PadInputKind.Tap,
		"swipe" => PadInputKind.Swipe,
		"change" => PadInputKind.Change,
		"set" => PadInputKind.Set,
		"submit" => PadInputKind.Submit,
		"tilt" => PadInputKind.Tilt,
		"shake" => PadInputKind.Shake,
		_ => PadInputKind.Other,
	};
}

/// <summary>A monotonic clock in seconds, for timing reactions fairly across players.</summary>
public static class PadClock
{
	private static readonly long Start = Stopwatch.GetTimestamp();
	public static double Now => (Stopwatch.GetTimestamp() - Start) / (double)Stopwatch.Frequency;
}
