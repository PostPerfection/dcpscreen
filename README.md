# DCP Screen

DCP Screen plays DCPs from a library of folders, with the KDM for an encrypted composition picked from a store of KDMs. It is a thin Tauri app over postkit and guikit, and verifies packages with dcpdoctor.

## Build

Linux only for now. The submodules come first:

```bash
git submodule update --init --recursive
```

Grok (libgrokj2k), FFmpeg and libmpv must be discoverable by pkg-config at build time, as for the wizards:

```bash
export PKG_CONFIG_PATH="/path/to/ffmpeg-mpv/lib/pkgconfig:/path/to/grok/lib64/pkgconfig:$PKG_CONFIG_PATH"
export LD_LIBRARY_PATH=/path/to/grok/lib64

cd gui
pnpm install
pnpm build
pnpm test

cd src-tauri
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt -- --check
```

`pnpm tauri build --no-bundle` builds the release binary at `gui/src-tauri/target/release/dcpscreen-gui`.

## Run

```bash
export LD_LIBRARY_PATH=/path/to/grok/lib64
export GRK_PLUGIN_PATH=/path/to/grok/lib64
./gui/src-tauri/target/debug/dcpscreen-gui
```

Play opens the player as a normal window. Full screen goes to the display named in Settings, or to the main window's display when none is named or it is not connected.

grok looks for `libgrokj2k_plugin` in the directory `GRK_PLUGIN_PATH` names, then in the working directory, then in the executable's own directory, and never on `LD_LIBRARY_PATH`. Without the plugin the player decodes on the CPU. `GRK_NO_PLUGIN=1` keeps grok on the CPU even when the plugin is found.

Settings are kept in `~/.config/dcpscreen/settings.json`. The library (`library.json`), the KDM store (`kdms/`), the playlists (`playlists/<name>.json`) and the verify jobs (`jobs.jsonl`) are kept in `~/.local/share/dcpscreen`. `XDG_CONFIG_HOME` and `XDG_DATA_HOME` move them, and `DCPSCREEN_JOBS_FILE` names a jobs file of its own. The library is refreshed from the folders in Settings at startup and prints what it found as `[library] refresh: ...` on stdout.

## Playlists

A playlist runs compositions and intermissions in order. A composition that follows another composition plays straight on with no black frame between them. An intermission stops the picture and holds black or its still image for its length. A row with a start time waits on black until that local time when the row before ends earlier, and starts late, with a warning on the Playlist view, when the row before ends after it. The KDM for an encrypted composition is picked from the store when the row loads. Playing a composition from the library, Stop or closing the player window ends the playlist. The log lines start with `[playlist]`.

## Settings lock

Settings has "Lock settings with a password", with a minimum of 8 characters. While a password is set and the session is locked, saving settings, adding or removing a KDM and removing a package from the library are refused, while playing, verifying and browsing stay open. The lock keeps projectionists from changing settings in the app. It does not protect against anyone who can edit the user's files.

The password is stored as an Argon2id hash under `settingsPasswordHash` in `settings.json`. To remove a forgotten password, quit DCP Screen and delete that entry from the file, with the comma that ends the line above it.
