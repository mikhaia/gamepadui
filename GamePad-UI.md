# GamePad UI

## Idea

**GamePad UI** is a lightweight fullscreen launcher focused on gamepad-first navigation.

The main goal is to provide a clean and comfortable interface for launching games and other files on Windows using a gamepad, while still supporting keyboard and mouse.

The project is primarily built for personal use.

## Main Screens

### Favorites

Shows manually selected favorite games and applications.

- Large cover cards
- Launch with `A`
- Open actions/options with `X`
- Navigate with D-Pad or Left Stick

### Library

Contains games and applications manually added by the user.

Items may store:

- Name
- Executable or shortcut path
- Cover image
- Optional launch arguments
- Favorite status

### Explorer

Simple file browser for navigating folders and selecting files.

Expected support:

- Browse folders
- See files and `.lnk` shortcuts
- Add an executable or shortcut to Library
- Add selected item directly to Favorites

Nothing should be added automatically.

### Search

Search for files inside folders explicitly configured by the user.

Example search locations:

```text
D:\Games
D:\Emulators
C:\Users\User\Desktop
```

Search results can then be manually added to Library or Favorites.

## System Menu

The system menu opens with the **Select / View** button and appears as an overlay or side panel.

Items:

- Settings
- Sleep
- Power off
- Restart

`Power off` and `Restart` should require confirmation.

## Controls

Suggested default Xbox-style layout:

```text
D-Pad / Left Stick  Navigate
A                   Select / Launch
B                   Back
X                   Options / Actions
Y                   Search
LB / RB             Change section
Select / View       System menu
```

Keyboard and mouse should remain available as alternative input methods.

## Home UI

Suggested main navigation:

```text
GamePad UI                                  22:40
                                      Wednesday, August 19

Favorites      Library      Explorer      Search

[ GAME ]       [ GAME ]      [ GAME ]      [ GAME ]
   ▲

A Launch      X Options      Y Search      ☰ Menu
```

The application should be designed for fullscreen use and readable from a distance.

## Appearance

Customization ideas:

- Custom background image
- Background dim / blur
- Large digital clock
- Date display
- Game cover images
- Selected-card animation
- Optional idle / clock screen

## Neutralino

Neutralino is suitable because the project can remain mostly HTML, CSS and JavaScript without requiring Rust.

Useful capabilities:

- Read directories
- Read and write local files
- Launch executables
- Execute system commands
- Handle keyboard input
- Use the browser Gamepad API where supported
- Build lightweight desktop applications

## Platform Goals

### Windows

Primary platform.

Expected features:

- Keyboard
- Mouse
- Gamepad
- `.exe` launching
- `.lnk` shortcuts
- Sleep / restart / shutdown
- Startup with Windows

### Steam Deck / SteamOS

Secondary target.

Main focus:

- Gamepad navigation
- Xbox-style button layout
- Launching applications

Gamepad support should be tested early because Neutralino relies on the system WebView.

### macOS

Optional support.

Main focus:

- Keyboard / mouse navigation
- File browsing
- Application launching

Gamepad support is not required initially.

## Suggested First Version

Keep the first version small:

1. Fullscreen UI
2. Favorites screen
3. Gamepad navigation
4. Add application manually
5. Launch application
6. Explorer
7. Persistent Library
8. Custom background
9. Clock
10. System menu

After that:

- Search folders
- Shortcut parsing
- Cover management
- Autostart
- Steam Deck support
- Additional themes
