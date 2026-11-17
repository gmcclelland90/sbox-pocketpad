# PocketPad Playground

A tiny s&box game showing the PocketPad library. Everyone who joins drives a cube around. Press 1 to 6
on the keyboard to switch every phone to a different controller:

1. Gamepad: joystick, round JUMP button, "New colour" button
2. D-pad with a jump button
3. Mash meter with a 10 second timer and live progress updates
4. Quiz with instant right/wrong feedback
5. Drawing canvas
6. Tilt to roll, shake to jump

The HUD shows the room code, a QR code and each player's last input.

## Run it

1. Start a server: `docker compose up -d` from the repo root, or `cd server && npm install && npm start`.
2. Copy the library in: `powershell -ExecutionPolicy Bypass -File ..\..\tools\install-library.ps1 -Project .`
3. Open `playground.sbproj` in the s&box editor and press Play.
4. On a phone on the same Wi-Fi, scan the QR code or open the address shown, enter the code and a name.

The **PocketPad** object in the scene holds the `PadHost` (server URL, theme, max players) and
`PlaygroundGame`. Try setting Theme to `paper` or `neon`.

Code to read: [`Code/PlaygroundGame.cs`](Code/PlaygroundGame.cs) (`ShowMode` builds each phone screen,
`OnInput` handles events, `OnUpdate` polls sticks), and [`Code/PlaygroundHud.razor`](Code/PlaygroundHud.razor).
